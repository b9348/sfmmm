use std::fs;
use std::path::PathBuf;

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::fs_util::{format_local_time, path_to_string, sha256_hex_file};

// ─────────────────────────── 存档管理 ───────────────────────────
// 存档目录固定位于系统用户目录下：
//   C:\Users\<用户名>\AppData\LocalLow\SheableSoft\SecretFlasherManaka\SaveData
// 目录内文件约定：
//   - 0-x.sd（x 为数字）: 游戏存档文件
//   - s.sd              : 游戏设置文件
//   - <任意>.sd.bak     : 存档备份文件（由本应用备份生成）

fn save_data_dir() -> Result<PathBuf, String> {
    let profile = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法获取用户目录（USERPROFILE/HOME）".to_string())?;
    Ok(PathBuf::from(profile)
        .join("AppData")
        .join("LocalLow")
        .join("SheableSoft")
        .join("SecretFlasherManaka")
        .join("SaveData"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileInfo {
    name: String,
    path: String,
    size: u64,
    /// 最后修改时间，格式 yyyy-MM-dd HH:mm:ss（本地时区）
    modified: String,
    /// save=存档文件(0-x.sd) / settings=设置文件(s.sd) / backup=备份文件(*.sd.bak)
    kind: String,
}

/// 读取文件的大小 / 修改时间 / SHA-256，构成备份校验指纹。
fn file_fingerprint(path: &PathBuf) -> Result<(u64, String, String), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("读取文件信息失败: {}", e))?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .map(format_local_time)
        .unwrap_or_default();
    let hash = sha256_hex_file(path)?;
    Ok((size, modified, hash))
}

/// 返回存档目录绝对路径（供前端"打开文件夹"使用）。
#[tauri::command]
pub fn get_save_dir() -> Result<String, String> {
    save_data_dir().map(|p| path_to_string(p))
}

/// 列出存档目录下的存档文件与备份文件。
/// 目录不存在时视为“没有存档”，返回空列表（不报错，方便首次运行展示空态）。
#[tauri::command]
pub fn list_save_files() -> Result<Vec<SaveFileInfo>, String> {
    let dir = save_data_dir()?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取存档目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取存档条目失败: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // 只关心 .sd 存档/设置文件 与 .sd.bak 备份文件
        let lower = name.to_lowercase();
        let kind = if lower.ends_with(".sd.bak") {
            "backup"
        } else if lower.ends_with(".sd") {
            if lower == "s.sd" {
                "settings"
            } else {
                "save"
            }
        } else {
            continue;
        };

        let metadata = entry.metadata().map_err(|e| format!("读取文件信息失败: {}", e))?;
        files.push(SaveFileInfo {
            name,
            path: path_to_string(path),
            size: metadata.len(),
            modified: metadata
                .modified()
                .map(format_local_time)
                .unwrap_or_else(|_| String::new()),
            kind: kind.into(),
        });
    }

    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

/// 备份存档：将 {name}.sd 复制为 {name}.sd.bak。
/// 若备份文件已存在则报错（前端 toast 提示），避免静默覆盖已有备份。
/// 备份成功后把备份文件的大小/修改时间/SHA-256 写入 save_backups 表，
/// 还原时逐项比对一致才允许还原（防止备份被篡改/损坏后误还原）。
#[tauri::command]
pub fn backup_save_file(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = save_data_dir()?;
    let src = dir.join(&name);
    if !src.is_file() {
        return Err(format!("存档文件不存在: {}", name));
    }
    let backup_name = format!("{}.bak", name);
    let dst = dir.join(&backup_name);
    if dst.exists() {
        return Err(format!("备份文件已存在: {}", backup_name));
    }
    fs::copy(&src, &dst).map_err(|e| format!("备份失败: {}", e))?;

    // 录入备份文件指纹（注意：以复制出的 .bak 文件本身为准，还原时比对的是它）
    // 指纹读取或记录写入失败时，删除刚复制的 .bak，避免留下无校验记录的残留备份
    // （残留备份既无法还原，又会因“备份文件已存在”阻塞重新备份）。
    let result = (|| -> Result<(), String> {
        let (size, modified, hash) = file_fingerprint(&dst)?;
        let conn = crate::db::subscribe::open_sqlite(&app)?;
        conn.execute(
            "INSERT INTO save_backups (backup_name, src_name, size, modified, hash)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(backup_name) DO UPDATE SET src_name = ?2, size = ?3, modified = ?4, hash = ?5",
            rusqlite::params![backup_name, name, size as i64, modified, hash],
        )
        .map_err(|e| format!("写入备份校验记录失败: {}", e))?;
        Ok(())
    })();

    if let Err(e) = result {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }

    Ok(())
}

/// 还原备份：将 {name}.sd.bak 复制回 {name}.sd。
/// 校验规则：
///   - 备份文件的大小/修改时间/SHA-256 与备份时录入 save_backups 的记录
///     逐一比对，任何一项不一致（备份被篡改/损坏/无记录）都拒绝还原；
///   - 指纹校验通过后，若目标存档已存在：
///       overwrite=false → 返回带 `CONFLICT:` 前缀的错误码（前端弹窗询问用户）；
///       overwrite=true  → 直接覆盖还原。
#[tauri::command]
pub fn restore_save_file(app: tauri::AppHandle, name: String, overwrite: bool) -> Result<(), String> {
    if !name.to_lowercase().ends_with(".sd.bak") {
        return Err(format!("不是备份文件: {}", name));
    }
    let dir = save_data_dir()?;
    let src = dir.join(&name);
    if !src.is_file() {
        return Err(format!("备份文件不存在: {}", name));
    }

    // 指纹校验：与备份时录入的记录逐项比对（size / modified / hash）
    let (cur_size, cur_modified, cur_hash) = file_fingerprint(&src)?;
    let conn = crate::db::subscribe::open_sqlite(&app)?;
    let record = conn
        .query_row(
            "SELECT size, modified, hash FROM save_backups WHERE backup_name = ?",
            rusqlite::params![name],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        )
        .optional()
        .map_err(|e| format!("读取备份校验记录失败: {}", e))?;

    let Some((rec_size, rec_modified, rec_hash)) = record else {
        return Err(format!("备份文件缺少校验记录，无法还原: {}", name));
    };

    if cur_size != rec_size as u64 || cur_modified != rec_modified || cur_hash != rec_hash {
        return Err(format!(
            "备份文件与备份时记录不一致（大小/时间/哈希校验未通过），可能已被修改或损坏，禁止还原: {}",
            name
        ));
    }

    // 去掉 .bak 后缀得到目标存档名（0-x.sd / s.sd）
    let target_name = name[..name.len() - 4].to_string();
    let dst = dir.join(&target_name);
    if dst.exists() && !overwrite {
        // 冲突错误码：前端据此弹窗询问是否覆盖，而不是直接 toast
        return Err(format!("CONFLICT:同名存档已存在，还原会产生命名冲突: {}", target_name));
    }

    // overwrite=true 或目标不存在时，直接复制（fs::copy 会覆盖已存在文件）
    fs::copy(&src, &dst).map_err(|e| format!("还原失败: {}", e))?;
    Ok(())
}

/// 重命名存档目录内的文件（存档 / 设置 / 备份均可）。
/// 校验：新文件名必须合法（非空、无路径分隔符）、且不与现有条目冲突。
/// 改名成功后同步更新 save_backups 表中的对应记录（backup_name / src_name），
/// 保证指纹校验记录始终指向当前文件名。
#[tauri::command]
pub fn rename_save_file(app: tauri::AppHandle, name: String, new_name: String) -> Result<(), String> {
    let dir = save_data_dir()?;
    let src = dir.join(&name);
    if !src.is_file() {
        return Err(format!("文件不存在: {}", name));
    }
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err("文件名不能为空".into());
    }
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains(':') {
        return Err("文件名包含非法字符".into());
    }
    if new_name.eq_ignore_ascii_case(&name) {
        return Ok(());
    }

    // 扩展名类别校验：备份（.sd.bak）与存档/设置（.sd）不能互相改名，
    // 否则会破坏文件名分类与 save_backups 记录的一致性。
    let name_lower = name.to_lowercase();
    let new_lower = new_name.to_lowercase();
    let is_backup = name_lower.ends_with(".sd.bak");
    if is_backup && !new_lower.ends_with(".sd.bak") {
        return Err("备份文件改名后必须以 .sd.bak 结尾".into());
    }
    if !is_backup && name_lower.ends_with(".sd") && !new_lower.ends_with(".sd") {
        return Err("存档/设置文件改名后必须以 .sd 结尾".into());
    }

    let dst = dir.join(&new_name);
    if dst.exists() {
        return Err(format!("同名文件已存在: {}", new_name));
    }

    // 改名存档/设置时，若有同名备份文件需一并重命名；目标备份名已存在时
    // 拒绝改名（避免静默覆盖其他存档的备份），并在主文件改名后同步移动备份。
    let src_backup = dir.join(format!("{}.bak", name));
    let dst_backup = dir.join(format!("{}.bak", new_name));
    let has_backup = !is_backup && src_backup.exists();
    if has_backup && dst_backup.exists() {
        return Err(format!("同名备份文件已存在: {}", new_name));
    }

    fs::rename(&src, &dst).map_err(|e| format!("重命名失败: {}", e))?;
    if has_backup {
        fs::rename(&src_backup, &dst_backup).map_err(|e| format!("重命名备份文件失败: {}", e))?;
    }

    // 同步更新 save_backups 记录：
    //   - 改的是备份文件（xx.sd.bak → yy.sd.bak）：backup_name 与 src_name 都平移后缀；
    //   - 改的是存档/设置（xx.sd → yy.sd）：src_name 平移，backup_name（xx.sd.bak）跟随。
    let conn = crate::db::subscribe::open_sqlite(&app)?;
    if is_backup {
        let new_src = &new_name[..new_name.len() - 4]; // 去掉 .bak 后缀（类别校验已保证存在）
        conn.execute(
            "UPDATE save_backups
             SET backup_name = ?2, src_name = ?3
             WHERE backup_name = ?1",
            rusqlite::params![name, new_name, new_src],
        )
        .map_err(|e| format!("更新备份校验记录失败: {}", e))?;
    } else {
        conn.execute(
            "UPDATE save_backups
             SET src_name = ?2, backup_name = ?3
             WHERE src_name = ?1",
            rusqlite::params![name, new_name, format!("{}.bak", new_name)],
        )
        .map_err(|e| format!("更新备份校验记录失败: {}", e))?;
    }

    Ok(())
}
