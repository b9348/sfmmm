//! 工作区目录与互斥：路径校验、锁表、TTL/配额清理、语言编辑权限。

use super::*;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use once_cell::sync::Lazy;

const WORKSPACE_ROOT: &str = "edit_workspaces";
/// 工作区 TTL：7 天未动自动清理（草稿也一并丢弃）
const WORKSPACE_TTL_SECS: i64 = 7 * 24 * 3600;
/// 工作区总磁盘配额：超出后按最近使用时间从旧到新清理
const WORKSPACE_QUOTA_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub(crate) fn workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join(WORKSPACE_ROOT);
    fs::create_dir_all(&dir).map_err(|e| format!("创建编辑工作区目录失败: {e}"))?;
    Ok(dir)
}

/// workspace_id 来自前端（localStorage 草稿），必须严格校验，避免路径穿越。
pub(crate) fn is_valid_workspace_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// lang_code 会参与拼接 workspace_id，收紧到安全字符集，避免外部输入带入
/// 路径分隔符/盘符等字符后绕过 is_valid_workspace_id。
pub(crate) fn is_valid_lang_code(lang: &str) -> bool {
    !lang.is_empty()
        && lang.len() <= 32
        && lang
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 发布版本号会原样拼进远端对象路径 `sfm/{mod_id}/{lang}/{version}/edit_...`，
/// 必须收紧到安全字符集。`semver_cmp` 只取数字段比较，拦不住 `1.0.1/../x`、
/// `1.0.1 beta` 这类值（会被拼成带 `../` 或空格的 CDN 目录）。
pub(crate) fn is_valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

// ── 工作区互斥 ──────────────────────────────────────────────
// stage/unstage/build/discard 都是「读 workspace.json → 改 → 写回」的读改写流程。
// 单实例桌面应用内用进程内互斥即可：按 workspace_id 串行化，不引外部依赖。
static WORKSPACE_LOCKS: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// 取得某工作区的所有权互斥锁（async，允许跨 await 持有）。
pub(crate) async fn lock_workspace(workspace_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock = {
        let mut map = WORKSPACE_LOCKS
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.entry(workspace_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    lock.lock_owned().await
}

/// 「打开工作区」三元组锁的 key，与 workspace_id 共用同一张锁表但加了前缀，
/// 不会和真实工作区 id 撞名。同一用户/mod/语言只允许一个打开流程。
pub(crate) fn open_lock_key(mod_id: u64, user_id: u64, lang_code: &str) -> String {
    format!("open_{mod_id}_{user_id}_{lang_code}")
}

/// 扫描工作区目录，找同一用户/mod/语言、同一基线 hash 的既有草稿（最新优先）。
/// 前端还没写入 workspace_id（快速关闭再打开）时靠它复用，避免重复下载原包。
pub(crate) fn find_reusable_workspace(
    root: &Path,
    mod_id: u64,
    user_id: u64,
    lang_code: &str,
    base_hash: &str,
) -> Option<WorkspaceMeta> {
    let entries = fs::read_dir(root).ok()?;
    let mut best: Option<WorkspaceMeta> = None;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(name) = dir.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if !is_valid_workspace_id(&name) {
            continue;
        }
        let Ok(meta) = load_meta(&dir) else {
            continue;
        };
        if meta.user_id != user_id
            || meta.mod_id != mod_id
            || meta.lang_code != lang_code
            || meta.base_file_hash != base_hash
        {
            continue;
        }
        if best
            .as_ref()
            .map(|b| meta.updated_at > b.updated_at)
            .unwrap_or(true)
        {
            best = Some(meta);
        }
    }
    best
}

fn dir_size(dir: &Path) -> u64 {
    let mut total: u64 = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            match entry.metadata() {
                Ok(m) if m.is_dir() => stack.push(p),
                Ok(m) => total = total.saturating_add(m.len()),
                Err(_) => {}
            }
        }
    }
    total
}

/// 清理过期工作区并执行磁盘配额。只操作 `edit_workspaces` 下的子目录，
/// 目录名必须是合法 workspace_id；其它内容一律不碰。
/// `skip_id` 用于跳过正在使用的工作区，避免清理线程删掉当前草稿。
pub fn prune_edit_workspaces(app: &tauri::AppHandle, skip_id: Option<&str>) {
    prune_base_cache(app);
    let Ok(root) = workspace_root(app) else {
        return;
    };
    // 锁表清理：WORKSPACE_LOCKS 只增不删，目录被 TTL/配额删除后条目会永久残留。
    // 在持有 map 锁的前提下用 Arc::strong_count == 1 判定无人使用（使用中或等待中
    // 的调用方必然持有克隆，计数 ≥2），此时移除不会与他人竞争；下次访问会重建条目。
    // 目录仍存在的条目保留（目录可能刚被重建/正在使用中，交给下轮清理）。
    {
        let mut map = WORKSPACE_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|id, lock| {
            Arc::strong_count(lock) > 1 || root.join(id).is_dir()
        });
    }
    let now = now_secs();
    let mut dirs: Vec<(PathBuf, i64, u64)> = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if !is_valid_workspace_id(&name) {
            continue;
        }
        if skip_id == Some(name.as_str()) {
            continue;
        }
        let updated = load_meta(&p)
            .map(|m| m.updated_at)
            .unwrap_or_else(|_| {
                entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0)
            });
        if updated > 0 && now - updated > WORKSPACE_TTL_SECS {
            let _ = fs::remove_dir_all(&p);
            continue;
        }
        dirs.push((p, updated, dir_size(&entry.path())));
    }

    let total: u64 = dirs.iter().map(|(_, _, s)| *s).sum();
    if total > WORKSPACE_QUOTA_BYTES {
        dirs.sort_by_key(|(_, updated, _)| *updated);
        let mut remain = total;
        for (p, _, size) in dirs {
            if remain <= WORKSPACE_QUOTA_BYTES {
                break;
            }
            if fs::remove_dir_all(&p).is_ok() {
                remain = remain.saturating_sub(size);
            }
        }
    }
}

/// 在打开工作区后顺带清理（不阻塞 async 运行时），并跳过当前工作区。
pub(crate) fn prune_in_background(app: &tauri::AppHandle, skip_id: String) {
    let handle = app.clone();
    std::thread::spawn(move || prune_edit_workspaces(&handle, Some(&skip_id)));
}
