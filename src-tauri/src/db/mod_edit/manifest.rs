//! manifest 与条目路径归一：清单解析、category 安装根推导、路径结构化归一。

use super::*;

use std::collections::{BTreeSet, HashMap, HashSet};

use std::fs;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

use zip::ZipArchive;

/// 列出 zip 内文件条目，并拒绝非 UTF-8 文件名（P0 结论：应用上传均经 JSZip，
/// 出现非 UTF-8 说明不是本应用产出的包，无法保证 raw_copy 保真）。
pub(crate) fn list_entries(base: &Path) -> Result<Vec<EntryMeta>, String> {
    let file = fs::File::open(base).map_err(|e| format!("打开原压缩包失败: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("原文件不是有效 zip: {e}"))?;
    if archive.is_empty() {
        return Err("原压缩包为空".to_string());
    }
    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let f = archive
            .by_index_raw(i)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        let name = std::str::from_utf8(f.name_raw())
            .map_err(|_| format!("压缩包内存在非 UTF-8 文件名，暂不支持此包：条目 #{i}"))?
            .to_string();
        // 条目名来自外部压缩包：与解压/安装走同一套 safe_zip_path 校验，
        // 拒绝盘符/UNC/`..` 等会逃出工作区或游戏的写法，错误带具体路径。
        // 这里保留原始名字作为暂存键（打包端按原始名匹配），只做校验。
        if !name.is_empty() {
            crate::db::subscribe::safe_zip_path(&name)
                .map_err(|e| format!("原压缩包包含非法路径，无法编辑: {e}"))?;
        }
        if name.is_empty() || f.is_dir() || name.ends_with('/') {
            continue;
        }
        entries.push(EntryMeta {
            index: i,
            path: name,
            size: f.size(),
        });
    }
    if entries.is_empty() {
        return Err("压缩包内没有可替换的文件".to_string());
    }
    Ok(entries)
}

/// manifest 与最终 zip 条目集合一致时原样保留，否则按 zip 重建。
/// `keep_original_dirs` 为真时，重建会保留原 manifest 中的目录条目（末尾 `/`）：
/// 发布端清单含目录项，若上传的 zip 本身没写目录条目，只按 zip 重建会让目录集合
/// 整体消失（文件列表少显示目录、卸载清不掉空目录）。为 false 时只写传入的条目，
/// 用于超长降级——退回仅文件清单，避免补目录后超过上传端 30000 字符上限。
pub(crate) fn resolve_manifest(original: &str, paths: &[String], keep_original_dirs: bool) -> String {
    let original_list: Vec<String> = serde_json::from_str(original).unwrap_or_default();
    let a: BTreeSet<&str> = original_list
        .iter()
        .map(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .collect();
    let b: BTreeSet<&str> = paths.iter().map(|s| s.as_str()).collect();
    if !a.is_empty() && a == b {
        return original.to_string();
    }
    let mut merged: Vec<String> = paths.to_vec();
    if keep_original_dirs {
        let mut seen: BTreeSet<String> = paths.iter().cloned().collect();
        for p in original_list {
            if p.ends_with('/') && !p.trim_end_matches('/').is_empty() && seen.insert(p.clone()) {
                merged.push(p);
            }
        }
    }
    serde_json::to_string(&merged).unwrap_or_else(|_| "[]".to_string())
}

/// 收集最终 zip 的清单条目。目录条目按发布端口径保留末尾 `/`：
/// 只收文件会让「仅替换内容」的重建把目录从清单里丢掉，「查看文件列表」
/// 少显示目录，卸载时也清不掉空目录。
pub(crate) fn collect_manifest_paths<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Vec<String>, String> {
    let mut paths: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        let f = archive
            .by_index_raw(i)
            .map_err(|e| format!("读取新压缩包条目失败: {e}"))?;
        let name = std::str::from_utf8(f.name_raw())
            .map_err(|_| format!("新压缩包内存在非 UTF-8 文件名：条目 #{i}"))?
            .to_string();
        if name.is_empty() {
            continue;
        }
        // zip 里目录条目可能带末尾 / 或只设目录位，两种都归一成末尾 /
        if f.is_dir() || name.ends_with('/') {
            let dir = name.trim_end_matches('/');
            if !dir.is_empty() {
                paths.push(format!("{dir}/"));
            }
            continue;
        }
        paths.push(name);
    }
    Ok(paths)
}

/// 把 DB 里的 manifest 规范化为 zip 内路径列表（含目录条目）。
/// 读取侧不能假设库里一定是「相对安装 target_dir」的新数据：历史 manifest
/// 可能带 `BepInEx/plugins/`、`CustomMissions/` 等父级前缀（甚至重复叠加）。
/// 因此每条都按 category 推导安装根后做结构化归一，再走 `safe_zip_path`。
pub(crate) fn normalized_manifest_paths(
    manifest: &str,
    category: &str,
    mod_key: &str,
) -> Result<Vec<String>, String> {
    if manifest.trim().is_empty() {
        return Ok(Vec::new());
    }
    let list: Vec<String> = serde_json::from_str(manifest)
        .map_err(|e| format!("文件清单解析失败: {e}"))?;
    let mut out = Vec::new();
    for raw in list {
        if raw.trim().is_empty() {
            continue;
        }
        let normalized = normalize_entry_path(category, mod_key, &raw);
        if normalized.is_empty() {
            continue;
        }
        let safe = crate::db::subscribe::safe_zip_path(&normalized)?;
        let safe = safe.trim_matches('/').to_string();
        if safe.is_empty() {
            continue;
        }
        // 目录条目统一补尾斜杠；文件条目原样保留
        if normalized.ends_with('/') {
            out.push(format!("{safe}/"));
        } else {
            out.push(safe);
        }
    }
    Ok(out)
}

pub(crate) fn normalized_manifest_files(
    manifest: &str,
    category: &str,
    mod_key: &str,
) -> Result<Vec<String>, String> {
    Ok(normalized_manifest_paths(manifest, category, mod_key)?
        .into_iter()
        .filter(|p| !p.ends_with('/'))
        .collect())
}

/// 无 base.zip 时用 DB manifest 展示可替换条目（size 未知，按 0）。
pub(crate) fn entries_from_manifest(manifest: &str, category: &str, mod_key: &str) -> Vec<EntryMeta> {
    normalized_manifest_files(manifest, category, mod_key)
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(index, path)| EntryMeta { index, path, size: 0 })
        .collect()
}

pub(crate) fn entry_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn is_reserved_device_name(stem: &str) -> bool {
    if matches!(stem, "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9')
}

/// Windows 下无法表示的路径不应进入 zip（否则安装时会失败）。
pub(crate) fn is_windows_safe_component(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return false;
    }
    if name
        .chars()
        .any(|c| c < '\u{20}' || matches!(c, '<' | '>' | '"' | '|' | '?' | '*' | ':'))
    {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    !is_reserved_device_name(&stem)
}

pub(crate) fn duplicate_basenames(entries: &[String]) -> HashSet<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for e in entries {
        *counts.entry(entry_basename(e).to_lowercase()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .filter(|(_, c)| *c > 1)
        .map(|(k, _)| k)
        .collect()
}

/// 复制并复核内容哈希：防止扫描后到复制前文件被外部改动。
pub(crate) fn copy_local_verified(src: &Path, dst: &Path, expected_hash: &str) -> Result<u64, String> {
    let tmp = dst.with_extension("bin.part");
    let _ = fs::remove_file(&tmp);
    fs::copy(src, &tmp)
        .map_err(|e| format!("复制本地文件失败（{}）: {e}", src.display()))?;
    if !hash_matches(&tmp, expected_hash) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "本地文件在导入过程中发生变化，请重试：{}",
            src.display()
        ));
    }
    if let Err(e) = fs::rename(&tmp, dst) {
        let _ = fs::remove_file(dst);
        fs::rename(&tmp, dst).map_err(|e2| format!("保存导入文件失败: {e} / {e2}"))?;
    }
    fs::metadata(dst)
        .map(|m| m.len())
        .map_err(|e| format!("读取导入文件大小失败: {e}"))
}

pub(crate) fn reset_local_import(dir: &Path, meta: &mut WorkspaceMeta) -> Result<(), String> {
    for sub in ["staging", "materials"] {
        let p = dir.join(sub);
        if p.exists() {
            fs::remove_dir_all(&p).map_err(|e| format!("清理 {} 目录失败: {e}", p.display()))?;
        }
        fs::create_dir_all(&p).map_err(|e| format!("创建 {} 目录失败: {e}", p.display()))?;
    }
    // 重新导入会清空全部替换内容；本次新增的条目也一并移除（内容已不存在），
    // 但保留 local_dir，确保「使用本地文件」下次仍能直接命中。
    let added = meta.added.clone();
    meta.entries.retain(|e| !added.contains(&e.path));
    meta.excluded.retain(|p| !added.contains(p));
    meta.added.clear();
    meta.staged.clear();
    meta.selected.clear();
    meta.selection_initialized = false;
    meta.local_source = None;
    meta.built = None;
    let _ = fs::remove_file(dir.join("package.zip"));
    Ok(())
}

/// 该类别在安装时写入的根目录（即 `extract_zip_recursive` 的 `target_dir`）。
///
/// manifest 里的条目就是相对这个 `target_dir` 记录的（见 subscribe.rs 的安装流程），
/// 因此本地来源根目录必须与之完全一致——**不要再把类别子目录拼到 manifest 路径上**，
/// 否则 v1/v2/dll 会整体错位（例如 composite 已经相对游戏根，再拼 CustomMissions
/// 就找不到任何文件）。手动选目录也必须选到这一层。
pub(crate) fn derive_local_root(
    category: &str,
    mod_key: &str,
    game_path: Option<&str>,
) -> Result<(PathBuf, &'static str), String> {
    let game = game_path
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "请先在设置里配置游戏路径".to_string())?;
    let game = PathBuf::from(game);
    if !game.is_dir() {
        return Err(format!(
            "游戏路径无效或不存在：{}，请先在设置里重新配置游戏路径",
            game.display()
        ));
    }
    match category {
        // composite 的 manifest 相对游戏根
        "composite" => Ok((game, "game_root")),
        // v1 的 manifest 相对 CustomMissions
        "v1" => Ok((game.join("CustomMissions"), "custom_missions")),
        // v2 的 manifest 相对 CustomMissions2/<mod_key>
        "v2" => {
            if mod_key.trim().is_empty()
                || mod_key.contains('/')
                || mod_key.contains('\\')
                || mod_key.contains("..")
            {
                return Err(format!("模组标识不合法，无法定位 CustomMissions2 下的模组目录：{mod_key}"));
            }
            Ok((game.join("CustomMissions2").join(mod_key), "custom_missions2"))
        }
        // dll 在安装时平铺到 BepInEx/plugins，manifest 按 basename 匹配
        "dll" => Ok((game.join("BepInEx").join("plugins"), "plugins")),
        "" => Err("工作区缺少分类信息，请关闭后重新打开面板".to_string()),
        // 与安装端一致：未知类别兜底到 CustomMissions
        _ => Ok((game.join("CustomMissions"), "custom_missions")),
    }
}

pub(crate) fn category_root_label(category: &str) -> &'static str {
    match category {
        "composite" => "游戏根目录",
        "v1" => "CustomMissions 目录",
        "v2" => "CustomMissions2/<模组标识> 目录",
        "dll" => "BepInEx/plugins 目录",
        _ => "本地目录",
    }
}

/// 前端编辑表单当前选择的分类。分类决定条目路径的安装根，必须与同一次保存
/// 里 `db_update_mod` 写回的分类一致；否则会出现「路径按旧分类归一、库里却是
/// 新分类」的双前缀落盘。只接受已知取值，未知值一律回退到库里的分类。
pub(crate) fn sanitize_category(raw: Option<&str>) -> Option<String> {
    raw.map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| matches!(s.as_str(), "v1" | "v2" | "dll" | "composite"))
}

/// 本类别安装时相对游戏根的落点组件（`extract_zip_recursive` 的 `target_dir`）。
/// composite 的条目本来就相对游戏根，返回空表示「无需剥离任何父级前缀」。
fn category_install_components(category: &str, mod_key: &str) -> Vec<String> {
    match category {
        "dll" => vec!["BepInEx".to_string(), "plugins".to_string()],
        "v1" => vec!["CustomMissions".to_string()],
        "v2" => {
            let key = mod_key.trim();
            if key.is_empty() || key.contains('/') || key.contains('\\') || key.contains("..") {
                Vec::new()
            } else {
                vec!["CustomMissions2".to_string(), key.to_string()]
            }
        }
        // composite 与未知类别都按「相对游戏根」处理，不做剥离
        _ => Vec::new(),
    }
}

/// 与组件形式等价的字符串前缀，仅供 `correct_local_root` 使用。
pub(crate) fn category_install_prefix(category: &str, mod_key: &str) -> Option<String> {
    let comps = category_install_components(category, mod_key);
    if comps.is_empty() {
        None
    } else {
        Some(comps.join("/"))
    }
}

/// 按 `/` 与 `\` 切分路径组件，折叠空段与 `.`；目录条目以原字符串的
/// 尾部分隔符为准（`foo/`、`foo\` 都算目录）。`..` 原样保留，交给
/// `safe_zip_path` 拒绝，避免把非法路径「洗白」。
fn split_entry_components(raw: &str) -> (Vec<String>, bool) {
    let norm = raw.replace('\\', "/");
    let is_dir = norm.ends_with('/');
    let comps = norm
        .split('/')
        .filter(|seg| !seg.is_empty() && *seg != ".")
        .map(|seg| seg.to_string())
        .collect();
    (comps, is_dir)
}

fn component_eq(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// path 是否以 prefix 的全部组件开头（大小写不敏感，按段比较）。
fn starts_with_components(path: &[String], prefix: &[String]) -> bool {
    path.len() >= prefix.len() && prefix.iter().zip(path.iter()).all(|(p, c)| component_eq(p, c))
}

/// 把条目路径归一为「相对安装 target_dir」。
///
/// 规则（按组件比较，不做字符串截断）：
/// 1. `\` 统一成 `/`，折叠空段与 `.`；
/// 2. 重复剥掉安装根前缀（`BepInEx/plugins/BepInEx/plugins/x` 这类叠加）；
/// 3. 目录条目若恰好是安装根的上级或安装根本身（`BepInEx/`、`BepInEx/plugins/`），
///    属于结构目录，归一为空，由调用方丢弃；
/// 4. 已经相对安装根/相对游戏根的条目原样返回。
pub(crate) fn normalize_entry_path(category: &str, mod_key: &str, raw: &str) -> String {
    let (mut comps, is_dir) = split_entry_components(raw);
    if comps.is_empty() {
        return String::new();
    }
    let prefix = category_install_components(category, mod_key);
    if prefix.is_empty() {
        let joined = comps.join("/");
        return if is_dir { format!("{joined}/") } else { joined };
    }
    // 前缀重复叠加时逐层剥离（旧包/旧入口可能把安装根写了两遍）
    while starts_with_components(&comps, &prefix) {
        comps.drain(0..prefix.len());
        if comps.is_empty() {
            break;
        }
    }
    if comps.is_empty() {
        return String::new();
    }
    // 目录条目若落在安装根的上级（如 dll 的 `BepInEx/`），不参与匹配
    if is_dir && comps.len() < prefix.len() && starts_with_components(&prefix, &comps) {
        return String::new();
    }
    let joined = comps.join("/");
    if is_dir {
        format!("{joined}/")
    } else {
        joined
    }
}

/// manifest 同样按类别归一；目录条目保留（末尾 `/`），只丢弃安装根本身/
/// 其上级结构目录（归一为空）。重建包时目录条目要同时写回 zip 与清单，
/// 否则「只有空目录、没有文件」的条目会永久消失，卸载也清不掉空目录。
/// 解析失败时原样返回（由后续打包阶段报错）。
pub(crate) fn normalize_manifest(category: &str, mod_key: &str, manifest: &str) -> String {
    if manifest.trim().is_empty() {
        return manifest.to_string();
    }
    let Ok(list) = serde_json::from_str::<Vec<String>>(manifest) else {
        return manifest.to_string();
    };
    let mut changed = false;
    let mapped: Vec<String> = list
        .into_iter()
        .filter_map(|p| {
            let n = normalize_entry_path(category, mod_key, &p);
            if n != p {
                changed = true;
            }
            // 安装根本身及其上级结构目录（BepInEx/、CustomMissions/ 等）归一为空；
            // 其余目录条目（末尾 /）保留，重建包时写回 zip 与 manifest。
            if n.is_empty() {
                changed = true;
                return None;
            }
            Some(n)
        })
        .collect();
    if changed {
        serde_json::to_string(&mapped).unwrap_or_else(|_| manifest.to_string())
    } else {
        manifest.to_string()
    }
}

/// manifest 里的文件条目是否已经就是归一化形态。
///
/// 发布出去的包与 manifest 由同一次客户端操作写出：清单里的文件名还带安装根
/// 前缀，基本可以断定包内条目同样没归一。此时「只改清单」会让云端清单与
/// 实际包内条目脱节（安装端按清单检查落点会漏判），必须改成连包一起重打。
/// 目录条目不影响文件落点，不计入判定。
///
/// 生产路径已改用工作区持久化的 `base_paths_normalized` 事实；这里保留给
/// 单测直接验证归一化判定语义。
#[cfg(test)]
pub(crate) fn manifest_file_paths_normalized(category: &str, mod_key: &str, manifest: &str) -> bool {
    let Ok(list) = serde_json::from_str::<Vec<String>>(manifest) else {
        return false;
    };
    list.iter().all(|p| {
        let n = normalize_entry_path(category, mod_key, p);
        n.is_empty() || n.ends_with('/') || n == *p
    })
}

fn remap_path_set(set: &mut HashSet<String>, category: &str, mod_key: &str) -> bool {
    let old = std::mem::take(set);
    let mut changed = false;
    for p in old {
        let n = normalize_entry_path(category, mod_key, &p);
        changed |= n != p;
        if !n.is_empty() {
            set.insert(n);
        }
    }
    changed
}

fn remap_staged(map: &mut HashMap<String, StagedMeta>, category: &str, mod_key: &str) -> bool {
    let old = std::mem::take(map);
    let mut changed = false;
    for (p, v) in old {
        let n = normalize_entry_path(category, mod_key, &p);
        changed |= n != p;
        if !n.is_empty() {
            map.insert(n, v);
        }
    }
    changed
}

/// 把旧草稿/旧 manifest 里「相对游戏根」的条目统一纠正为「相对安装 target_dir」。
///
/// 返回是否发生了改动。已构建但条目名不合规的 package.zip 直接作废，
/// 避免发布一个带父级目录前缀的包。
pub(crate) fn normalize_meta_paths(dir: &Path, meta: &mut WorkspaceMeta) -> bool {
    let category = meta.category.clone();
    if category.is_empty() {
        return false;
    }
    let mut changed = false;

    let manifest = normalize_manifest(&category, &meta.mod_key, &meta.manifest);
    if manifest != meta.manifest {
        meta.manifest = manifest;
        // 与库里的原始清单不一致：发布端需要把纠正后的清单条件写回数据库
        meta.manifest_dirty = true;
        changed = true;
    }
    // 逐条归一 + 去重：旧包可能同时含带前缀与不带前缀的同一文件；
    // 恰好是安装根目录本身的条目归一为空，直接丢弃。
    let mut seen_paths = HashSet::new();
    let mut deduped = Vec::with_capacity(meta.entries.len());
    for mut entry in meta.entries.drain(..) {
        let p = normalize_entry_path(&category, &meta.mod_key, &entry.path);
        if p.is_empty() {
            changed = true;
            continue;
        }
        if p != entry.path {
            entry.path = p;
            changed = true;
        }
        if seen_paths.insert(entry.path.clone()) {
            deduped.push(entry);
        } else {
            changed = true;
        }
    }
    meta.entries = deduped;
    changed |= remap_path_set(&mut meta.selected, &category, &meta.mod_key);
    changed |= remap_path_set(&mut meta.excluded, &category, &meta.mod_key);
    changed |= remap_path_set(&mut meta.added, &category, &meta.mod_key);
    changed |= remap_staged(&mut meta.staged, &category, &meta.mod_key);
    if let Some(local) = meta.local_source.as_mut() {
        let old = std::mem::take(&mut local.materials);
        let mut remapped = HashMap::with_capacity(old.len());
        for (p, v) in old {
            let n = normalize_entry_path(&category, &meta.mod_key, &p);
            changed |= n != p;
            if !n.is_empty() {
                remapped.insert(n, v);
            }
        }
        local.materials = remapped;
        for p in &mut local.summary.missing {
            let n = normalize_entry_path(&category, &meta.mod_key, p);
            if n != *p {
                *p = n;
                changed = true;
            }
        }
        local.summary.missing.retain(|p| !p.is_empty());
    }

    if changed {
        if meta.built.is_some() {
            meta.built = None;
            let _ = fs::remove_file(dir.join("package.zip"));
        }
        meta.updated_at = now_secs();
    }
    changed
}

/// 传入的根目录若其实是「游戏根」或该落点的上级目录，纠正到安装 target_dir。
/// 例如 dll 误选了游戏根：`<game>/BepInEx/plugins` 存在时直接改用它，
/// 这样本地文件相对路径与 manifest 条目才对得上。
pub(crate) fn correct_local_root(root: PathBuf, category: &str, mod_key: &str) -> PathBuf {
    let Some(prefix) = category_install_prefix(category, mod_key) else {
        return root;
    };
    let components: Vec<&str> = prefix.split('/').collect();
    let root_norm = root.to_string_lossy().replace('\\', "/").to_lowercase();
    let root_norm = root_norm.trim_end_matches('/');
    // 找到 root 尾部已经覆盖了 prefix 的多少段：0 表示完全是上级目录，
    // 2 表示 root 就是 target_dir 本身。
    let mut matched = 0;
    for k in (1..=components.len()).rev() {
        let tail = components[..k].join("/").to_lowercase();
        if root_norm == tail || root_norm.ends_with(&format!("/{tail}")) {
            matched = k;
            break;
        }
    }
    if matched == components.len() {
        return root;
    }
    let candidate = root.join(components[matched..].join("/"));
    if candidate.is_dir() {
        candidate
    } else {
        root
    }
}
