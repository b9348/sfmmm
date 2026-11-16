// 文件哈希 / 预检辅助：本地文件遍历、云端逐文件指纹比对。
// 云端 `mod_files.file_hashes` 的读写经 `crate::api` 走服务端。
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use crate::db::ApiResponse;

// ── 预检 / 惰性补全辅助 ──────────────────────────────────────

/// 计算任意本地文件的 SHA-256（十六进制小写），文件不存在时返回 None。
/// 用途：v2 前置版本指纹复核（前端 BepInExPrereqBanner 以"修改时间早于基准 →
/// 哈希与基准不一致 → 提示更新"的顺序判断，见 prereqPoints.js 的基准常量）。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_hash_file(path: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.is_file() {
            return Ok(None);
        }
        let mut f = std::fs::File::open(p).map_err(|e| format!("打开文件失败: {e}"))?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut f, &mut hasher).map_err(|e| format!("读取文件失败: {e}"))?;
        Ok::<_, String>(Some(hex::encode(hasher.finalize())))
    })
    .await
    .map_err(|e| format!("哈希计算任务失败: {e}"))?
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
/// 忽略 readme.txt（如 v1 前置附带的作者说明，不参与指纹记录/比对）。
fn compute_local_hashes(local_dir: &str) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let path = Path::new(local_dir);
    if path.is_file() {
        if basename_key(local_dir) == "readme.txt" {
            return map;
        }
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
                if basename_key(&p.to_string_lossy()) == "readme.txt" {
                    continue;
                }
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
/// 保留全部键（basename 键 + 路径键），键统一转小写。
///
/// 存储格式（双键并存，见 `merge_file_hashes`）：
/// - basename 键：`{ basename(小写): sha256 }` —— 历史格式，旧客户端只认这一套；
/// - 路径键：`{ 安装根相对路径(小写, / 分隔): sha256 }` —— 新写入端附加，
///   用于区分同名不同目录的文件。
/// 两者放在同一个扁平 `string -> string` JSON 里（不是版本信封），
/// 旧客户端按 `HashMap<String,String>` 解析仍然成功，只是不会去查路径键。
pub(crate) fn parse_file_hashes_flat(raw: Option<String>) -> HashMap<String, String> {
    match raw {
        Some(s) if !s.trim().is_empty() => serde_json::from_str::<HashMap<String, String>>(&s)
            .map(|m: HashMap<String, String>| m.into_iter().map(|(k, v)| (k.to_lowercase(), v)).collect())
            .unwrap_or_default(),
        _ => HashMap::new(),
    }
}

/// basename 视图：丢弃路径键，仅保留历史口径的 basename 键。
/// 用于按文件名比对的消费方（安装预检、变更判定兜底），语义与旧格式完全一致。
pub(crate) fn parse_file_hashes_opt(raw: Option<String>) -> HashMap<String, String> {
    parse_file_hashes_flat(raw)
        .into_iter()
        .filter(|(k, _)| !is_path_key(k))
        .collect()
}

/// 路径键一定含 `/`（basename 不可能含 `/`），所以「表里是否存在含 `/` 的键」
/// 就是「这是否是带路径维度的新格式」的判定依据。
fn is_path_key(key: &str) -> bool {
    key.contains('/')
}

/// 指纹条目数（文件数口径）。
///
/// 双键格式下 basename 键与路径键并存，`parse_file_hashes_opt().len()` 只数
/// basename 键，会在「同名文件分散在不同目录」时把文件数算少。
///
/// 扁平 JSON 里「根目录文件的路径键」和「basename 键」写法完全相同（如
/// `readme.txt`），无法单独识别，所以按下面的口径还原文件数：
/// 有 `/` 的键每个都是一个文件；不带 `/` 的键只有在没有任何子目录条目的
/// basename 与之同名时才算一个独立的根目录文件，否则它只是重复的 basename 键。
/// 旧数据没有路径键时自然退化为「按 basename 计数」，与历史展示口径一致。
pub(crate) fn count_file_hashes(raw: Option<String>) -> usize {
    let map = parse_file_hashes_flat(raw);
    let path_keys: Vec<&String> = map.keys().filter(|k| is_path_key(k)).collect();
    let mut basenames_in_paths: HashSet<&str> = HashSet::new();
    for key in &path_keys {
        if let Some(base) = key.rsplit('/').next() {
            basenames_in_paths.insert(base);
        }
    }
    let root_only = map
        .keys()
        .filter(|k| !is_path_key(k) && !basenames_in_paths.contains(k.as_str()))
        .count();
    path_keys.len() + root_only
}

fn rel_path_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

fn basename_of_key(path: &str) -> String {
    rel_path_key(path)
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// 写入端组合两套口径，返回可直接序列化的单表。
///
/// 顺序很关键：先放 basename 键（旧客户端按名查询仍可用），再按路径字典序
/// 写入路径键。根目录条目的路径键与 basename 键同名，后写使路径键成为权威值，
/// 避免同名折叠时把根文件映射成嵌套文件；同名折叠对旧客户端依旧存在，
/// 但拿到的一定是真实文件的 hash（不会凭空造值）。
pub(crate) fn merge_file_hashes(
    by_name: &HashMap<String, String>,
    by_path: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut out = by_name.clone();
    let mut paths: Vec<(&String, &String)> = by_path.iter().collect();
    // 排序保证「同名折叠留下哪一个」是确定性的，避免 HashMap 迭代顺序带来的抖动
    paths.sort_by(|a, b| a.0.cmp(b.0));
    for (path, hash) in paths {
        out.insert(path.clone(), hash.clone());
    }
    out
}

/// 按安装可见相对路径查指纹的结果。
pub(crate) enum HashLookup {
    /// 命中的权威值（路径键或唯一 basename 键）
    Hit(String),
    /// basename 同名多条且没有路径键可用：无法证明对应关系，调用方必须保守处理
    Ambiguous,
    /// 表里没有该文件
    Missing,
}

/// 按「安装根相对路径」取指纹。
///
/// 1. 路径键 / 根级 basename 键精确命中 → 权威值（新写入端为每个文件都写了路径键）；
/// 2. 未命中且该 basename 在本次清单里唯一 → 回落 basename 键（兼容只有 basename 的旧表）；
/// 3. basename 同名多条 → `Ambiguous`，绝不能拿折叠后的值冒充某个目录的文件。
pub(crate) fn lookup_file_hash(
    map: &HashMap<String, String>,
    rel_path: &str,
    basename_ambiguous: bool,
) -> HashLookup {
    let lower = rel_path_key(rel_path);
    if let Some(hash) = map.get(&lower) {
        return HashLookup::Hit(hash.clone());
    }
    if basename_ambiguous {
        return HashLookup::Ambiguous;
    }
    match map.get(&basename_of_key(&lower)) {
        Some(hash) => HashLookup::Hit(hash.clone()),
        None => HashLookup::Missing,
    }
}

/// 查询云端某 mod 语言版本的逐文件指纹（file_hashes 列）。
/// 返回 JSON 字符串或 None。云端查询经服务端 RPC 完成。
pub(crate) async fn fetch_cloud_file_hashes(
    mod_key: &str,
    lang_code: &str,
) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct HashesResp {
        file_hashes: Option<String>,
    }
    let resp: HashesResp = crate::api::rpc_data(
        "db_get_mod_file_hashes",
        serde_json::json!({ "mod_key": mod_key, "lang_code": lang_code }),
    )
    .await?;
    Ok(resp.file_hashes)
}

/// 预检某已安装 mod 的本地文件指纹是否与云端一致。
/// 返回 match / diffs / collision / needs_backfill / used_local_cache 等供前端展示。
/// 短路优化：当 has_update=false（版本未变）且调用方已带入本地缓存的
/// 逐文件指纹 local_file_hashes 时，直接用本地缓存比对，跳过云端查询。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_preflight_mod(
    mod_key: String,
    lang_code: String,
    local_dir: String,
    category: String,
    local_file_hashes: Option<String>,
    has_update: bool,
) -> Result<ApiResponse, String> {
    // 1) 本地指纹（始终需要，遍历安装目录）
    let local_map = compute_local_hashes(&local_dir);

    // 2) 确定比对基准（云端逐文件指纹）：
    //    - 版本未变(has_update=false) 且 本地已缓存逐文件指纹 -> 直接用本地缓存，跳过云端查询
    //    - 否则（版本已变 / 本地无缓存）-> 查询云端 mod_files.file_hashes
    let (cloud_map, used_local_cache) = if !has_update {
        match &local_file_hashes {
            Some(s) if !s.trim().is_empty() => {
                // 旧安装记录里的缓存指纹可能大小写混杂，与云端解析走同一归一化
                (parse_file_hashes_opt(Some(s.clone())), true)
            }
            _ => {
                let raw = fetch_cloud_file_hashes(&mod_key, &lang_code).await?;
                (parse_file_hashes_opt(raw), false)
            }
        }
    } else {
        let raw = fetch_cloud_file_hashes(&mod_key, &lang_code).await?;
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

    fn dual_fingerprints() -> HashMap<String, String> {
        // 同名不同目录：config/a.json 与 data/a.json 内容不同
        let mut by_name = HashMap::new();
        by_name.insert("a.json".to_string(), "hash-data".to_string());
        by_name.insert("readme.txt".to_string(), "hash-readme".to_string());
        let mut by_path = HashMap::new();
        by_path.insert("config/a.json".to_string(), "hash-config".to_string());
        by_path.insert("data/a.json".to_string(), "hash-data".to_string());
        by_path.insert("readme.txt".to_string(), "hash-readme".to_string());
        merge_file_hashes(&by_name, &by_path)
    }

    #[test]
    fn count_file_hashes_uses_path_keys_in_dual_format() {
        // 双键格式：basename 只有 2 个，但实际文件 3 个（同名 a.json 分布在两个目录），
        // 必须按路径键计数，否则「当前共 N 个文件」会少报。
        let raw = serde_json::to_string(&dual_fingerprints()).unwrap();
        assert_eq!(count_file_hashes(Some(raw)), 3);
        // 历史数据只有 basename 键：退回 basename 计数
        let legacy = serde_json::json!({ "a.json": "h1", "b.json": "h2" }).to_string();
        assert_eq!(count_file_hashes(Some(legacy)), 2);
        assert_eq!(count_file_hashes(None), 0);
    }

    #[test]
    fn merged_fingerprints_are_flat_and_parseable_by_old_readers() {
        let merged = dual_fingerprints();
        let json = serde_json::to_string(&merged).unwrap();
        // 旧客户端的解析口径：扁平 string -> string，不能是版本信封
        let old_view: HashMap<String, String> = serde_json::from_str(&json).unwrap();
        assert_eq!(old_view.get("a.json"), Some(&"hash-data".to_string()));
        assert_eq!(old_view.get("readme.txt"), Some(&"hash-readme".to_string()));
        // 旧客户端按 basename 查询依旧命中（不会读成空指纹）
        assert!(!old_view.is_empty());
        let flat = parse_file_hashes_flat(Some(json));
        assert_eq!(flat.len(), 4);
    }

    #[test]
    fn basename_view_drops_path_keys_without_changing_old_semantics() {
        let json = serde_json::to_string(&dual_fingerprints()).unwrap();
        let base_only = parse_file_hashes_opt(Some(json));
        assert_eq!(base_only.len(), 2);
        assert_eq!(base_only.get("a.json"), Some(&"hash-data".to_string()));
        assert!(base_only.get("config/a.json").is_none());
    }

    #[test]
    fn lookup_distinguishes_same_basename_in_different_directories() {
        let flat = dual_fingerprints();
        match lookup_file_hash(&flat, "config/a.json", true) {
            HashLookup::Hit(h) => assert_eq!(h, "hash-config"),
            _ => panic!("路径键应精确命中"),
        }
        match lookup_file_hash(&flat, "data/a.json", true) {
            HashLookup::Hit(h) => assert_eq!(h, "hash-data"),
            _ => panic!("路径键应精确命中"),
        }
        // 反斜杠 / 大小写同样归一化
        match lookup_file_hash(&flat, "Config\\A.JSON", true) {
            HashLookup::Hit(h) => assert_eq!(h, "hash-config"),
            _ => panic!("路径归一化后应命中"),
        }
    }

    #[test]
    fn lookup_reads_legacy_basename_only_data() {
        let legacy = parse_file_hashes_flat(Some(
            r#"{"a.json":"hash-config","readme.txt":"hash-readme"}"#.to_string(),
        ));
        match lookup_file_hash(&legacy, "config/a.json", false) {
            HashLookup::Hit(h) => assert_eq!(h, "hash-config"),
            _ => panic!("唯一 basename 应能回落到旧格式键"),
        }
        // 同名多条时旧格式无法区分：必须返回 Ambiguous 而不是猜一个
        assert!(matches!(
            lookup_file_hash(&legacy, "config/a.json", true),
            HashLookup::Ambiguous
        ));
        assert!(matches!(
            lookup_file_hash(&legacy, "missing.dll", false),
            HashLookup::Missing
        ));
    }

    #[test]
    fn lookup_does_not_misjudge_mixed_data() {
        // 混合数据：新旧键并存，但有一条嵌套路径只写了 basename（模拟手工合并）
        let mixed = parse_file_hashes_flat(Some(
            r#"{"a.json":"hash-root","sub/a.json":"hash-sub","x.dll":"hash-x","config/x.dll":"hash-x"}"#
                .to_string(),
        ));
        // 路径键存在时精确命中优先，不会被折叠的 basename 带偏
        match lookup_file_hash(&mixed, "sub/a.json", true) {
            HashLookup::Hit(h) => assert_eq!(h, "hash-sub"),
            _ => panic!("路径键应优先"),
        }
        // 同名多条 + 缺该路径键 -> 无法证明，必须保守
        assert!(matches!(
            lookup_file_hash(&mixed, "other/a.json", true),
            HashLookup::Ambiguous
        ));
        // 唯一 basename：即便表是混合的，也能安全回落
        match lookup_file_hash(&mixed, "plugin/x.dll", false) {
            HashLookup::Hit(h) => assert_eq!(h, "hash-x"),
            _ => panic!("唯一 basename 应可回落"),
        }
    }
}
