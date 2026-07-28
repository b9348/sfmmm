// 文件哈希 / 预检辅助：compute_local_hashes、fetch_cloud_file_hashes 等。
// 命令 db_preflight_mod / db_set_mod_file_hashes 也归属本模块。
use mysql::prelude::*;
use mysql::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::Path;
use serde_json;
use crate::db::{with_conn, with_conn_pool, ApiResponse, DbState, ManagedPool};

// ── 预检 / 惰性补全辅助 ──────────────────────────────────────

/// 幂等确保 mod_files 含 file_hashes 列（兼容旧库）。
/// 已存在时忽略 "Duplicate column" 错误；其余错误向上传播。
pub(crate) fn ensure_mod_files_file_hashes_column<C: Queryable>(conn: &mut C) -> Result<(), String> {
    match conn.exec_drop("ALTER TABLE mod_files ADD COLUMN file_hashes TEXT NULL", ()) {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.to_lowercase().contains("duplicate column") {
                Ok(())
            } else {
                Err(format!("无法确保 mod_files.file_hashes 列: {}", msg))
            }
        }
    }
}

/// 字节流 SHA-256 十六进制串
fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// 规范化比对键：取 basename、转小写（去除目录与大小写差异）。
/// 对 dll 等平铺部署尤为重要；对 v1/v2/composite 亦能跨打包风格稳定比对。
fn basename_key(path: &str) -> String {
    let p = path.replace('\\', "/");
    let name = p.rsplit('/').next().unwrap_or(&p);
    name.to_lowercase()
}

/// 递归遍历 local_dir，对每个文件计算 SHA-256，返回 basename(小写)->hash。
/// 若 local_dir 自身为文件，则只哈希该文件（用于 dll 等单文件场景）。
fn compute_local_hashes(local_dir: &str) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let path = Path::new(local_dir);
    if path.is_file() {
        if let Ok(mut f) = std::fs::File::open(path) {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                map.insert(basename_key(local_dir), sha256_hex(&buf));
            }
        }
        return map;
    }
    if !path.is_dir() {
        return map;
    }
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.is_file() {
                if let Ok(mut f) = std::fs::File::open(&p) {
                    let mut buf = Vec::new();
                    if f.read_to_end(&mut buf).is_ok() {
                        map.insert(basename_key(&p.to_string_lossy()), sha256_hex(&buf));
                    }
                }
            }
        }
    }
    map
}

/// 解析云端 file_hashes JSON（可能为 NULL / 空串），非法时回落空 map。
fn parse_file_hashes_opt(raw: Option<String>) -> HashMap<String, String> {
    match raw {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<HashMap<String, String>>(&s).unwrap_or_default(),
        _ => HashMap::new(),
    }
}

/// 查询云端某 mod 语言版本的逐文件指纹（file_hashes 列）。
/// 自动确保 file_hashes 列存在（兼容旧库）。返回 JSON 字符串或 None。
pub(crate) async fn fetch_cloud_file_hashes(
    pool: ManagedPool,
    mod_key: &str,
    lang_code: &str,
) -> Result<Option<String>, String> {
    let mk = mod_key.to_string();
    let lc = lang_code.to_string();
    with_conn_pool(&pool, move |conn: &mut PooledConn| -> Result<Option<String>, String> {
        ensure_mod_files_file_hashes_column(conn)?;
        let row: Option<(Option<String>,)> = conn.exec_first(
            "SELECT f.file_hashes
             FROM mod_files f
             JOIN mods m ON m.id = f.mod_id
             WHERE m.mod_id = ? AND f.lang_code = ?
             ORDER BY f.id DESC LIMIT 1",
            (&mk, &lc),
        ).map_err(|e| e.to_string())?;
        Ok(row.and_then(|(h,)| h))
    }).await
}

/// 预检某已安装 mod 的本地文件指纹是否与云端一致。
/// 返回 match / diffs / collision / needs_backfill / used_local_cache 等供前端展示。
/// 短路优化：当 has_update=false（版本未变）且调用方已带入本地缓存的
/// 逐文件指纹 local_file_hashes 时，直接用本地缓存比对，跳过云端查询。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_preflight_mod(
    state: tauri::State<'_, DbState>,
    mod_key: String,
    lang_code: String,
    local_dir: String,
    category: String,
    local_file_hashes: Option<String>,
    has_update: bool,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();

    // 1) 本地指纹（始终需要，遍历安装目录）
    let local_map = compute_local_hashes(&local_dir);

    // 2) 确定比对基准（云端逐文件指纹）：
    //    - 版本未变(has_update=false) 且 本地已缓存逐文件指纹 -> 直接用本地缓存，跳过云端查询
    //    - 否则（版本已变 / 本地无缓存）-> 查询云端 mod_files.file_hashes
    let (cloud_map, used_local_cache) = if !has_update {
        match &local_file_hashes {
            Some(s) if !s.trim().is_empty() => {
                (serde_json::from_str::<HashMap<String, String>>(s).unwrap_or_default(), true)
            }
            _ => {
                let raw = fetch_cloud_file_hashes(pool.clone(), &mod_key, &lang_code).await?;
                (parse_file_hashes_opt(raw), false)
            }
        }
    } else {
        let raw = fetch_cloud_file_hashes(pool.clone(), &mod_key, &lang_code).await?;
        (parse_file_hashes_opt(raw), false)
    };

    let needs_backfill = cloud_map.is_empty();
    if needs_backfill {
        return Ok(ApiResponse::ok_val(serde_json::json!({
            "match": false,
            "local_count": local_map.len(),
            "cloud_count": 0,
            "diffs": [],
            "collision": false,
            "needs_backfill": true,
            "used_local_cache": used_local_cache,
            "category": category,
            "extra_file": false,
            "missing_file": false,
        }), "preflight_needs_backfill"));
    }

    // 4) 逐文件比对
    let mut diffs: Vec<serde_json::Value> = Vec::new();
    let mut extra_file = false;   // 本地多出（云端无）→ 可能是其它 mod 撞车
    let mut missing_file = false; // 云端有、本地缺 → 安装不全
    let mut mismatch = false;     // 同名不同哈希 → 被覆盖/篡改
    let mut keys: BTreeSet<String> = BTreeSet::new();
    keys.extend(local_map.keys().cloned());
    keys.extend(cloud_map.keys().cloned());
    for k in keys {
        let lh = local_map.get(&k).cloned();
        let ch = cloud_map.get(&k).cloned();
        match (lh, ch) {
            (Some(l), Some(c)) => {
                if l != c {
                    mismatch = true;
                    diffs.push(serde_json::json!({
                        "path": k,
                        "kind": "mismatch",
                        "local_hash": l,
                        "cloud_hash": c,
                    }));
                }
            }
            (Some(l), None) => {
                extra_file = true;
                diffs.push(serde_json::json!({
                    "path": k,
                    "kind": "missing_cloud",
                    "local_hash": l,
                    "cloud_hash": null,
                }));
            }
            (None, Some(c)) => {
                missing_file = true;
                diffs.push(serde_json::json!({
                    "path": k,
                    "kind": "missing_local",
                    "local_hash": null,
                    "cloud_hash": c,
                }));
            }
            (None, None) => {}
        }
    }

    let is_match = diffs.is_empty();
    // 撞车：本地多出文件（被其它 mod 覆盖）或哈希不一致
    let collision = extra_file || mismatch;

    Ok(ApiResponse::ok_val(serde_json::json!({
        "match": is_match,
        "local_count": local_map.len(),
        "cloud_count": cloud_map.len(),
        "diffs": diffs,
        "collision": collision,
        "needs_backfill": false,
        "used_local_cache": used_local_cache,
        "category": category,
        "extra_file": extra_file,
        "missing_file": missing_file,
    }), "OK"))
}

/// 订阅者安装后，将本地算出的逐文件指纹回填到云端 mod_files.file_hashes。
/// 始终以官方 zip 算出的规范（递归后）指纹覆盖对应语言行（幂等）：
/// 移除 IS NULL 限制，使已上传过、但用旧非递归口径（缺内包文件）的 mod
/// 也能在安装时被升级为包含内包文件的精确指纹，嵌套 zip mod 预检不再误报。
/// file_hashes 须为 { basename(小写): hash } 的 JSON 字符串，
/// 与 db_preflight_mod 的 compute_local_hashes / 上传时的 computeZipFileHashes 口径一致。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_set_mod_file_hashes(
    state: tauri::State<'_, DbState>,
    mod_key: String,
    lang_code: String,
    file_hashes: String,
) -> Result<ApiResponse, String> {
    // 校验为合法的 basename->hash 映射，避免写入垃圾
    let parsed: HashMap<String, String> = match serde_json::from_str::<HashMap<String, String>>(&file_hashes) {
        Ok(m) if !m.is_empty() => m,
        _ => return Ok(ApiResponse::err("file_hashes 格式无效或为空")),
    };
    let json = match serde_json::to_string(&parsed) {
        Ok(s) => s,
        Err(e) => return Err(format!("序列化失败: {e}")),
    };

    let mk = mod_key.clone();
    let lc = lang_code.clone();
    let (updated,) = with_conn(state.inner(), move |conn: &mut PooledConn| -> Result<(u64,), String> {
        ensure_mod_files_file_hashes_column(conn)?;
        // 始终以官方 zip 算出的规范（递归后）指纹覆盖对应语言行：
        // 移除 IS NULL 限制，使已上传过、但用旧非递归口径（缺内包文件）的 mod
        // 也能在安装时被升级为包含内包文件的精确指纹，嵌套 zip mod 预检不再误报。
        conn.exec_drop(
            "UPDATE mod_files f JOIN mods m ON m.id = f.mod_id
             SET f.file_hashes = ?
             WHERE m.mod_id = ? AND f.lang_code = ?",
            (&json, &mk, &lc),
        ).map_err(|e| e.to_string())?;
        Ok((conn.affected_rows(),))
    }).await?;

    Ok(ApiResponse::ok_val(serde_json::json!({ "updated": updated > 0 }), "OK"))
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn basename_key_normalizes() {
        assert_eq!(basename_key("a/b/C.DLL"), "c.dll");
        assert_eq!(basename_key("C:\\x\\Y.Zip"), "y.zip");
        assert_eq!(basename_key("plain.txt"), "plain.txt");
    }

    #[test]
    fn compute_local_hashes_empty_dir() {
        let tmp = std::env::temp_dir().join("sfmmm_test_empty");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let map = compute_local_hashes(tmp.to_str().unwrap());
        assert!(map.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn compute_local_hashes_dir() {
        let tmp = std::env::temp_dir().join("sfmmm_test_dir");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("Mod.Pak"), b"hello world").unwrap();
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("sub").join("Inner.dll"), b"nested").unwrap();
        let map = compute_local_hashes(tmp.to_str().unwrap());
        assert_eq!(map.get("mod.pak"), Some(&sha256_hex(b"hello world")));
        assert_eq!(map.get("inner.dll"), Some(&sha256_hex(b"nested")));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn compute_local_hashes_file_path() {
        let tmp = std::env::temp_dir().join("sfmmm_test_file");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let file = tmp.join("single.dll");
        fs::write(&file, b"payload").unwrap();
        let map = compute_local_hashes(file.to_str().unwrap());
        assert_eq!(map.get("single.dll"), Some(&sha256_hex(b"payload")));
        let _ = fs::remove_dir_all(&tmp);
    }
}
