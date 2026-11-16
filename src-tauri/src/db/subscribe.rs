// 创意工坊订阅下载：把原来在前端 installMod.js 里执行的下载→解压→哈希→写库
// 全链路迁到 Rust 后台任务，使其不依赖前端组件生命周期——离开页面/切换标签
// 照常执行。任务状态持久化到 SQLite subscription_tasks 表，重启可恢复。
//
// 命令：db_subscribe_mod / db_list_subscription_tasks / db_cancel_subscription
//
// 进度通过 app_handle.emit("subscription-progress", …) 全局广播，前端任意页面
// listen 即可刷新；不依赖 invoke 的 Channel（Channel 与前端调用绑定，离开页面就断）。
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;
use serde_json;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek};
use tauri::Emitter;
use tauri::Manager;
use tokio::task::JoinHandle;
use zip::ZipArchive;

use crate::db::download::{DownloadProgress, PersistThrottle, ProgressFn, DEFAULT_DOWNLOAD_THREADS, DOWNLOAD_CONNECT_TIMEOUT, download_file};

// ── 全局任务句柄表（取消用）──────────────────────────────
// 用 once_cell + 函数封装而非 lazy_static 宏，避免宏展开在闭包里类型推断崩
use once_cell::sync::Lazy;
static TASK_HANDLES: Lazy<Arc<Mutex<HashMap<i64, JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn tasks() -> &'static Mutex<HashMap<i64, JoinHandle<()>>> {
    &TASK_HANDLES
}

/// 该任务在本进程内是否真的有后台任务在跑（有句柄 = 活着）
fn task_alive(id: i64) -> bool {
    if tasks().lock().map(|m| m.contains_key(&id)).unwrap_or(false) {
        return true;
    }
    // INSERT 与 spawn 之间的间隙：任务行已落库但句柄还没进表，
    // 登记在 PENDING_SPAWNS 里同样视为存活，防止并发调用把它误判为陈旧行
    PENDING_SPAWNS
        .lock()
        .map(|m| m.contains(&id))
        .unwrap_or(false)
}

/// 已写库但尚未 spawn 的任务号（closing INSERT→spawn 间隙的竞态）
static PENDING_SPAWNS: Lazy<Arc<Mutex<std::collections::HashSet<i64>>>> =
    Lazy::new(|| Arc::new(Mutex::new(std::collections::HashSet::new())));

// ── 取消标志表（取消下载用）──────────────────────────────────
// 与 installer.rs 同款：abort 只能停掉顶层 future 的 await 点，配合标志让
// 下载循环/各阶段检查点尽快退出并清理半成品文件。db_cancel_subscription 置位，
// 任务结束时由 spawn 包装清理，避免表无限增长。
static CANCEL_FLAGS: Lazy<Arc<Mutex<HashMap<i64, Arc<std::sync::atomic::AtomicBool>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn cancel_flags() -> &'static Mutex<HashMap<i64, Arc<std::sync::atomic::AtomicBool>>> {
    &CANCEL_FLAGS
}

/// 将残留运行态行重置为 failed（进程重启后无人接管的下载）。
/// 不删除：订阅记录页需要展示失败原因，用户可点重试。
fn reset_stale_task(conn: &Connection, id: i64) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE subscription_tasks
         SET status = 'failed', percent = 0, stage = 'interrupted',
             error = '上次下载被中断（应用退出），请重新订阅下载', updated_at = ?, finished_at = ?
         WHERE id = ?",
        rusqlite::params![now, now, id],
    )
    .map_err(|e| format!("重置陈旧任务失败: {e}"))?;
    Ok(())
}

/// 清理上次进程崩溃/被强杀残留的订阅临时包。
///
/// 临时包名 `sfmmm_subscribe_{task_id}.zip` 落在系统 temp 目录，任务正常结束
/// （成功/失败/取消）都会删掉；只有进程被强杀时才会留下——重启后任务号从 1
/// 重新开始，这些文件永远不会再被引用，不清理就只会在 temp 里越积越多。
///
/// 只删"名字对得上且本进程没有对应活跃任务"的：本进程的 pending 任务刚写库还
/// 没建文件，任务号天然在 TASK_HANDLES 里，不会误删。
pub(crate) fn cleanup_stale_temp_zips() {
    let temp_dir = std::env::temp_dir();
    let Ok(entries) = fs::read_dir(&temp_dir) else { return };
    let alive: HashSet<i64> = tasks()
        .lock()
        .map(|m| m.keys().copied().collect())
        .unwrap_or_default();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(rest) = name.strip_prefix("sfmmm_subscribe_") else { continue };
        let Some(id_str) = rest.strip_suffix(".zip") else { continue };
        let Ok(id) = id_str.parse::<i64>() else { continue };
        if alive.contains(&id) {
            continue;
        }
        let _ = fs::remove_file(entry.path());
    }
}

/// 重置所有本进程无句柄接管的运行态行（pending/downloading/extracting/recording）。
fn reset_stale_running_tasks(conn: &Connection) {
    let stale_ids: Vec<i64> = conn
        .prepare(
            "SELECT id FROM subscription_tasks
             WHERE status IN ('pending', 'downloading', 'extracting', 'recording')",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get(0))
                .map(|rows| rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();
    for id in stale_ids {
        if !task_alive(id) {
            let _ = reset_stale_task(conn, id);
        }
    }
}

// ── SQLite 路径 ────────────────────────────────────────────
// tauri_plugin_sql 把 "sqlite:config.db" 解析到 app_data_dir 下（开发时为工作目录）。
// rusqlite 必须打开同一文件才能与前端 getDb() 共享 subscription_tasks 表。
pub(crate) fn config_db_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 开发时 plugin-sql 落盘到当前工作目录；生产时到 app_data_dir。
    // 优先用 app_data_dir，回退到 cwd，二者都试打开确认。
    if let Ok(dir) = app_handle.path().app_data_dir() {
        let p = dir.join("config.db");
        if p.exists() {
            return Ok(p);
        }
    }
    // 开发时工作目录（src-tauri/）下的 config.db
    if let Ok(cwd) = std::env::current_exe() {
        if let Some(exe_dir) = cwd.parent() {
            let p = exe_dir.join("config.db");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    std::env::current_dir()
        .map(|d| d.join("config.db"))
        .map_err(|e| format!("无法获取工作目录: {e}"))
}

pub(crate) fn open_sqlite(app_handle: &tauri::AppHandle) -> Result<Connection, String> {
    let path = config_db_path(app_handle)?;
    let conn = Connection::open(&path).map_err(|e| format!("打开 SQLite 失败: {e}"))?;
    // 强制 WAL：与前端 tauri_plugin_sql 并发读写不锁库（修订点 2）
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("设置 WAL 失败: {e}"))?;
    Ok(conn)
}

// ── 游戏目录读取（不依赖前端传参，后台任务自洽）──────────
pub(crate) fn read_game_path(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let conn = open_sqlite(app_handle)?;
    let path: String = conn
        .query_row(
            "SELECT value FROM config WHERE `key` = 'game_path'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取 game_path 失败: {e}"))?;
    if path.is_empty() {
        return Err("GAME_DIR_INVALID".into());
    }
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("GAME_DIR_INVALID".into());
    }
    let data_dir = p.join("SecretFlasherManaka_Data");
    if !data_dir.is_dir() {
        return Err("GAME_DIR_INVALID".into());
    }
    let data_file = data_dir.join("data.unity3d");
    let meta = data_file.metadata().map_err(|_| "GAME_DIR_INVALID".to_string())?;
    if !meta.is_file() {
        return Err("GAME_DIR_INVALID".into());
    }
    if meta.len() <= 2u64 * 1024 * 1024 * 1024 {
        return Err("GAME_DIR_INVALID".into());
    }
    Ok(path)
}

/// 校验安装记录指向的文件是否仍存在于指定游戏目录下。
///
/// install_manifest（subscribe.rs 中记录写回处）对每个 category 都存**相对该
/// category 目标根目录**的路径，与 uninstallMod（src/services/installMod.js）
/// 逐项删除时的拼接方式一致：
///   - v1        → <base>\CustomMissions      （manifest 项形如 "Warp_DowntownToPark.json"）
///   - v2        → <base>\CustomMissions2\<mod_key>
///   - dll       → <base>\BepInEx\plugins（manifest 项由解压端归一为 basename）
///   - composite → <base>（manifest 项是相对游戏根的全路径）
/// 返回 None 表示"已安装且文件确实在"，Some(原因) 表示判定为失效。
///
/// 只有 manifest 非空时才做逐项探测：老记录（该列引入前的数据）没有文件清单，
/// 无从判断，保持原有"记录在即视为已安装"的语义，避免把正常安装误判为失效
/// 而触发重复下载。
fn install_files_present(base: &str, mod_key: &str, category: &str, manifest: &str) -> Option<String> {
    let files: Vec<String> = match serde_json::from_str(manifest) {
        Ok(v) => v,
        // manifest 为空或非数组：无法探测，按已安装处理
        Err(_) => return None,
    };
    if files.is_empty() {
        return None;
    }
    let root = match category {
        "dll" => format!("{}\\BepInEx\\plugins", base),
        "v2" => format!("{}\\CustomMissions2\\{}", base, mod_key),
        // manifest 已是相对游戏根的全路径，target_dir 就是游戏根：直接拼，不能再收窄
        "composite" => base.to_string(),
        _ => format!("{}\\CustomMissions", base), // v1 及兜底
    };
    for f in &files {
        // 安装记录现在同时含目录条目（末尾 /），目录不参与「文件是否还在」判定
        if f.replace('\\', "/").ends_with('/') {
            continue;
        }
        // 与解压端同一套校验：盘符/UNC/`..` 等在这里就报出具体路径，
        // 避免历史 manifest 把 Path::join 引出游戏目录。
        let rel = match safe_zip_path(f) {
            Ok(v) => v,
            Err(e) => return Some(format!("安装记录包含非法路径（{f}）：{e}")),
        };
        let rel = rel.replace('/', "\\");
        // 防御性归一：dll 安装端会平铺到 plugins 根目录，历史 manifest
        // 若带了子目录也按 basename 还原，和实际落盘位置保持一致。
        let rel = if category == "dll" {
            rel.rsplit('\\').next().unwrap_or(&rel).to_string()
        } else {
            rel
        };
        let full = PathBuf::from(&root).join(&rel);
        if !full.is_file() {
            return Some(format!("目标文件不存在: {}", full.display()));
        }
    }
    None
}

/// 校验安装记录在**当前游戏目录**下是否仍然成立（详情页刷新已安装态用）。
/// 复用 install_files_present 的 category 路径规则，避免前后端各写一套。
/// 返回 true=文件都在（或空 manifest 无法探测），false=记录已失效。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_install_files_present(
    app_handle: tauri::AppHandle,
    mod_key: String,
    category: String,
    manifest: String,
) -> Result<bool, String> {
    let game_path = read_game_path(&app_handle)?;
    let base = game_path.trim_end_matches('\\');
    Ok(install_files_present(base, &mod_key, &category, &manifest).is_none())
}

// ── 安装覆盖 / 本地残留预检（下载前，零流量）──────────────────

/// manifest 条目规范化：目录条目、非法路径跳过；dll 部署会平铺到
/// BepInEx\plugins，按 basename 归一（与 extract_zip_recursive 的写出路径一致）。
/// 返回 (文件相对路径列表, 是否含无法预先展开的嵌套 zip, 非法路径列表)。
fn manifest_file_entries(manifest: &str, category: &str) -> (Vec<String>, bool, Vec<String>) {
    let files: Vec<String> = match serde_json::from_str(manifest) {
        Ok(v) => v,
        Err(_) => return (Vec::new(), false, Vec::new()),
    };
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut invalid: Vec<String> = Vec::new();
    let mut invalid_seen: HashSet<String> = HashSet::new();
    let mut has_nested_zip = false;
    for raw in files {
        let norm = raw.replace('\\', "/");
        if norm.is_empty() {
            continue;
        }
        // 目录条目（发布端以末尾 / 标记）不产生文件覆盖，但解压端同样会对它做
        // 路径校验（失败会中止整个安装），所以必须对去掉末尾 / 的路径跑一次，
        // 否则 `C:/evil/`、`../x/` 这类非法目录条目在预检里漏报，用户会下载到
        // 一半才失败。
        let is_dir = norm.ends_with('/');
        let target = if is_dir { norm.trim_end_matches('/') } else { norm.as_str() };
        if target.is_empty() {
            continue;
        }
        let stripped = match safe_zip_path(target) {
            Ok(v) => v,
            Err(e) => {
                // 预检只收集给前端提示；同一规范化路径重复出现时只报一次
                let key = target.trim_start_matches('/').to_lowercase();
                if invalid_seen.insert(key) {
                    invalid.push(e);
                }
                continue;
            }
        };
        if is_dir {
            continue; // 目录条目只做校验，不进文件列表
        }
        let entry = if category == "dll" {
            stripped.rsplit('/').next().unwrap_or(&stripped).to_string()
        } else {
            stripped.clone()
        };
        if entry.is_empty() {
            continue;
        }
        if entry.to_lowercase().ends_with(".zip") {
            has_nested_zip = true; // 嵌套 zip 在解压时递归展开，明细无法在下载前预判
        }
        let key = entry.replace('/', "\\").to_lowercase();
        if seen.insert(key) {
            out.push(entry);
        }
    }
    (out, has_nested_zip, invalid)
}

/// 某 manifest 条目安装后落到的完整路径（规则与 run_subscribe_task 一致）。
fn deployed_path(base: &str, category: &str, mod_key: &str, entry: &str) -> PathBuf {
    let rel = entry.replace('/', "\\");
    match category {
        "dll" => Path::new(base).join("BepInEx").join("plugins").join(rel),
        "v2" => Path::new(base).join("CustomMissions2").join(mod_key).join(rel),
        "composite" => Path::new(base).join(rel),
        _ => Path::new(base).join("CustomMissions").join(rel),
    }
}

/// 相对游戏根目录的展示路径（统一反斜杠）。
fn display_rel_path(base: &str, full: &Path) -> String {
    match full.strip_prefix(Path::new(base)) {
        Ok(rel) => rel.to_string_lossy().replace('/', "\\"),
        Err(_) => full.to_string_lossy().to_string(),
    }
}

/// 本地路径归一键：小写 + 反斜杠（Windows 路径大小写不敏感）。
fn path_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// 与云端 file_hashes 的 basename 键一致：取 basename 并转小写。
fn basename_lower(path: &str) -> String {
    let p = path.replace('\\', "/");
    p.rsplit('/').next().unwrap_or(&p).to_lowercase()
}

/// 清单里出现多次的 basename（同名不同目录）。
/// 这类条目在只有 basename 键的旧指纹表里无法证明对应关系，必须按「已变化」保守处理。
fn ambiguous_basenames(entries: &[String]) -> HashSet<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for entry in entries {
        *counts.entry(basename_lower(entry)).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .filter(|(_, n)| *n > 1)
        .map(|(k, _)| k)
        .collect()
}

/// 本地文件 SHA-256（小写十六进制），读取失败返回 None。
fn file_sha256(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).ok()?;
    Some(hex::encode(hasher.finalize()))
}

/// 冲突分组排序：其他 mod 优先，其次自身更新，最后非 mod 文件。
fn conflict_kind_rank(kind: &str) -> u8 {
    match kind {
        "other_mod" => 0,
        "self_update" => 1,
        _ => 2,
    }
}

fn index_manifest(
    index: &mut HashMap<String, Vec<(String, String)>>,
    names: &HashMap<String, String>,
    base: &str,
    mod_key: &str,
    category: &str,
    manifest: &str,
) {
    let (entries, _, _) = manifest_file_entries(manifest, category);
    let display = names
        .get(mod_key)
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| mod_key.to_string());
    for entry in entries {
        let full = deployed_path(base, category, mod_key, &entry);
        let owners = index.entry(path_key(&full)).or_default();
        if !owners.iter().any(|(k, _)| k.eq_ignore_ascii_case(mod_key)) {
            owners.push((mod_key.to_string(), display.clone()));
        }
    }
}

/// 已安装文件 → 归属 mod 索引：路径键 -> [(mod_key, 展示名)]。
/// 来源为本地安装记录：installed_workshop_mod_files 的逐语言 manifest，
/// 无逐语言行（旧数据）时回退 installed_workshop_mods 的 manifest。
fn build_owner_index(conn: &Connection, base: &str) -> HashMap<String, Vec<(String, String)>> {
    // 展示名取订阅任务里冗余存的最新一份，取不到就回落 mod_key
    let mut names: HashMap<String, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT mod_key, display_name FROM subscription_tasks WHERE display_name <> '' ORDER BY id ASC",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            for (mk, n) in rows.flatten() {
                names.insert(mk, n);
            }
        }
    }

    // mod 级记录：mod_key -> (category, manifest)
    let mut mods: HashMap<String, (String, String)> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT mod_key, category, manifest FROM installed_workshop_mods") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2).unwrap_or_default(),
            ))
        }) {
            for (mk, cat, man) in rows.flatten() {
                mods.insert(mk, (cat, man));
            }
        }
    }

    let mut index: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut covered: HashSet<String> = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT mod_key, manifest FROM installed_workshop_mod_files") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1).unwrap_or_default()))
        }) {
            for (mk, man) in rows.flatten() {
                if man.trim().is_empty() {
                    continue;
                }
                let category = mods.get(&mk).map(|(c, _)| c.as_str()).unwrap_or("v1");
                index_manifest(&mut index, &names, base, &mk, category, &man);
                covered.insert(mk);
            }
        }
    }
    for (mk, (category, man)) in &mods {
        if covered.contains(mk) || man.trim().is_empty() {
            continue;
        }
        index_manifest(&mut index, &names, base, mk, category, man);
    }
    index
}

/// 读取本次更新对应语言的旧安装 manifest。
/// 有逐语言记录时只看该语言（其它语言的文件不能算作本次语言的残留）；
/// 只有旧数据（无逐语言行）时才回退 mod 级 manifest。
fn load_installed_manifest(conn: &Connection, mod_key: &str, lang_code: &str) -> Option<String> {
    let has_lang_rows: i64 = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM installed_workshop_mod_files WHERE mod_key = ?)",
            rusqlite::params![mod_key],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_lang_rows > 0 {
        if lang_code.is_empty() {
            return None;
        }
        return conn
            .query_row(
                "SELECT manifest FROM installed_workshop_mod_files WHERE mod_key = ? AND lang_code = ?",
                rusqlite::params![mod_key, lang_code],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .filter(|m| !m.trim().is_empty());
    }
    conn.query_row(
        "SELECT manifest FROM installed_workshop_mods WHERE mod_key = ?",
        rusqlite::params![mod_key],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|m| !m.trim().is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverwriteConflict {
    path: String,
    owner: String,
    owner_name: String,
    kind: String,
}

/// 下载前预检：用新版本 manifest 与本地文件系统 / 安装记录比对，
/// 返回「将被覆盖的文件（含来源 mod）」与「本地残留文件（仅提示，不删除）」。
///
/// 覆盖判定：目标路径已存在。属于其他 mod / 非 mod 文件时必提示；
/// 属于本 mod 自身旧安装时，用云端逐文件指纹与本地 SHA-256 比对，
/// 内容一致视为幂等不提示，内容确实变了才列入。指纹优先按路径键取
/// （同名不同目录能区分）；旧格式只有 basename 键时回落按名比对，
/// 同名多条且缺路径键则无法证明一致，按「已变化」保守提示。
/// 残留判定：同语言旧 manifest 有、新 manifest 没有、磁盘上仍在，且未被其它
/// mod 或本 mod 其它语言占用。新版本含嵌套 zip 时，旧 manifest 记录的是解压后
/// 平铺的文件、新 manifest 只有 `.zip` 条目，未被新清单覆盖的条目可能就藏在
/// zip 内部，无法预判——这部分不计入 staleFiles，只置 staleUnknown=true，
/// 避免把旧包内部文件误报为残留；被新清单明确覆盖的条目照常不算残留。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_check_mod_overwrite(
    app_handle: tauri::AppHandle,
    mod_key: String,
    category: String,
    manifest: String,
    lang_code: Option<String>,
) -> Result<serde_json::Value, String> {
    let game_path = read_game_path(&app_handle)?;
    let base = game_path.trim_end_matches('\\').to_string();
    let (entries, has_nested_zip, invalid_paths) = manifest_file_entries(&manifest, &category);

    // 云端缺 manifest（老 mod 未回填）：无法在下载前判断，调用方按无冲突继续
    if entries.is_empty() {
        return Ok(serde_json::json!({
            "checked": false,
            "totalFiles": 0,
            "conflictCount": 0,
            "conflicts": [],
            "hasNestedZip": has_nested_zip,
            "invalidPaths": invalid_paths,
            "staleCount": 0,
            "staleFiles": [],
            "staleUnknown": false,
        }));
    }

    let lang = lang_code.unwrap_or_default();
    // 判断「自身旧文件内容是否真的变了」需要新版逐文件指纹：云端 file_hashes。
    // 新格式同时含 basename 键与路径键；旧格式只有 basename 键。
    // 同名不同目录的条目在旧格式里无法证明对应关系（Ambiguous），按「变了」处理。
    // 查询慢/失败/无语言时无法证明一致，按「无法判定」处理，
    // 不把本 mod 自身文件列为冲突（宁可少提醒一次，也不能把安装拖到前端超时）。
    let ambiguous = ambiguous_basenames(&entries);
    let cloud_hashes: Option<HashMap<String, String>> = if lang.is_empty() {
        None
    } else {
        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            crate::db::hash::fetch_cloud_file_hashes(&mod_key, &lang),
        )
        .await
        {
            Ok(Ok(raw)) => Some(crate::db::hash::parse_file_hashes_flat(raw)),
            Ok(Err(e)) => {
                log::warn!("[subscribe] 覆盖预检读取云端指纹失败，按无法判定继续: {e}");
                None
            }
            Err(_) => {
                log::warn!("[subscribe] 覆盖预检读取云端指纹超时，按无法判定继续");
                None
            }
        }
    };

    // SQLite 扫描与逐文件 SHA-256 都是阻塞操作，放到 blocking 线程执行，
    // 不占用 async 运行时；预检结果只用于提示，不阻断安装。
    let app = app_handle.clone();
    let base_for_scan = base.clone();
    let mod_key_for_scan = mod_key.clone();
    let category_for_scan = category.clone();
    let lang_for_scan = lang.clone();
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = open_sqlite(&app)?;
        let index = build_owner_index(&conn, &base_for_scan);
        // 当前 mod 的安装记录（category），冲突归类与残留判定共用
        let installed_category: Option<String> = conn
            .query_row(
                "SELECT category FROM installed_workshop_mods WHERE mod_key = ?",
                rusqlite::params![mod_key_for_scan],
                |r| r.get(0),
            )
            .ok();
        // 旧数据形态：只有 mod 级安装记录、没有逐语言清单，且 mod 级 manifest 为空
        // （旧版安装/记录未回填）。这种记录无法逐条判断归属。
        let legacy_no_manifest = if installed_category.is_some() {
            let has_lang_rows: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM installed_workshop_mod_files WHERE mod_key = ?)",
                    rusqlite::params![mod_key_for_scan],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let mod_manifest: String = conn
                .query_row(
                    "SELECT manifest FROM installed_workshop_mods WHERE mod_key = ?",
                    rusqlite::params![mod_key_for_scan],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            has_lang_rows == 0 && mod_manifest.trim().is_empty()
        } else {
            false
        };

        // 1) 将被覆盖
        let mut conflicts: Vec<OverwriteConflict> = Vec::new();
        for entry in &entries {
            let full = deployed_path(&base_for_scan, &category_for_scan, &mod_key_for_scan, entry);
            if !full.is_file() {
                continue;
            }
            let owners = index.get(&path_key(&full));
            let other = owners.and_then(|o| {
                o.iter()
                    .find(|(k, _)| !k.eq_ignore_ascii_case(&mod_key_for_scan))
            });
            let (owner, owner_name, kind) = match other {
                Some((k, n)) => (k.clone(), n.clone(), "other_mod".to_string()),
                None if owners.is_some() => {
                    // 本 mod 自身旧文件：内容一致＝幂等重装，不提示；不一致才需要确认。
                    // 云端指纹不可用（None）时无法证明一致，按幂等放行。
                    let same = match cloud_hashes.as_ref() {
                        Some(cloud) => {
                            let lookup = crate::db::hash::lookup_file_hash(
                                cloud,
                                entry,
                                ambiguous.contains(&basename_lower(entry)),
                            );
                            match lookup {
                                crate::db::hash::HashLookup::Hit(remote) => file_sha256(&full)
                                    .map(|local| local == remote)
                                    .unwrap_or(false),
                                // 同名不同目录且无路径键（旧格式）或云端无该项：无法证明一致
                                _ => false,
                            }
                        }
                        None => true,
                    };
                    if same {
                        continue;
                    }
                    (
                        mod_key_for_scan.clone(),
                        mod_key_for_scan.clone(),
                        "self_update".to_string(),
                    )
                }
                None if legacy_no_manifest => {
                    // 旧数据形态：有安装记录但清单为空（旧版安装/记录未回填），
                    // 无法逐条判断归属。同路径文件按本 mod 自身旧安装处理，直接
                    // 覆盖、不弹确认——此前会误报成「非 mod 安装的本机文件」，
                    // 每次更新都逼用户确认一遍。
                    continue;
                }
                None => (String::new(), String::new(), "user_file".to_string()),
            };
            conflicts.push(OverwriteConflict {
                path: display_rel_path(&base_for_scan, &full),
                owner,
                owner_name,
                kind,
            });
        }
        conflicts.sort_by(|a, b| {
            conflict_kind_rank(&a.kind)
                .cmp(&conflict_kind_rank(&b.kind))
                .then_with(|| a.owner_name.cmp(&b.owner_name))
                .then_with(|| a.path.cmp(&b.path))
        });

        // 2) 本地残留（只提示，不提供自动删除）
        let old_manifest = installed_category
            .as_ref()
            .and_then(|_| load_installed_manifest(&conn, &mod_key_for_scan, &lang_for_scan));
        let stale_unknown = old_manifest.is_some() && has_nested_zip;
        let mut stale: Vec<String> = Vec::new();
        // 含嵌套 zip 时，zip 内部文件无法在下载前枚举：旧清单里未被新清单覆盖的
        // 条目可能就在 zip 内部，归入「无法预判」（staleUnknown），不进 staleFiles，
        // 避免弹误导性的「本地残留」确认；被新清单覆盖的条目仍按正常规则排除。
        if let (Some(old_manifest), Some(old_category)) =
            (old_manifest.as_deref(), installed_category.as_deref())
        {
            let new_keys: HashSet<String> = entries
                .iter()
                .map(|e| path_key(&deployed_path(&base_for_scan, &category_for_scan, &mod_key_for_scan, e)))
                .collect();
            // 同 mod 其它语言仍在使用的路径（v2 多语言共用同一目录），不能算残留
            let mut other_lang_keys: HashSet<String> = HashSet::new();
            if let Ok(mut stmt) = conn
                .prepare("SELECT lang_code, manifest FROM installed_workshop_mod_files WHERE mod_key = ?")
            {
                if let Ok(rows) = stmt.query_map(rusqlite::params![mod_key_for_scan], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1).unwrap_or_default()))
                }) {
                    for (lc, man) in rows.flatten() {
                        if lc == lang_for_scan || man.trim().is_empty() {
                            continue;
                        }
                        for entry in manifest_file_entries(&man, old_category).0 {
                            other_lang_keys.insert(path_key(&deployed_path(
                                &base_for_scan,
                                old_category,
                                &mod_key_for_scan,
                                &entry,
                            )));
                        }
                    }
                }
            }
            for entry in manifest_file_entries(old_manifest, old_category).0 {
                let full = deployed_path(&base_for_scan, old_category, &mod_key_for_scan, &entry);
                if !full.is_file() {
                    continue; // 用户已手动删除，无需提示
                }
                let key = path_key(&full);
                if new_keys.contains(&key) || other_lang_keys.contains(&key) {
                    continue;
                }
                // 新包含嵌套 zip：未覆盖条目可能藏在 zip 内部，无法预判，
                // 归入 staleUnknown 而不是「本地残留」
                if has_nested_zip {
                    continue;
                }
                if let Some(owners) = index.get(&key) {
                    // 同时被其它 mod 占用：不能断言是本 mod 的残留（更不该建议删除）
                    if owners.iter().any(|(k, _)| !k.eq_ignore_ascii_case(&mod_key_for_scan)) {
                        continue;
                    }
                }
                stale.push(display_rel_path(&base_for_scan, &full));
            }
            stale.sort();
        }

        Ok(serde_json::json!({
            "checked": true,
            "totalFiles": entries.len(),
            "conflictCount": conflicts.len(),
            "conflicts": serde_json::to_value(&conflicts).unwrap_or_else(|_| serde_json::json!([])),
            "hasNestedZip": has_nested_zip,
            "invalidPaths": invalid_paths,
            "staleCount": stale.len(),
            "staleFiles": stale,
            "staleUnknown": stale_unknown,
        }))
    })
    .await
    .map_err(|e| format!("覆盖预检任务失败: {e}"))?
}

// ── 任务状态写回（每阶段更新 + 前端可查）─────────────────
fn update_task_status(
    app_handle: &tauri::AppHandle,
    task_id: i64,
    status: &str,
    percent: u32,
    stage: &str,
    error: Option<&str>,
    extras: &[(&str, &str)],
) -> Result<(), String> {
    let conn = open_sqlite(app_handle)?;
    let now = chrono::Utc::now().to_rfc3339();
    let finished = if status == "done" || status == "failed" || status == "cancelled" {
        Some(now.clone())
    } else {
        None
    };

    // 动态拼额外列（target_dir / manifest 等）
    let extra_cols: Vec<String> = extras.iter().map(|(k, _)| format!("`{}` = ?", k)).collect();
    let extra_sql = if extra_cols.is_empty() {
        String::new()
    } else {
        format!(", {}", extra_cols.join(", "))
    };

    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(status.to_string()),
        Box::new(percent as i64),
        Box::new(stage.to_string()),
        Box::new(error.map(|e| e.to_string()).unwrap_or_default()),
        Box::new(now),
    ];
    for (_, v) in extras {
        params.push(Box::new(v.to_string()));
    }
    params.push(Box::new(task_id));

    // finished_at 单独处理（NULL 时不覆盖）
    let err_opt = conn.execute(
        &format!(
            "UPDATE subscription_tasks SET status = ?, percent = ?, stage = ?, error = ?, updated_at = ?{} WHERE id = ?",
            extra_sql
        ),
        rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())),
    );
    if let Err(e) = err_opt {
        return Err(format!("更新任务状态失败: {e}"));
    }
    if let Some(ts) = finished {
        let _ = conn.execute(
            "UPDATE subscription_tasks SET finished_at = ? WHERE id = ?",
            rusqlite::params![ts, task_id],
        );
    }
    Ok(())
}

// ── zip slip 防护 ───────────────────────────────────────────
/// 校验 zip 条目 / manifest 路径，返回规范化（`/` 分隔、无前导分隔符）的相对路径。
/// 拒绝任何会让 `Path::join` 丢弃目标目录、或落到目标目录外的写法：
/// - Windows 盘符（`C:/`、`C:\`）及其它含冒号的名字（ADS / 非法文件名）
/// - `..` 段
/// - 剥掉段尾空格/点后等于 `..` 的段（Win32 会把 `.. `、`.. .` 等归一化成 `..`，
///   若不拦下则 `Path::join` 后可逃出目标目录）
/// 前导 `/`（含历史包里常见的 `/CustomMissions/x.json`）按规范化剥离，兼容旧包；
/// 剥离后为空、或仍为绝对/根相对路径的一律拒绝。错误信息带原始路径，便于定位
/// 是哪个已上架 mod 的 manifest / zip 条目有问题。
pub(crate) fn safe_zip_path(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("路径为空".into());
    }
    let norm = path.replace('\\', "/");
    // 历史数据里存在带前导斜杠的相对路径：统一剥离而不是拒绝，避免老包突然装不上。
    let norm = norm.trim_start_matches('/');
    if norm.is_empty() {
        return Err(format!("路径为空或只有根分隔符，已拒绝: {path}"));
    }
    // 冒号只允许出现在文件名中间？Windows 文件名不允许冒号；统一拒绝，
    // 同时覆盖 C: 盘符与 NTFS 数据流（name:stream）。
    if norm.contains(':') {
        return Err(format!("存在盘符或含冒号的路径，已拒绝: {path}"));
    }
    // Win32 会剥掉路径段尾的空格与点再解析（`.. ` -> `..`、`.. .` -> `..`），
    // 因此不能只做精确比较；只拦截解析后仍是 `..` 的段。
    // 注意：不能只写 trim_end_matches(|c| c == ' ' || c == '.') == ".."，
    // 那样纯 `..` 会被全部剥成空串而漏判；必须先只剥尾部空格判断精确的 `..`。
    // `.` / `...` 解析后是当前目录，仍在目标目录内，放行以兼容 `./` 开头的包。
    for seg in norm.split('/') {
        if seg.is_empty() {
            continue;
        }
        if seg.trim_end_matches(' ') == ".."
            || seg.trim_end_matches(|c| c == ' ' || c == '.') == ".."
        {
            return Err(format!("存在非法相对路径（..），已拒绝: {path}"));
        }
    }
    // 兜底：交给 std 判断（Windows 下 C:\ 等会被识别为绝对路径）
    let p = Path::new(&norm);
    if p.is_absolute() || p.has_root() {
        return Err(format!("存在绝对路径，已拒绝: {path}"));
    }
    Ok(norm.to_string())
}

// ── 递归解压（含嵌套 .zip，复刻前端 extractAll 语义）────────
struct ExtractOutcome {
    files: Vec<String>,     // 相对 target_dir 的部署清单（manifest 用）
    target_dir: String,     // composite 可能收窄
}

fn extract_zip_recursive(
    bytes: &[u8],
    target_dir: &str,
    category: &str,
    base: &str,
    plugins_dir: &str,
) -> Result<ExtractOutcome, String> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("读取 zip 失败: {e}"))?;

    let mut files: Vec<String> = Vec::new();
    let target = PathBuf::from(target_dir);

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip entry 失败: {e}"))?;
        let raw_name = entry.name().to_string();

        // 目录条目：创建并写入安装记录（dll 类平铺，跳过）。
        // v1 / composite 卸载按 manifest 逐项清理，只有空目录、没有文件的条目
        // 也必须进记录，否则卸载后空目录与父目录链会残留。
        if entry.is_dir() {
            if category == "dll" {
                continue;
            }
            let safe = safe_zip_path(raw_name.trim_end_matches('/'))?;
            let dir_path = target.join(safe.replace('/', std::path::MAIN_SEPARATOR_STR));
            let _ = fs::create_dir_all(&dir_path);
            // v1 / composite 卸载按记录逐项清理；v2 整目录删除，无需写目录条目
            if category == "v1" || category == "composite" {
                files.push(format!("{}/", safe.trim_end_matches('/')));
            }
            continue;
        }

        // 读出文件字节；不按条目声明的 size 直接预分配，避免恶意 zip 触发超大分配。
        let mut buf: Vec<u8> = Vec::with_capacity(entry.size().min(16 * 1024 * 1024) as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取 zip 内文件失败: {e}"))?;

        // 嵌套 zip：递归展开，不写出该 zip 本身
        if raw_name.to_lowercase().ends_with(".zip") {
            match extract_zip_recursive(&buf, target_dir, category, base, plugins_dir) {
                Ok(inner) => {
                    files.extend(inner.files);
                    continue;
                }
                Err(e) => {
                    log::warn!("[subscribe] 嵌套 zip 解析失败，按普通文件写出: {raw_name} -> {e}");
                }
            }
        }

        // 计算目标路径
        let (target_path, manifest_entry) = if category == "dll" {
            // 即使只取 basename，也要先过同一套校验：`C:\x.dll` 这类名字
            // 会被 Path::join 当成绝对路径而丢弃 plugins_dir。
            let safe = safe_zip_path(&raw_name)?;
            let file_name = safe
                .rsplit('/')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(&safe)
                .to_string();
            (PathBuf::from(plugins_dir).join(&file_name), file_name)
        } else {
            let safe = safe_zip_path(&raw_name)?;
            let normalized = safe.replace('/', std::path::MAIN_SEPARATOR_STR);
            let tp = target.join(&normalized);
            if let Some(parent) = tp.parent() {
                let _ = fs::create_dir_all(parent);
            }
            (tp, safe)
        };

        fs::write(&target_path, &buf).map_err(|e| format!("写出文件失败 {}: {e}", target_path.display()))?;
        files.push(manifest_entry);
    }

    // composite 类：从首个文件推断顶层目录，收窄 target_dir 供 open_folder。
    // 记录里可能混有目录条目（末尾 /），不能用目录推断，取首个文件条目。
    let mut final_target = target_dir.to_string();
    if let Some(first) = files.iter().find(|p| !p.ends_with('/')) {
        let segs: Vec<&str> = first.split('/').collect();
        if segs.len() > 1 {
            let top_dir_segs = &segs[..segs.len() - 1];
            final_target = format!("{}\\{}", base, top_dir_segs.join("\\"));
        }
    }

    Ok(ExtractOutcome {
        files,
        target_dir: final_target,
    })
}

// ── 逐文件 SHA-256（basename + 路径双键，回填云端）──────

/// 把嵌套 zip 条目落盘为临时文件再打开。ZipArchive 需要 `Read + Seek`，
/// 无法在 zip 内的条目上直接流式读取；旧实现整包 `read_to_end` 进内存，
/// 大包叠大嵌套 zip 时内存峰值翻倍，这里改为写临时文件、用完即删。
/// 嵌套 zip 损坏时返回 `Ok(None)`（与旧行为一致：忽略）。
pub(crate) fn with_nested_zip_archive<T>(
    entry: &mut dyn std::io::Read,
    f: impl FnOnce(&mut ZipArchive<std::fs::File>) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let tmp_path = std::env::temp_dir().join(format!(
        "sfmmm_nested_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let result = (|| -> Result<Option<T>, String> {
        {
            let mut file =
                std::fs::File::create(&tmp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;
            std::io::copy(entry, &mut file).map_err(|e| format!("落盘嵌套 zip 失败: {e}"))?;
        }
        match ZipArchive::new(std::fs::File::open(&tmp_path).map_err(|e| format!("打开临时文件失败: {e}"))?) {
            Ok(mut inner) => f(&mut inner).map(Some),
            Err(_) => Ok(None),
        }
    })();
    let _ = std::fs::remove_file(&tmp_path);
    result
}

/// 递归展开 zip（含嵌套 zip，最多 6 层）计算逐文件指纹。
/// 与上传端 `computeZipFileHashes` / `mod_edit.rs` 的 `hash_archive` 同一口径：
/// 条目路径先按类别归一为「安装根相对路径」，嵌套 zip 自身不参与指纹，只展开其中的文件。
/// 同时收集 basename 键（旧客户端按名查询）与路径键（区分同名不同目录）。
fn hash_zip_entries<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    category: &str,
    mod_key: &str,
    by_name: &mut HashMap<String, String>,
    by_path: &mut HashMap<String, String>,
    depth: u8,
) -> Result<(), String> {
    if depth > 6 {
        return Ok(());
    }
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip entry 失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if name.to_ascii_lowercase().ends_with(".zip") {
            crate::db::subscribe::with_nested_zip_archive(&mut entry, |inner| {
                hash_zip_entries(inner, category, mod_key, by_name, by_path, depth + 1)?;
                Ok(())
            })?;
            continue;
        }
        let mut hasher = Sha256::new();
        std::io::copy(&mut entry, &mut hasher)
            .map_err(|e| format!("读取 zip entry 内容失败: {e}"))?;
        let hash = hex::encode(hasher.finalize());
        // 路径归一必须与写包/manifest 口径一致（安装根相对路径），否则查询侧对不上
        let rel = crate::db::mod_edit::normalize_entry_path(category, mod_key, &name);
        if rel.is_empty() || rel.ends_with('/') {
            continue;
        }
        // 写入侧统一小写：Windows 文件名大小写不敏感，查询侧也按小写取键，
        // 避免 "Readme.txt" 与 "readme.txt" 被当成不同文件。
        let base = rel.rsplit('/').next().unwrap_or(&rel).to_lowercase();
        by_name.insert(base, hash.clone());
        by_path.insert(rel.to_lowercase(), hash);
    }
    Ok(())
}

/// 返回 (云端双键 JSON, 本地 basename-only JSON)。
/// 本地 `installed_workshop_mods.file_hashes` 只写历史口径：旧版本读这张表做预检，
/// 若看到路径键会误报「云端有、本地无」，因此不给它引入新格式。
fn compute_zip_file_hashes(
    bytes: &[u8],
    category: &str,
    mod_key: &str,
) -> Result<(String, String), String> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("读取 zip 失败: {e}"))?;
    let mut by_name: HashMap<String, String> = HashMap::new();
    let mut by_path: HashMap<String, String> = HashMap::new();
    hash_zip_entries(&mut archive, category, mod_key, &mut by_name, &mut by_path, 0)?;
    let merged = crate::db::hash::merge_file_hashes(&by_name, &by_path);
    let cloud = serde_json::to_string(&merged).map_err(|e| format!("序列化哈希失败: {e}"))?;
    let base_only = crate::db::hash::parse_file_hashes_opt(Some(cloud.clone()));
    let local = serde_json::to_string(&base_only).map_err(|e| format!("序列化哈希失败: {e}"))?;
    Ok((cloud, local))
}

// ── 安装记录写回（installed_workshop_mods / _mod_files）──
fn write_install_record(
    app_handle: &tauri::AppHandle,
    mod_key: &str,
    category: &str,
    version: &str,
    file_hash: &str,
    lang_code: &str,
    manifest: &str,
    file_hashes: Option<&str>,
) -> Result<(), String> {
    let conn = open_sqlite(app_handle)?;
    // mod 级记录（兼容旧表）
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM installed_workshop_mods WHERE mod_key = ?",
            rusqlite::params![mod_key],
            |r| r.get(0),
        )
        .ok();
    if existing.is_some() {
        conn.execute(
            "UPDATE installed_workshop_mods SET category = ?, installed_version = ?, file_hash = ?, lang_code = ?, manifest = ?, file_hashes = ? WHERE mod_key = ?",
            rusqlite::params![category, version, file_hash, lang_code, manifest, file_hashes.unwrap_or(""), mod_key],
        )
        .map_err(|e| format!("更新安装记录失败: {e}"))?;
    } else {
        conn.execute(
            "INSERT INTO installed_workshop_mods (mod_key, category, installed_version, file_hash, lang_code, manifest, file_hashes) VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![mod_key, category, version, file_hash, lang_code, manifest, file_hashes.unwrap_or("")],
        )
        .map_err(|e| format!("写入安装记录失败: {e}"))?;
    }
    // 按语言记录
    conn.execute(
        "INSERT INTO installed_workshop_mod_files (mod_key, lang_code, installed_version, file_hash, manifest)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(mod_key, lang_code) DO UPDATE SET
           installed_version = excluded.installed_version,
           file_hash = excluded.file_hash,
           manifest = excluded.manifest,
           installed_at = CURRENT_TIMESTAMP",
        rusqlite::params![mod_key, lang_code, version, file_hash, manifest],
    )
    .map_err(|e| format!("写入语言安装记录失败: {e}"))?;
    Ok(())
}

// ── 全局任务句柄表（取消用）──────────────────────────────
// TASK_HANDLES 见文件头部 once_cell 定义（tasks() 取引用）。

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionProgress {
    task_id: i64,
    mod_key: String,
    /// 该任务对应的语言。随每个事件下发，前端不必先查库就能把进度归到
    /// 哪个语言的按钮上（详情页离开再回来时，`lang → taskId` 映射早已丢失，
    /// 靠这个字段反查恢复）。
    lang_code: String,
    /// 冗余的显示名（工坊卡片名），悬浮下载条在任意页面展示用；空串时前端
    /// 回退到 mod_key
    display_name: String,
    percent: u32,
    stage: String,
    status: String,
    error: String,
    // 实时下载速度（字节/秒），仅 downloading 阶段有意义；其它阶段 emit 0
    speed: u64,
    // 安装根目录：仅 done 事件携带（composite 为解压后收窄的目录，其余为
    // 各自固定根），前端据此增量更新记录行；其余阶段保持 None，兼容旧消费者
    #[serde(skip_serializing_if = "Option::is_none")]
    target_dir: Option<String>,
}

impl SubscriptionProgress {
    /// 统一构造：绝大多数字段来自任务上下文，只有进度/状态逐次变化。
    /// 集中在这里是为了让 `lang_code` / `display_name` 的透出只在一个地方维护，
    /// 避免新增事件点忘了带语言、导致详情页恢复不到对应按钮。
    fn new(
        task_id: i64,
        mod_key: &str,
        lang_code: &str,
        display_name: &str,
        percent: u32,
        stage: &str,
        status: &str,
        error: &str,
        speed: u64,
    ) -> Self {
        Self {
            task_id,
            mod_key: mod_key.to_string(),
            lang_code: lang_code.to_string(),
            display_name: display_name.to_string(),
            percent,
            stage: stage.to_string(),
            status: status.to_string(),
            error: error.to_string(),
            speed,
            target_dir: None,
        }
    }
}

// ── 主任务体（spawn 执行）──────────────────────────────────
async fn run_subscribe_task(
    app_handle: tauri::AppHandle,
    task_id: i64,
    mod_key: String,
    category: String,
    lang_code: String,
    display_name: String,
    version: String,
    file_url: String,
    file_hash: String,
    retry_of: Option<i64>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering;
    let is_cancelled = || cancel.load(Ordering::Relaxed);

    // 取消收尾：写 cancelled 状态 + 广播（临时文件由调用处自行删除）
    async fn cancelled_exit(
        app_handle: &tauri::AppHandle,
        task_id: i64,
        mod_key: &str,
        lang_code: &str,
        display_name: &str,
    ) {
        let _ = update_task_status(app_handle, task_id, "cancelled", 0, "cancelled", Some("用户取消"), &[]);
        let _ = app_handle.emit(
            "subscription-progress",
            SubscriptionProgress::new(task_id, mod_key, lang_code, display_name, 0, "cancelled", "cancelled", "用户取消", 0),
        );
    }

    let _ = retry_of; // 仅记录用，逻辑同
    // 进入任务前已被取消：直接写 cancelled 状态
    if is_cancelled() {
        cancelled_exit(&app_handle, task_id, &mod_key, &lang_code, &display_name).await;
        return;
    }
    // 失败辅助：闭包 async 块捕获引用会触发 lifetime 错，改为独立 async fn
    #[allow(clippy::too_many_arguments)]
    async fn fail(
        app_handle: &tauri::AppHandle,
        task_id: i64,
        mod_key: &str,
        lang_code: &str,
        display_name: &str,
        stage: &str,
        err: &str,
    ) {
        let _ = update_task_status(app_handle, task_id, "failed", 0, stage, Some(err), &[]);
        let _ = app_handle.emit(
            "subscription-progress",
            SubscriptionProgress::new(task_id, mod_key, lang_code, display_name, 0, stage, "failed", err, 0),
        );
    }

    // 1) 读游戏目录
    let game_path = match read_game_path(&app_handle) {
        Ok(p) => p,
        Err(e) => {
            fail(&app_handle, task_id, &mod_key, &lang_code, &display_name, "init", &e).await;
            return;
        }
    };
    let base = game_path.trim_end_matches('\\').to_string();
    let plugins_dir = format!("{}\\BepInEx\\plugins", base);

    let target_dir = match category.as_str() {
        "v2" => format!("{}\\CustomMissions2\\{}", base, mod_key),
        "dll" => plugins_dir.clone(),
        "composite" => base.clone(),
        _ => format!("{}\\CustomMissions", base), // v1 及兜底
    };

    // 2) 确保目标目录存在
    if let Err(e) = fs::create_dir_all(&target_dir) {
        fail(&app_handle, task_id, &mod_key, &lang_code, &display_name, "init", &format!("创建目标目录失败: {e}")).await;
        return;
    }
    let _ = update_task_status(&app_handle, task_id, "downloading", 0, "downloading", None, &[("target_dir", &target_dir)]);
    let _ = app_handle.emit("subscription-progress", SubscriptionProgress::new(
        task_id, &mod_key, &lang_code, &display_name, 0, "downloading", "downloading", "", 0,
    ));

    // 3) 流式下载到临时文件
    // 不设总超时：reqwest 的 timeout 覆盖整个请求（含响应体读取），大文件下载
    // 超过 300s 会被硬性掐断；仅保留连接超时防目标不可达时挂死（与 bepinex.rs 同款）
    let client = match reqwest::Client::builder()
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(e) => { fail(&app_handle, task_id, &mod_key, &lang_code, &display_name, "downloading", &format!("构建 HTTP client 失败: {e}")).await; return; }
    };
    let temp_path = std::env::temp_dir().join(format!("sfmmm_subscribe_{}.zip", task_id));
    // 进度回调：事件每个 tick（约 400ms）都发；DB 写库节流到 1s
    let app_for_progress = app_handle.clone();
    let mk_for_progress = mod_key.clone();
    let lc_for_progress = lang_code.clone();
    let dn_for_progress = display_name.clone();
    let last_persist = Arc::new(Mutex::new(PersistThrottle::new()));
    let on_progress: ProgressFn = Arc::new(move |p: DownloadProgress| {
        let _ = app_for_progress.emit("subscription-progress", SubscriptionProgress::new(
            task_id,
            &mk_for_progress,
            &lc_for_progress,
            &dn_for_progress,
            p.percent,
            "downloading",
            "downloading",
            "",
            p.speed,
        ));
        let persist = last_persist
            .lock()
            .map(|mut t| t.should_persist(std::time::Duration::from_secs(1)))
            .unwrap_or(true);
        if persist {
            let _ = update_task_status(&app_for_progress, task_id, "downloading", p.percent, "downloading", None, &[]);
        }
    });

    // 复用共享下载引擎（Range 分块并行 / 单流回退 / 子块重试 / 取消标志），
    // 与程序更新、前置安装走同一条通路；失败时引擎已删除半成品文件。
    if let Err(e) = download_file(&client, &file_url, &temp_path, DEFAULT_DOWNLOAD_THREADS, on_progress, cancel.clone()).await {
        // 取消：引擎已删半成品文件，写 cancelled 状态即可
        if is_cancelled() {
            let _ = fs::remove_file(&temp_path);
            cancelled_exit(&app_handle, task_id, &mod_key, &lang_code, &display_name).await;
            return;
        }
        fail(&app_handle, task_id, &mod_key, &lang_code, &display_name, "downloading", &e).await;
        let _ = fs::remove_file(&temp_path);
        return;
    }

    // 下载完成后、解压前的取消检查：删临时文件，不污染游戏目录
    if is_cancelled() {
        let _ = fs::remove_file(&temp_path);
        cancelled_exit(&app_handle, task_id, &mod_key, &lang_code, &display_name).await;
        return;
    }

    // 4) 解压
    let _ = update_task_status(&app_handle, task_id, "extracting", 100, "extracting", None, &[]);
    let _ = app_handle.emit("subscription-progress", SubscriptionProgress::new(
        task_id, &mod_key, &lang_code, &display_name, 100, "extracting", "extracting", "", 0,
    ));
    let bytes = match fs::read(&temp_path) {
        Ok(b) => b,
        Err(e) => { fail(&app_handle, task_id, &mod_key, &lang_code, &display_name, "extracting", &format!("读取临时文件失败: {e}")).await; let _ = fs::remove_file(&temp_path); return; }
    };
    let outcome = match extract_zip_recursive(&bytes, &target_dir, &category, &base, &plugins_dir) {
        Ok(o) => o,
        Err(e) => { fail(&app_handle, task_id, &mod_key, &lang_code, &display_name, "extracting", &e).await; let _ = fs::remove_file(&temp_path); return; }
    };
    let _ = fs::remove_file(&temp_path);
    let final_target = outcome.target_dir.clone();
    let manifest = if outcome.files.is_empty() {
        "[]".to_string()
    } else {
        serde_json::to_string(&outcome.files).unwrap_or_else(|_| "[]".into())
    };

    // 5) 逐文件哈希回填云端（失败仅告警）
    //    云端写双键（旧客户端按 basename 仍可用，新客户端按路径区分同名目录）；
    //    本地安装记录只写 basename 口径，避免旧版本预检把路径键当成「云端多出的文件」。
    let file_hash_pairs = match compute_zip_file_hashes(&bytes, &category, &mod_key) {
        Ok(pair) => Some(pair),
        Err(e) => { log::warn!("[subscribe] 计算逐文件哈希失败: {e}"); None }
    };
    if let Some((cloud, _)) = file_hash_pairs.as_ref() {
        let _ = backfill_cloud_hashes(&app_handle, &mod_key, &lang_code, &file_hash, cloud).await;
    }

    // 解压完成、写安装记录前的取消检查：此时半成品文件已落游戏目录但无安装记录，
    // 退订/重装可清理，不写入记录避免"取消却显示已安装"
    if is_cancelled() {
        cancelled_exit(&app_handle, task_id, &mod_key, &lang_code, &display_name).await;
        return;
    }

    // 6) 写安装记录
    // target_dir 按 category 守卫写回：只有 composite 用解压端收窄后的目录
    // （首个非目录条目的父目录 + 游戏根）；v1/v2/dll 保持按类别固定的安装根，
    // 避免把订阅记录页的路径与「打开目录」落点收窄到错误的层级。
    let recorded_target_dir = match category.as_str() {
        "composite" => final_target.as_str(),
        _ => target_dir.as_str(),
    };
    let _ = update_task_status(&app_handle, task_id, "recording", 100, "recording", None, &[
        ("manifest", &manifest),
        ("target_dir", recorded_target_dir),
    ]);
    let local_hashes = file_hash_pairs.as_ref().map(|(_, local)| local.as_str());
    if let Err(e) = write_install_record(&app_handle, &mod_key, &category, &version, &file_hash, &lang_code, &manifest, local_hashes) {
        fail(&app_handle, task_id, &mod_key, &lang_code, &display_name, "recording", &e).await;
        return;
    }

    // 7) done
    let _ = update_task_status(&app_handle, task_id, "done", 100, "done", None, &[]);
    let _ = app_handle.emit("subscription-progress", SubscriptionProgress {
        // 与刚写回任务行的 target_dir 同一个值，前端据此增量更新该行
        target_dir: Some(recorded_target_dir.to_string()),
        ..SubscriptionProgress::new(task_id, &mod_key, &lang_code, &display_name, 100, "done", "done", "", 0)
    });
    // 清理句柄
    if let Ok(mut m) = tasks().lock() {
        m.remove(&task_id);
    }
}

// 回填云端 file_hashes：经服务端 RPC 写入。
// 必须以「本次安装包的 file_hash」作为更新条件：用户可能装到缓存/旧版本包，
// 无条件下写会把旧版本指纹盖到仍指向新版本对象的那一行，导致后续覆盖预检的
// same 判定与编辑工作区的历史基线都失真。哈希对不上就不写，保持云端原值。
async fn backfill_cloud_hashes(
    _app_handle: &tauri::AppHandle,
    mod_key: &str,
    lang_code: &str,
    file_hash: &str,
    file_hashes: &str,
) -> Result<(), String> {
    let parsed: HashMap<String, String> = serde_json::from_str(file_hashes)
        .map_err(|e| format!("解析 file_hashes 失败: {e}"))?;
    if parsed.is_empty() || file_hash.is_empty() {
        return Ok(());
    }
    let json = serde_json::to_string(&parsed).map_err(|e| format!("序列化失败: {e}"))?;
    crate::api::rpc_raw(
        "db_set_mod_file_hashes",
        serde_json::json!({
            "mod_key": mod_key,
            "lang_code": lang_code,
            "file_hashes": json,
            "expected_file_hash": file_hash,
        }),
    )
    .await?;
    Ok(())
}

// ── Tauri 命令 ─────────────────────────────────────────────

/// 创建订阅下载任务并立即返回 task_id；下载在后台异步执行，不阻塞前端。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_subscribe_mod(
    app_handle: tauri::AppHandle,
    mod_key: String,
    mod_id: Option<i64>,
    category: String,
    lang_code: String,
    version: String,
    file_url: String,
    file_hash: String,
    retry_of: Option<i64>,
    // 冗余存一份工坊卡片展示信息，订阅记录页离线也能显示文件名+简介。
    // translations 前端按 JSON.stringify({zh:{name,...},...}) 传入，原样存原文。
    display_name: Option<String>,
    description: Option<String>,
    translations: Option<String>,
    // 用户手动点"重新安装"时置 true：跳过一切去重，强制重下重装。
    // 用于兜底"文件被误删/被改坏但 manifest 探测察觉不到"的场景——
    // 去重只看文件是否存在，无法发现内容损坏，故必须由用户显式表达意图。
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let force = force.unwrap_or(false);
    // 0) 进程重启后残留的运行态行（本进程没有句柄接管）先重置为 failed：
    //    否则下方去重查询会命中残留的 downloading 行并返回 deduplicated，
    //    既不 spawn 任务也无进度事件，前端"等待中"永久卡死
    let conn = open_sqlite(&app_handle)?;
    reset_stale_running_tasks(&conn);
    // 1) 去重：同 mod_key + version + file_hash + lang_code 若已有进行中或已完成任务，
    //    直接返回该 task_id，避免多次退订/订阅产生重复订阅记录
    //    （同一 mod 同版本同 hash 同语言视为同一任务；不同语言各自独立，互不复用）
    //    - 进行中（pending/downloading/extracting/recording）：复用，不重下
    //    - 已完成（done）：幂等返回，不重下——但若 installed_workshop_mods 里对应
    //      安装记录已不在（被退订删掉），done 视为失效允许新建重下重装
    //    - failed/cancelled：不命中，允许新建（视为重试）
    //    - force=true：以上规则全部跳过，只要不是"进行中"就强制新建重下
    let conn = open_sqlite(&app_handle)?;
    // 1.5) 覆盖旧记录：新订阅意味着同 mod_key+版本+hash+语言的旧失败/取消行已失效，
    //     删除它们，保证任意时刻同 mod 同版本同语言只一条有效记录——
    //     否则"首次失败 → 重试成功 → 退订"后，旧的 failed 行与新 done(已退订) 行并存。
    //     lang_code 不可省：否则重装 en 会连带删掉 zh 的 failed 行，而 zh 的任务
    //     尚未重建，用户在订阅记录页就看不到 zh 的失败原因了。
    let _ = conn.execute(
        "DELETE FROM subscription_tasks
         WHERE mod_key = ? AND version = ? AND file_hash = ? AND lang_code = ?
           AND status IN ('failed', 'cancelled')",
        rusqlite::params![mod_key, version, file_hash, lang_code],
    );
    // 去重键含 lang_code：同 mod 不同语言是各自独立的安装（installed_workshop_mods
    // 也是按 mod_key+lang_code 分别记录），若仅按 mod_key+version+file_hash 选行，
    // 多语言 mod 的各语言会互相命中同一行——在 en 上点"重新安装"会把该行的
    // lang_code 改写成 en，下次 zh 的探测与复用都读到 en 的字段。
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM subscription_tasks
             WHERE mod_key = ? AND version = ? AND file_hash = ? AND lang_code = ?
               AND status IN ('pending', 'downloading', 'extracting', 'recording', 'done')
             ORDER BY id DESC LIMIT 1",
            rusqlite::params![mod_key, version, file_hash, lang_code],
            |r| r.get(0),
        )
        .ok();
    let (task_id, is_new) = if let Some(id) = existing {
        // 命中已有任务：进行中直接复用；done 需校验安装记录是否还在
        // 注意：安装记录与游戏路径无关，在设置里改游戏目录不会清理它，
        // 因此仅凭"记录存在"会把新目录下并不存在的 mod 判为已安装，从而永久返回
        // deduplicated 且不 spawn 任务，前端"等待中"占位卡死。这里必须同时校验
        // 安装记录存在 **且** 目标文件在当前游戏目录下真实存在。
        //
        // 必须按语言取安装记录：installed_workshop_mods 是 mod 级行、只保留最后
        // 安装的语言，直接拿它探测会把"另一个语言装过"误判成本语言已安装。
        // 新表有逐语言行时只认本语言（本语言无行＝从未装过/记录已删，需要重装）；
        // 只有旧数据（无逐语言行）才回退 mod 级 manifest。
        let mod_category: Option<String> = conn
            .query_row(
                "SELECT category FROM installed_workshop_mods WHERE mod_key = ?",
                rusqlite::params![mod_key],
                |r| r.get(0),
            )
            .ok();
        let has_lang_rows: i64 = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM installed_workshop_mod_files WHERE mod_key = ?)",
                rusqlite::params![mod_key],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let recorded: Option<(String, String)> = if has_lang_rows > 0 {
            conn.query_row(
                "SELECT manifest FROM installed_workshop_mod_files WHERE mod_key = ? AND lang_code = ?",
                rusqlite::params![mod_key, lang_code],
                |r| Ok(r.get::<_, Option<String>>(0)?.unwrap_or_default()),
            )
            .ok()
            .map(|manifest| {
                (
                    mod_category.clone().unwrap_or_else(|| "v1".to_string()),
                    manifest,
                )
            })
        } else {
            conn.query_row(
                "SELECT category, manifest FROM installed_workshop_mods WHERE mod_key = ?",
                rusqlite::params![mod_key],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    ))
                },
            )
            .ok()
        };
        // force=true 时不探测：用户已明确要求重装，磁盘检测结论无意义（它只能
        // 发现文件缺失，发现不了内容被改坏），省掉一次全量文件遍历
        let need_reinstall = !force
            && match recorded {
                // 查不到行 = 安装记录已不在 = 视为失效
                None => true,
                Some((category, manifest)) => {
                    // 记录在，但文件可能已随游戏目录切换而落在别处：按 manifest 逐项探测。
                    // install_files_present 的契约是 None=文件都在、Some(原因)=失效，
                    // 故 is_some() 才是"需要重装"。
                    match read_game_path(&app_handle) {
                        Ok(game_path) => {
                            let base = game_path.trim_end_matches('\\');
                            install_files_present(base, &mod_key, &category, &manifest).is_some()
                        }
                        // 游戏目录本身无效：交由重新入队的任务在 run_subscribe_task 里
                        // 报 GAME_DIR_INVALID，比静默复用 done 更易诊断
                        Err(_) => true,
                    }
                }
            };
        // 查这个任务的当前状态（进行中 vs 已完成）
        let task_status: String = conn
            .query_row(
                "SELECT status FROM subscription_tasks WHERE id = ?",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap_or_default();
        // 进行中：无论 force 与否都复用，避免并发写同一目标文件
        let in_progress = matches!(
            task_status.as_str(),
            "pending" | "downloading" | "extracting" | "recording"
        );
        if !in_progress && (force || need_reinstall) {
            // 需要重下重装，两种情况：
            //   - force=true：用户手动点"重新安装"，跳过一切检测强制重下
            //   - need_reinstall：安装记录已失效（被退订删掉 / 文件已不在）
            // 直接删掉旧行（不置 superseded 改名），让同 mod_key+版本+语言任意时刻只一条有效记录。
            // 删除范围严格限定在本次的 lang_code：existing 已按 lang_code 选出，
            // 此处只动它自己，不会波及其他语言的进行中/已完成任务。
            let _ = conn.execute(
                "DELETE FROM subscription_tasks WHERE id = ?",
                rusqlite::params![id],
            );
            let new_id = conn
                .query_row(
                    "INSERT INTO subscription_tasks (mod_key, mod_id, category, lang_code, version, file_url, file_hash, status, retry_of, display_name, description, translations)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                     RETURNING id",
                    rusqlite::params![mod_key, mod_id.unwrap_or(0), category, lang_code, version, file_url, file_hash, id, display_name.clone().unwrap_or_default(), description.clone().unwrap_or_default(), translations.clone().unwrap_or_default()],
                    |r| r.get(0),
                )
                .map_err(|e| format!("写入任务记录失败: {e}"))?;
            // 登记 spawn 意图：防止并发调用在此处与 spawn 之间误判为陈旧行
            if let Ok(mut m) = PENDING_SPAWNS.lock() {
                m.insert(new_id);
            }
            (new_id, true)
        } else {
            // 进行中 或 done 且安装记录还在：原样返回，不新建
            (id, false)
        }
    } else {
        // 无命中：写 pending 任务行拿到 task_id
        let id = conn
            .query_row(
                "INSERT INTO subscription_tasks (mod_key, mod_id, category, lang_code, version, file_url, file_hash, status, retry_of, display_name, description, translations)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                 RETURNING id",
                rusqlite::params![mod_key, mod_id.unwrap_or(0), category, lang_code, version, file_url, file_hash, retry_of, display_name.clone().unwrap_or_default(), description.clone().unwrap_or_default(), translations.clone().unwrap_or_default()],
                |r| r.get(0),
            )
            .map_err(|e| format!("写入任务记录失败: {e}"))?;
        // 登记 spawn 意图：防止并发调用在此处与 spawn 之间误判为陈旧行
        if let Ok(mut m) = PENDING_SPAWNS.lock() {
            m.insert(id);
        }
        (id, true)
    };
    drop(conn);

    // 命中已有任务：直接返回该 task_id，不 spawn 重复任务
    if !is_new {
        return Ok(serde_json::json!({ "taskId": task_id, "deduplicated": true }));
    }

    // 2) spawn 后台任务
    let app = app_handle.clone();
    let cancel: Arc<std::sync::atomic::AtomicBool> = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Ok(mut m) = cancel_flags().lock() {
        m.insert(task_id, Arc::clone(&cancel));
    }
    let handle: JoinHandle<()> = tokio::spawn(async move {
        run_subscribe_task(
            app,
            task_id,
            mod_key,
            category,
            lang_code,
            display_name.unwrap_or_default(),
            version,
            file_url,
            file_hash,
            retry_of,
            cancel,
        )
        .await;
        // 任务结束（成功/失败/取消）后清理取消标志，避免表无限增长
        if let Ok(mut m) = cancel_flags().lock() {
            m.remove(&task_id);
        }
    });
    if let Ok(mut m) = tasks().lock() {
        m.insert(task_id, handle);
    }
    // 句柄已入表，撤销 spawn 意图登记
    if let Ok(mut m) = PENDING_SPAWNS.lock() {
        m.remove(&task_id);
    }

    Ok(serde_json::json!({ "taskId": task_id }))
}

/// 列出订阅任务（前端订阅记录页用）。status_filter: None=全部, Some=指定状态。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_subscription_tasks(
    app_handle: tauri::AppHandle,
    status_filter: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = open_sqlite(&app_handle)?;
    // 进程重启后残留的运行态行先重置为 failed，避免订阅记录页永久显示"下载中"
    reset_stale_running_tasks(&conn);
    let limit = limit.unwrap_or(100).min(500);
    let sql = match status_filter.as_deref() {
        Some(s) if !s.is_empty() => format!(
            "SELECT id, mod_key, mod_id, category, lang_code, version, file_url, file_hash, status, percent, stage, error, target_dir, manifest, retry_of, created_at, updated_at, finished_at, display_name, description, translations
             FROM subscription_tasks WHERE status = ? ORDER BY id DESC LIMIT {}",
            limit
        ),
        _ => format!(
            "SELECT id, mod_key, mod_id, category, lang_code, version, file_url, file_hash, status, percent, stage, error, target_dir, manifest, retry_of, created_at, updated_at, finished_at, display_name, description, translations
             FROM subscription_tasks ORDER BY id DESC LIMIT {}",
            limit
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("预备查询失败: {e}"))?;
    let rows: Vec<serde_json::Value> = if status_filter.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
        let s = status_filter.unwrap();
        stmt.query_map(rusqlite::params![s], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "modKey": row.get::<_, String>(1)?,
                "modId": row.get::<_, i64>(2)?,
                "category": row.get::<_, String>(3)?,
                "langCode": row.get::<_, String>(4)?,
                "version": row.get::<_, String>(5)?,
                "fileUrl": row.get::<_, String>(6)?,
                "fileHash": row.get::<_, String>(7)?,
                "status": row.get::<_, String>(8)?,
                "percent": row.get::<_, i64>(9)?,
                "stage": row.get::<_, String>(10)?,
                "error": row.get::<_, String>(11)?,
                "targetDir": row.get::<_, String>(12)?,
                "manifest": row.get::<_, String>(13)?,
                "retryOf": row.get::<_, Option<i64>>(14)?,
                "createdAt": row.get::<_, String>(15)?,
                "updatedAt": row.get::<_, String>(16)?,
                "finishedAt": row.get::<_, String>(17)?,
                "displayName": row.get::<_, String>(18)?,
                "description": row.get::<_, String>(19)?,
                "translations": row.get::<_, String>(20)?,
            }))
        })
        .map_err(|e| format!("查询任务失败: {e}"))?
        .filter_map(|r| r.ok())
        .collect()
    } else {
        stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "modKey": row.get::<_, String>(1)?,
                "modId": row.get::<_, i64>(2)?,
                "category": row.get::<_, String>(3)?,
                "langCode": row.get::<_, String>(4)?,
                "version": row.get::<_, String>(5)?,
                "fileUrl": row.get::<_, String>(6)?,
                "fileHash": row.get::<_, String>(7)?,
                "status": row.get::<_, String>(8)?,
                "percent": row.get::<_, i64>(9)?,
                "stage": row.get::<_, String>(10)?,
                "error": row.get::<_, String>(11)?,
                "targetDir": row.get::<_, String>(12)?,
                "manifest": row.get::<_, String>(13)?,
                "retryOf": row.get::<_, Option<i64>>(14)?,
                "createdAt": row.get::<_, String>(15)?,
                "updatedAt": row.get::<_, String>(16)?,
                "finishedAt": row.get::<_, String>(17)?,
                "displayName": row.get::<_, String>(18)?,
                "description": row.get::<_, String>(19)?,
                "translations": row.get::<_, String>(20)?,
            }))
        })
        .map_err(|e| format!("查询任务失败: {e}"))?
        .filter_map(|r| r.ok())
        .collect()
    };
    Ok(rows)
}

/// 取消进行中的任务（abort + 取消标志）：置位标志让下载循环/各阶段检查点尽快
/// 停止并清理半成品临时文件，同时 abort 句柄兜底（解压等无检查点的同步段），
/// 写 cancelled 状态并广播。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_cancel_subscription(
    app_handle: tauri::AppHandle,
    task_id: i64,
) -> Result<serde_json::Value, String> {
    // 置位取消标志：下载循环/阶段检查点检测到即停止并删临时文件
    if let Ok(m) = cancel_flags().lock() {
        if let Some(flag) = m.get(&task_id) {
            use std::sync::atomic::Ordering;
            flag.store(true, Ordering::Relaxed);
        }
    }
    // abort 顶层 future 兜底（覆盖解压等无取消检查点的同步段）
    let aborted = {
        if let Ok(mut m) = tasks().lock() {
            if let Some(h) = m.remove(&task_id) {
                h.abort();
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    // 删除可能残留的半成品临时 zip（取消检查点通常已删，兜底处理）。
    // Windows 上 abort 后下载子任务的写句柄可能尚未释放，立即删除会失败，
    // 因此再延迟重试几次，避免临时文件长期堆积。
    let temp = std::env::temp_dir().join(format!("sfmmm_subscribe_{}.zip", task_id));
    let _ = fs::remove_file(&temp);
    if temp.exists() {
        tokio::spawn(async move {
            for _ in 0..6 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                if !temp.exists() {
                    break;
                }
                let _ = tokio::fs::remove_file(&temp).await;
            }
        });
    }
    let _ = update_task_status(&app_handle, task_id, "cancelled", 0, "cancelled", Some("用户取消"), &[]);
    // 取消事件也要带 mod_key / lang_code / display_name：订阅记录页与悬浮下载条
    // 都按这些字段定位条目，缺字段时前端只能靠 taskId 猜（取消入口不在详情页，
    // 详情页的 taskId→lang 映射此时早已失效）。
    let (mk, lc, dn) = task_identity(&app_handle, task_id);
    let _ = app_handle.emit(
        "subscription-progress",
        SubscriptionProgress::new(task_id, &mk, &lc, &dn, 0, "cancelled", "cancelled", "用户取消", 0),
    );
    Ok(serde_json::json!({ "cancelled": true, "aborted": aborted }))
}

/// 按 taskId 从 subscription_tasks 读出 (mod_key, lang_code, display_name)。
/// 读不到（行已被清理）时返回空串——事件仍会发出，前端按"未知任务"忽略即可。
fn task_identity(app_handle: &tauri::AppHandle, task_id: i64) -> (String, String, String) {
    let Ok(conn) = open_sqlite(app_handle) else {
        return (String::new(), String::new(), String::new());
    };
    conn.query_row(
        "SELECT mod_key, lang_code, display_name FROM subscription_tasks WHERE id = ?",
        rusqlite::params![task_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        },
    )
    .unwrap_or_default()
}
