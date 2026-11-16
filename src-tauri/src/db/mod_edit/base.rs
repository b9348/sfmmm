//! 底包获取与内容寻址缓存：云端文件行经 API 读取、下载校验、edit_base_cache。

use super::*;

use std::fs;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::db::download::{download_file, DEFAULT_DOWNLOAD_THREADS, DOWNLOAD_CONNECT_TIMEOUT};

/// 原包内容寻址缓存：`edit_base_cache/<sha256>.zip`。
/// 跨工作区 / 工作区被 TTL 清理后 / 同机其他有权限的作者都能复用，
/// 避免重复下载。缓存 TTL 比工作区更长，否则「工作区过期」就失去复用价值。
const BASE_CACHE_ROOT: &str = "edit_base_cache";
const BASE_CACHE_TTL_SECS: i64 = 30 * 24 * 3600;
const BASE_CACHE_QUOTA_BYTES: u64 = 1024 * 1024 * 1024;


/// 读取该语言现有文件行（由服务端做权限校验）。
pub(crate) async fn fetch_base(
    mod_id: u64,
    user_id: u64,
    lang_code: String,
    force: bool,
) -> Result<BaseInfo, String> {
    crate::api::rpc_data(
        "db_get_edit_base",
        serde_json::json!({
            "mod_id": mod_id,
            "user_id": user_id,
            "lang_code": lang_code,
            "force": force,
        }),
    )
    .await
    .map_err(|e| format!("读取文件记录失败: {e}"))
}

async fn download_base_zip(file_url: &str, target: &Path) -> Result<(), String> {
    let part = target.with_extension("zip.part");
    let _ = fs::remove_file(&part);
    let client = reqwest::Client::builder()
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .user_agent(crate::db::user_agent())
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
    let progress: crate::db::download::ProgressFn =
        Arc::new(|_p: crate::db::download::DownloadProgress| {});
    download_file(
        &client,
        file_url,
        &part,
        DEFAULT_DOWNLOAD_THREADS,
        progress,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .map_err(|e| format!("下载原压缩包失败: {e}"))?;
    if !part.is_file() {
        return Err("下载原压缩包失败：未得到有效文件".to_string());
    }
    // Windows 上 rename 会覆盖同名文件；失败则先删再试一次
    if let Err(e) = fs::rename(&part, target) {
        let _ = fs::remove_file(target);
        fs::rename(&part, target).map_err(|e2| format!("保存原压缩包失败: {e} / {e2}"))?;
    }
    Ok(())
}

pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(hex::encode(hasher.finalize()))
}

/// 校验文件 sha256 是否与记录一致（忽略大小写差异）。
pub(crate) fn hash_matches(path: &Path, expected: &str) -> bool {
    sha256_file(path)
        .map(|actual| actual.eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

/// 下载原包并校验 sha256；不一致时删除本地副本，避免以错误基线继续打包。
async fn fetch_base_zip(
    file_url: &str,
    target: &Path,
    expected_hash: &str,
) -> Result<(), String> {
    download_base_zip(file_url, target).await?;
    if !hash_matches(target, expected_hash) {
        let _ = fs::remove_file(target);
        return Err(
            "下载的原压缩包与文件记录不一致（可能命中了 CDN 旧副本），请稍后重试".to_string(),
        );
    }
    Ok(())
}

// ── 原包内容寻址缓存（方案 B）─────────────────────────────────

fn is_valid_sha256_hex(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

fn base_cache_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join(BASE_CACHE_ROOT))
}

fn base_cache_file(app: &tauri::AppHandle, hash: &str) -> Option<PathBuf> {
    if !is_valid_sha256_hex(hash) {
        return None;
    }
    base_cache_dir(app).map(|d| d.join(format!("{}.zip", hash.to_ascii_lowercase())))
}

/// 命中缓存时把缓存复制到工作区 base.zip（复制而非直接引用，避免清理线程
/// 删除缓存文件时正在打包的 zip 句柄失效）。复制后仍按 hash 复核。
pub(crate) fn copy_from_base_cache(app: &tauri::AppHandle, target: &Path, hash: &str) -> bool {
    let Some(cache) = base_cache_file(app, hash) else {
        return false;
    };
    if !cache.is_file() || !hash_matches(&cache, hash) {
        return false;
    }
    let part = target.with_extension("zip.part");
    let _ = fs::remove_file(&part);
    if fs::copy(&cache, &part).is_err() {
        let _ = fs::remove_file(&part);
        return false;
    }
    if !hash_matches(&part, hash) {
        let _ = fs::remove_file(&part);
        return false;
    }
    if let Err(e) = fs::rename(&part, target) {
        let _ = fs::remove_file(target);
        if fs::rename(&part, target).is_err() {
            let _ = fs::remove_file(&part);
            return false;
        }
        log::warn!("缓存原包落盘失败，已删除旧文件重试: {e}");
    }
    true
}

/// 下载/校验成功后写入缓存（best-effort，失败只记日志）。
fn store_base_cache(app: &tauri::AppHandle, src: &Path, hash: &str) {
    let Some(cache) = base_cache_file(app, hash) else {
        return;
    };
    if cache.is_file() && hash_matches(&cache, hash) {
        return;
    }
    let Some(parent) = cache.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let tmp = cache.with_extension("zip.part");
    let _ = fs::remove_file(&tmp);
    if fs::copy(src, &tmp).is_err() || !hash_matches(&tmp, hash) {
        let _ = fs::remove_file(&tmp);
        return;
    }
    if fs::rename(&tmp, &cache).is_err() {
        let _ = fs::remove_file(&tmp);
        return;
    }
    log::info!("已缓存原压缩包: {}", cache.display());
}

/// 缓存清理：只处理 `<64位十六进制>.zip` 命名的文件，按 TTL + LRU 配额。
pub(crate) fn prune_base_cache(app: &tauri::AppHandle) {
    let Some(root) = base_cache_dir(app) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    let now = now_secs();
    let mut files: Vec<(PathBuf, i64, u64)> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let Some(hash_part) = name.strip_suffix(".zip") else {
            continue;
        };
        if !is_valid_sha256_hex(hash_part) {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if modified > 0 && now - modified > BASE_CACHE_TTL_SECS {
            let _ = fs::remove_file(&p);
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        files.push((p, modified, size));
    }
    let total: u64 = files.iter().map(|(_, _, s)| *s).sum();
    if total <= BASE_CACHE_QUOTA_BYTES {
        return;
    }
    files.sort_by_key(|(_, modified, _)| *modified);
    let mut remain = total;
    for (p, _, size) in files {
        if remain <= BASE_CACHE_QUOTA_BYTES {
            break;
        }
        if fs::remove_file(&p).is_ok() {
            remain = remain.saturating_sub(size);
        }
    }
}

/// 确保工作区 base.zip 可用：工作区已有 → 缓存命中 → 才真正下载。
/// 下载成功后写回缓存；下载校验失败保持原语义（删本地副本并报 CDN 旧副本）。
pub(crate) async fn ensure_base_zip(
    app: &tauri::AppHandle,
    dir: &Path,
    file_url: &str,
    expected_hash: &str,
) -> Result<(), String> {
    let target = dir.join("base.zip");
    if target.is_file() && hash_matches(&target, expected_hash) {
        let app_for_cache = app.clone();
        let src = target.clone();
        let hash = expected_hash.to_string();
        // 复制缓存不阻塞当前命令
        let _ = tokio::task::spawn_blocking(move || store_base_cache(&app_for_cache, &src, &hash));
        return Ok(());
    }
    let _ = fs::remove_file(&target);
    if copy_from_base_cache(app, &target, expected_hash) {
        log::info!("命中本地原包缓存: {expected_hash}");
        return Ok(());
    }
    if file_url.trim().is_empty() {
        return Err("该语言文件记录缺少下载地址".to_string());
    }
    fetch_base_zip(file_url, &target, expected_hash).await?;
    let app_for_cache = app.clone();
    let src = target.clone();
    let hash = expected_hash.to_string();
    let _ = tokio::task::spawn_blocking(move || store_base_cache(&app_for_cache, &src, &hash));
    Ok(())
}

