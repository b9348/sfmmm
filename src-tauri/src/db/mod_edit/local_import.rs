//! 本地目录导入与自动应用：目录扫描、条目解析、底包取字节的本地来源路径。

use super::*;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};


/// `mod_files.file_hashes` 在旧库上是 TEXT（约 64KB）。超过这个量级时
/// 在导入阶段给出预警，避免打完包上传后才在写库环节失败。
const FILE_HASHES_MAX_BYTES: usize = 60000;

// ── 本地构建产物目录导入（方案 A）────────────────────────────


/// 本地目录兜底扫描的条目上限。只有「精确路径不存在」时才触发兜底，
/// 超过上限就放弃猜测并如实报缺失，避免 composite（根=游戏根）把整个
/// 游戏目录递归扫一遍。
const LOCAL_FALLBACK_SCAN_MAX_ENTRIES: usize = 20000;

/// 本地文件索引：相对安装根的路径 + 小写 basename 反查。
struct LocalFileIndex {
    files: Vec<String>,
    by_basename: HashMap<String, Vec<usize>>,
}

fn build_local_file_index(root: &Path) -> Option<LocalFileIndex> {
    let mut files: Vec<String> = Vec::new();
    let mut by_basename: HashMap<String, Vec<usize>> = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            visited += 1;
            if visited > LOCAL_FALLBACK_SCAN_MAX_ENTRIES {
                return None;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let idx = files.len();
            by_basename
                .entry(rel.rsplit('/').next().unwrap_or(&rel).to_lowercase())
                .or_default()
                .push(idx);
            files.push(rel);
        }
    }
    Some(LocalFileIndex { files, by_basename })
}

enum LocalResolution {
    Resolved(String),
    Ambiguous(Vec<String>),
    NotFound,
}

fn format_candidates(candidates: &[String]) -> String {
    const MAX_SHOWN: usize = 6;
    let mut shown: Vec<&str> = candidates.iter().take(MAX_SHOWN).map(|s| s.as_str()).collect();
    if candidates.len() > MAX_SHOWN {
        shown.push("…");
    }
    shown.join("、")
}

/// 条目精确路径在本地不存在时的兜底解析（只用于取字节，不改写清单键）：
/// 1. 大小写不敏感的全路径；
/// 2. basename 唯一：本地只有一个同名文件时才采用；
/// 3. 后缀唯一：同名多个时，用条目尾部多段路径逐级收窄；
/// 4. 仍不唯一：判为「路径无法解析」，把候选回给调用方，绝不瞎猜。
fn resolve_local_entry(index: &LocalFileIndex, entry: &str) -> LocalResolution {
    let entry_norm = entry.replace('\\', "/").to_lowercase();
    let same_path: Vec<&String> = index
        .files
        .iter()
        .filter(|p| p.to_lowercase() == entry_norm)
        .collect();
    if same_path.len() == 1 {
        return LocalResolution::Resolved(same_path[0].clone());
    }
    if same_path.len() > 1 {
        return LocalResolution::Ambiguous(same_path.into_iter().cloned().collect());
    }
    let basename = entry_norm.rsplit('/').next().unwrap_or(&entry_norm);
    let Some(indices) = index.by_basename.get(basename) else {
        return LocalResolution::NotFound;
    };
    if indices.len() == 1 {
        return LocalResolution::Resolved(index.files[indices[0]].clone());
    }
    // basename 多个：用条目尾部组件逐级收窄（至少 2 段）
    let parts: Vec<&str> = entry_norm.split('/').collect();
    for n in (2..=parts.len()).rev() {
        let suffix = parts[parts.len() - n..].join("/");
        let candidates: Vec<String> = indices
            .iter()
            .map(|i| &index.files[*i])
            .filter(|p| p.to_lowercase().ends_with(&format!("/{suffix}")))
            .cloned()
            .collect();
        if candidates.len() == 1 {
            return LocalResolution::Resolved(candidates[0].clone());
        }
        if candidates.len() > 1 && n == parts.len() {
            return LocalResolution::Ambiguous(candidates);
        }
    }
    LocalResolution::Ambiguous(
        indices
            .iter()
            .map(|i| index.files[*i].clone())
            .collect(),
    )
}

/// 按 manifest 逐条映射到游戏目录内的实际文件并比对指纹。
///
/// 默认只做「清单条目 → 本地精确路径」的映射（composite 的根是游戏根，
/// 全量递归会扫进游戏本体，动辄数 GB）。精确路径不存在时才按需建立
/// 有上限的本地索引，按「唯一 basename / 唯一后缀」兜底；仍无法唯一确定
/// 的条目记入 `ambiguous` 并回传候选，不猜路径、不误判为已匹配。
pub(crate) fn import_directory_inner(
    dir: &Path,
    mut meta: WorkspaceMeta,
    root_path: &str,
) -> Result<(WorkspaceMeta, ImportSummary), String> {
    let category = meta.category.clone();
    if category.is_empty() {
        return Err("工作区缺少分类信息，请关闭后重新打开面板".to_string());
    }
    // 兜底：传入的根目录若还是游戏根/上级目录，纠正到本类别的安装 target_dir。
    let root = correct_local_root(PathBuf::from(root_path), &category, &meta.mod_key);
    if !root.is_dir() {
        return Err(format!("游戏目录不存在：{}", root.display()));
    }
    let root_path = root.to_string_lossy().to_string();
    let entries = normalized_manifest_files(&meta.manifest, &category, &meta.mod_key)?;
    if entries.is_empty() {
        return Err("该语言没有可用的文件清单，无法按游戏目录比对".to_string());
    }

    reset_local_import(dir, &mut meta)?;
    // 先落盘清空态：后续复制/哈希失败时草稿保持一致（不会残留指向已删文件的 staged 记录）
    save_meta(dir, &meta)?;

    // 基线指纹取完整表（含路径键）：新格式能区分同名不同目录，
    // 旧格式（只有 basename 键）仍可读，只是同名条目继续保守处理。
    let baseline = crate::db::hash::parse_file_hashes_flat(Some(meta.base_file_hashes.clone()));
    let baseline_unverified = baseline.is_empty();
    let duplicates = duplicate_basenames(&entries);

    let mut summary = ImportSummary {
        root_path: root_path.clone(),
        baseline_unverified,
        total_manifest_files: entries.len(),
        ..Default::default()
    };

    let mut matched_set: HashSet<String> = HashSet::new();
    // 兜底索引按需构建：只有出现「精确路径不存在」的条目才扫描本地目录。
    // 外层 None=未构建，Some(None)=扫描超上限放弃，Some(Some(idx))=可用。
    let mut index_cache: Option<Option<LocalFileIndex>> = None;
    for entry in &entries {
        let mut abs = root.join(entry);
        let mut exists = fs::metadata(&abs).map(|m| m.is_file()).unwrap_or(false);
        if !exists {
            if index_cache.is_none() {
                index_cache = Some(build_local_file_index(&root));
            }
            if let Some(Some(index)) = index_cache.as_ref() {
                match resolve_local_entry(index, entry) {
                    LocalResolution::Resolved(rel) => {
                        let candidate = root.join(&rel);
                        if fs::metadata(&candidate).map(|m| m.is_file()).unwrap_or(false) {
                            abs = candidate;
                            exists = true;
                        }
                    }
                    LocalResolution::Ambiguous(candidates) => {
                        summary.ambiguous.push(entry.clone());
                        summary.ambiguous_details.push(format!(
                            "{entry}（路径无法解析，候选：{}）",
                            format_candidates(&candidates)
                        ));
                        continue;
                    }
                    LocalResolution::NotFound => {}
                }
            }
        }
        if !exists {
            summary.missing.push(entry.clone());
            continue;
        }
        let hash = match sha256_file(&abs) {
            Ok(h) => h,
            Err(_) => {
                // 文件存在但读不出来（权限/占用）同样按缺失处理，逐条回给前端
                summary.missing.push(entry.clone());
                continue;
            }
        };
        matched_set.insert(entry.clone());
        let basename = entry_basename(entry).to_lowercase();
        // 按路径键取指纹：新格式能区分同名不同目录；旧格式/同名多条时返回
        // Ambiguous（无法证明对应关系），只能保守按「已变化」处理。
        let lookup = crate::db::hash::lookup_file_hash(
            &baseline,
            entry,
            duplicates.contains(&basename),
        );
        let is_changed = match &lookup {
            crate::db::hash::HashLookup::Hit(h) => !h.eq_ignore_ascii_case(&hash),
            _ => true,
        };
        let entry_key = hex::encode(Sha256::digest(entry.as_bytes()));
        if is_changed {
            if entry.to_ascii_lowercase().ends_with(".zip")
                && !matches!(lookup, crate::db::hash::HashLookup::Hit(_))
            {
                // 嵌套 zip 自身不在基线指纹里（指纹只算其内部文件）
                summary.nested_zip_unverified += 1;
            }
            let staged_name = format!("stage_{entry_key}.bin");
            let size = copy_local_verified(&abs, &dir.join("staging").join(&staged_name), &hash)?;
            // 导入后「内容有变化」的条目默认全部勾选
            meta.selected.insert(entry.clone());
            meta.staged.insert(
                entry.clone(),
                StagedMeta {
                    staged_name,
                    source_name: file_name_of(entry),
                    source_path: abs.to_string_lossy().to_string(),
                    size,
                },
            );
            summary.changed += 1;
        } else {
            let material_name = format!("mat_{entry_key}.bin");
            let size = copy_local_verified(&abs, &dir.join("materials").join(&material_name), &hash)?;
            meta.local_source
                .get_or_insert_with(LocalSourceMeta::default)
                .materials
                .insert(
                    entry.clone(),
                    MaterialMeta {
                        material_name,
                        source_rel: entry.clone(),
                        size,
                    },
                );
            summary.unchanged += 1;
        }
    }

    // 预估 file_hashes 写库体积：双键格式每个文件写一条路径键 + 一条 basename 键
    //（根目录条目两键同名只占一条），再加 64 位 hash 与 JSON 结构开销。
    let estimated: usize = entries
        .iter()
        .map(|e| e.len() + entry_basename(e).len() + 84)
        .sum::<usize>()
        + 2;
    summary.file_hash_budget_exceeded = estimated > FILE_HASHES_MAX_BYTES;
    summary.matched = matched_set.len();

    let local = LocalSourceMeta {
        root_path: root_path.to_string(),
        // 调用方（自动套用 / 手动导入）会覆盖为该根目录的真实来路
        root_kind: String::new(),
        imported_at: now_secs(),
        materials: meta
            .local_source
            .as_ref()
            .map(|l| l.materials.clone())
            .unwrap_or_default(),
        summary: summary.clone(),
    };
    meta.local_source = Some(local);
    meta.selection_initialized = true;
    meta.built = None;
    meta.updated_at = now_secs();
    save_meta(dir, &meta)?;
    Ok((meta, summary))
}

/// 底包读取缓存：zip 句柄 + 「归一化条目路径 → 原始条目序号」索引。
///
/// 底包是作者之前发布的原始压缩包，条目名可能还带安装根前缀
/// （`BepInEx/plugins/`、`CustomMissions/` 等）。因此不能拿归一化后的路径
/// 直接 `by_name` 查——那对历史包必然查不到。索引在这里按与写包一致的
/// `normalize_entry_path` 建立，取字节时再按序号回到原始条目名。
struct BaseArchive {
    zip: ZipArchive<File>,
    by_normalized: HashMap<String, usize>,
    /// 底包内的目录条目（归一化后、带末尾 `/`），用于重建时保留空目录。
    dir_paths: BTreeSet<String>,
    /// 所有文件条目名是否已等于归一化结果。
    /// 发布端据此决定「只改清单」还是「连包一起重打」。
    paths_normalized: bool,
}

fn open_base_archive(dir: &Path, category: &str, mod_key: &str) -> Result<BaseArchive, String> {
    let base_path = dir.join("base.zip");
    let file =
        File::open(&base_path).map_err(|e| format!("打开底包失败，无法取回原内容: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("底包不是有效 zip: {e}"))?;
    let mut by_normalized: HashMap<String, usize> = HashMap::new();
    let mut dir_paths: BTreeSet<String> = BTreeSet::new();
    let mut paths_normalized = true;
    for i in 0..zip.len() {
        let (raw_name, is_dir) = {
            let entry = zip
                .by_index_raw(i)
                .map_err(|e| format!("读取底包条目失败（#{i}）: {e}"))?;
            (
                std::str::from_utf8(entry.name_raw()).ok().map(str::to_string),
                entry.is_dir(),
            )
        };
        let Some(raw_name) = raw_name else { continue };
        if is_dir || raw_name.ends_with('/') {
            let norm = normalize_entry_path(category, mod_key, &raw_name);
            let norm = norm.trim_end_matches('/');
            if !norm.is_empty() {
                dir_paths.insert(format!("{norm}/"));
            }
            continue;
        }
        let name = normalize_entry_path(category, mod_key, &raw_name);
        if name.is_empty() || name.ends_with('/') {
            continue;
        }
        if name != raw_name {
            paths_normalized = false;
        }
        // 归一后同名只取第一个：与 build_package_inner 的写包去重口径保持一致
        by_normalized.entry(name).or_insert(i);
    }
    Ok(BaseArchive {
        zip,
        by_normalized,
        dir_paths,
        paths_normalized,
    })
}

/// 从工作区底包按（归一化后的）包内路径读取原始字节。
/// 用于「取消勾选」的变化条目回退到基线原样（本地目录里是作者的新内容，
/// 不能直接当作基线）。
fn read_base_entry(
    cache: &mut Option<BaseArchive>,
    dir: &Path,
    category: &str,
    mod_key: &str,
    path: &str,
) -> Result<Vec<u8>, String> {
    if cache.is_none() {
        *cache = Some(open_base_archive(dir, category, mod_key)?);
    }
    let base = cache
        .as_mut()
        .ok_or_else(|| "底包未打开，无法取回原内容".to_string())?;
    let idx = base
        .by_normalized
        .get(path)
        .copied()
        .ok_or_else(|| format!("底包中找不到条目，无法恢复原内容：{path}"))?;
    let mut entry = base
        .zip
        .by_index(idx)
        .map_err(|e| format!("读取底包条目失败（{path}）: {e}"))?;
    let mut buf = Vec::new();
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取底包条目失败（{path}）: {e}"))?;
    Ok(buf)
}

/// 本地目录打包时，清单里需要从底包取回原字节的条目：
/// - 已暂存但未勾选的变化条目（作者本地是新内容，不能当基线）；
/// - 本地目录里没有、也没有暂存/新增内容的条目（视为「保留原文件」，不要求作者补齐本地目录）。
/// 只有这些条目需要底包；被剔除/新增未勾选的条目不在其中。
pub(crate) fn local_base_fallback_paths(meta: &WorkspaceMeta) -> HashSet<String> {
    let Some(local) = meta.local_source.as_ref() else {
        return HashSet::new();
    };
    let selected = selected_paths(meta);
    let Ok(paths) = normalized_manifest_paths(&meta.manifest, &meta.category, &meta.mod_key)
    else {
        return HashSet::new();
    };
    let file_set: HashSet<String> = paths
        .into_iter()
        .filter(|p| !p.ends_with('/'))
        .collect();
    file_set
        .into_iter()
        .filter(|p| !meta.excluded.contains(p.as_str()))
        .filter(|p| match meta.staged.get(p.as_str()) {
            Some(_) => !selected.contains(p.as_str()),
            None => !local.materials.contains_key(p.as_str()),
        })
        .collect()
}

/// 用本地目录导入的 materials + staged 覆盖 manifest 全量条目，缺字节的条目回退到底包原样。
///
/// 勾选语义：已勾选的 staged 用本地新内容；未勾选的 staged 回退到底包里的
/// 基线原样。本地目录里没找到、也没有选中替换的条目同样从底包取原样
/// （即「保留原文件 / 未改动」），不会因为本地缺文件而阻断整包构建。
/// 只有选中替换、但本地取不到字节的条目才会报错，错误带具体路径。
pub(crate) fn build_from_local_source(
    dir: &Path,
    mut meta: WorkspaceMeta,
) -> Result<(WorkspaceMeta, BuiltMeta), String> {
    let local = meta
        .local_source
        .clone()
        .ok_or_else(|| "本地目录导入不存在".to_string())?;
    // 只有已勾选的变化条目才用本地新内容；未勾选的保持基线原样
    let selected = selected_paths(&meta);
    let mut manifest_paths =
        normalized_manifest_paths(&meta.manifest, &meta.category, &meta.mod_key)?;
    if manifest_paths.is_empty() {
        return Err("当前文件记录没有清单，无法按本地目录打包".to_string());
    }
    // 新增条目：已勾选且未被剔除的追加进打包路径（未勾选/被剔除的不进包，也不进清单）
    let added_selected: Vec<String> = meta
        .added
        .iter()
        .filter(|p| selected.contains(p.as_str()) && !meta.excluded.contains(p.as_str()))
        .cloned()
        .collect();
    for p in &added_selected {
        if !manifest_paths.iter().any(|m| m == p) {
            manifest_paths.push(p.clone());
        }
    }
    let file_set: HashSet<String> = manifest_paths
        .iter()
        .filter(|p| !p.ends_with('/'))
        .cloned()
        .collect();

    let mut unknown: Vec<String> = meta
        .staged
        .keys()
        .filter(|p| {
            !file_set.contains(p.as_str())
                && !meta.excluded.contains(p.as_str())
                && !meta.added.contains(p.as_str())
        })
        .cloned()
        .collect();
    if !unknown.is_empty() {
        unknown.sort();
        return Err(format!(
            "以下已暂存条目不在文件清单中，请撤销后重试：{}",
            unknown.join("、")
        ));
    }

    // 未勾选的变化条目、以及本地目录缺失的条目，都要从底包取回基线原样。
    // 命令层已按需准备底包（工作区 → 缓存 → 下载），这里再校验一次，
    // 避免 base.zip 缺失/被替换后打到一半才失败。
    let base_fallback = local_base_fallback_paths(&meta);
    let needs_base = !base_fallback.is_empty();
    if needs_base {
        let base_path = dir.join("base.zip");
        if !base_path.is_file() || !hash_matches(&base_path, &meta.base_file_hash) {
            return Err(
                "保留未改动条目需要底包取回原内容，但本地底包不可用；请重新打开面板后重试"
                    .to_string(),
            );
        }
    }

    let out_path = dir.join("package.zip");
    let tmp_path = dir.join("package.zip.tmp");
    let _ = fs::remove_file(&tmp_path);

    // 底包条目名是否已归一：决定发布端能不能「只改清单」。
    // 历史前缀包必须连包一起重打，否则云端清单与包内条目会脱节。
    // 没有底包时无法确认，按「未归一」保守处理（发布端会改走重打包路径）。
    let mut base_archive: Option<BaseArchive> = if dir.join("base.zip").is_file() {
        Some(open_base_archive(dir, &meta.category, &meta.mod_key)?)
    } else {
        None
    };
    let base_paths_normalized = base_archive
        .as_ref()
        .map(|a| a.paths_normalized)
        .unwrap_or(false);
    // 底包里的目录条目（尤其只有空目录、没有文件的）可能不在旧清单中，
    // 重建时补回 manifest_paths，保证新包与清单都保留原目录集合。
    if let Some(archive) = base_archive.as_ref() {
        for p in &archive.dir_paths {
            if !manifest_paths.iter().any(|m| m == p) {
                manifest_paths.push(p.clone());
            }
        }
    }
    let written_files = {
        let out_file = File::create(&tmp_path)
            .map_err(|e| format!("创建新压缩包失败: {e}"))?;
        let mut writer = ZipWriter::new(out_file);
        let options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut seen: HashSet<String> = HashSet::new();
        let mut written_files = 0usize;
        for path in &manifest_paths {
            if !seen.insert(path.clone()) {
                continue;
            }
            // 目录条目保留（含空目录）：写回新包，安装端据此创建目录，
            // 卸载时清单里的目录条目才有实际对应物。
            if path.ends_with('/') {
                if meta.excluded.contains(path.as_str()) {
                    continue;
                }
                writer
                    .add_directory(path.as_str(), options)
                    .map_err(|e| format!("写入目录条目失败（{path}）: {e}"))?;
                continue;
            }
            if meta.excluded.contains(path.as_str()) {
                continue;
            }
            let data = if let Some(staged) = meta.staged.get(path.as_str()) {
                if selected.contains(path.as_str()) {
                    // 已勾选：用本地目录的新内容
                    let src = dir.join("staging").join(&staged.staged_name);
                    fs::read(&src).map_err(|e| {
                        format!("读取选中替换条目失败（{path} → {}）: {e}", src.display())
                    })?
                } else {
                    // 未勾选：保持基线原样，从底包取原始字节
                    read_base_entry(
                        &mut base_archive,
                        dir,
                        &meta.category,
                        &meta.mod_key,
                        path,
                    )?
                }
            } else if let Some(material) = local.materials.get(path.as_str()) {
                let src = dir.join("materials").join(&material.material_name);
                fs::read(&src)
                    .map_err(|e| format!("读取导入文件失败（{path} → {}）: {e}", src.display()))?
            } else {
                // 本地目录没有该条目、也没有选中替换：保留线上基线原样
                read_base_entry(
                    &mut base_archive,
                    dir,
                    &meta.category,
                    &meta.mod_key,
                    path,
                )?
            };
            writer
                .start_file(path.clone(), options)
                .map_err(|e| format!("写入条目失败（{path}）: {e}"))?;
            writer
                .write_all(&data)
                .map_err(|e| format!("写入条目内容失败（{path}）: {e}"))?;
            written_files += 1;
        }
        writer
            .finish()
            .map_err(|e| format!("生成新压缩包失败: {e}"))?;
        written_files
    };
    if written_files == 0 {
        let _ = fs::remove_file(&tmp_path);
        return Err("移除后包内没有任何文件，已取消生成".to_string());
    }

    if let Err(e) = fs::rename(&tmp_path, &out_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("保存新压缩包失败: {e}"));
    }

    let mut verify = ZipArchive::new(
        File::open(&out_path).map_err(|e| format!("打开新压缩包失败: {e}"))?,
    )
    .map_err(|e| format!("新压缩包不是有效的 zip: {e}"))?;
    let all_paths = collect_manifest_paths(&mut verify)?;
    let only_files: Vec<String> = all_paths
        .iter()
        .filter(|p| !p.ends_with('/'))
        .cloned()
        .collect();
    let mut hashes: HashMap<String, String> = HashMap::new();
    let mut path_hashes: HashMap<String, String> = HashMap::new();
    hash_archive(
        &mut verify,
        &meta.category,
        &meta.mod_key,
        &mut hashes,
        &mut path_hashes,
        0,
    )?;
    drop(verify);

    // all_paths 来自刚生成的新包（含目录条目）；清单与之保持一致。
    // 目录条目把清单撑过上限时，与 build_package_inner 一致降级为仅文件清单，
    // 不因保留目录集合导致整次保存失败。
    let mut manifest = resolve_manifest(&meta.manifest, &all_paths, false);
    if manifest.chars().count() > MANIFEST_MAX_CHARS {
        manifest = resolve_manifest(&meta.manifest, &only_files, false);
    }
    if manifest.chars().count() > MANIFEST_MAX_CHARS {
        let _ = fs::remove_file(&out_path);
        return Err(format!(
            "压缩包内文件数过多，清单长度超过 {MANIFEST_MAX_CHARS} 字符"
        ));
    }
    let manifest_dirty = meta.manifest_dirty || manifest != meta.manifest;

    let file_size = fs::metadata(&out_path)
        .map_err(|e| format!("读取新压缩包大小失败: {e}"))?
        .len();
    let file_hash = sha256_file(&out_path)?;
    // 双键写入：basename 键供旧客户端按名查询，路径键用于区分同名不同目录。
    let merged_hashes = crate::db::hash::merge_file_hashes(&hashes, &path_hashes);
    let file_hashes = serde_json::to_string(&merged_hashes).unwrap_or_else(|_| "{}".to_string());
    let file_name = if meta.base_file_name.trim().is_empty() {
        format!("{}_{}.zip", meta.mod_key, meta.lang_code)
    } else {
        meta.base_file_name.clone()
    };
    let replaced = meta
        .staged
        .keys()
        .filter(|p| {
            selected.contains(p.as_str())
                && !meta.excluded.contains(p.as_str())
                && !meta.added.contains(p.as_str())
        })
        .count();
    let added = added_selected.len();
    // 是否真的变化以最终包与基线的逐文件指纹比对为准（新增后又剔除的文件不算变化）；
    // 没有基线指纹可用时才退回按操作痕迹判断。清单归一化由 manifest_dirty 单独处理。
    let baseline = baseline_fingerprints(dir, &meta);
    let changed = detect_changed(
        &baseline,
        &hashes,
        &path_hashes,
        replaced > 0 || added > 0 || !meta.excluded.is_empty(),
    );
    let built = BuiltMeta {
        file_name,
        file_size,
        file_hash,
        file_hashes,
        manifest: manifest.clone(),
        replaced,
        added,
        changed,
        manifest_dirty,
        category: meta.category.clone(),
        base_paths_normalized,
    };
    meta.manifest = manifest;
    meta.manifest_dirty = manifest_dirty;
    // 记录本次打包核对的底包形态（原始条目名 → 是否已归一），供发布端二次校验。
    meta.base_paths_normalized = Some(base_paths_normalized);
    meta.built = Some(built.clone());
    meta.updated_at = now_secs();
    save_meta(dir, &meta)?;
    Ok((meta, built))
}

// ── 命令 ────────────────────────────────────────────────────


#[derive(Serialize, Default)]
pub(crate) struct AutoApplyResult {
    /// already：草稿已导入；import：按目录扫描；remembered：按逐条记住的文件；
    /// error：没有可用来源（游戏目录未配置/无效等）
    pub(crate) mode: String,
    pub(crate) applied: usize,
    #[serde(default)]
    pub(crate) skipped: Vec<String>,
    /// 实际使用的根目录（绝对路径）
    #[serde(default)]
    pub(crate) root_path: String,
    /// 根目录来路：game_root / custom_missions / custom_missions2 / plugins / manual
    #[serde(default)]
    pub(crate) root_kind: String,
    /// 按类别推导出的期望根目录（安装时的 target_dir）
    #[serde(default)]
    pub(crate) expected_root: String,
    /// mode=error 时的具体原因
    #[serde(default)]
    pub(crate) error: String,
    /// 机器可读的错误分类：GAME_PATH_MISSING / GAME_PATH_INVALID /
    /// GAME_PATH_READ_FAILED / ROOT_MISSING。前端据此本地化并决定是否显示
    /// 「去设置」入口，而不是把后端中文原样抛给其他语言的用户。
    #[serde(default)]
    pub(crate) error_code: String,
    /// 上次选错根目录、本次自动切换到推导根目录时的原路径
    #[serde(default)]
    pub(crate) fallback_from: String,
}

/// 打开面板后直接按游戏路径读取文件，不再有任何「选择来源」步骤。
///
/// 根目录只由 `game_path` + `category` 推导（安装时的 target_dir）：
/// composite=游戏根、v1=CustomMissions、v2=CustomMissions2/<mod_key>、
/// dll=BepInEx/plugins。manifest 条目严格相对该目录，因此来源唯一确定。
pub(crate) fn auto_apply_inner(
    dir: &Path,
    mut meta: WorkspaceMeta,
    _local_dir_hint: Option<String>,
    game_path: Result<String, String>,
) -> Result<(WorkspaceMeta, AutoApplyResult), String> {
    let mut result = AutoApplyResult::default();

    // 游戏路径是唯一来源；取不到时给明确错误，由前端提供「去设置」入口，
    // 不再让作者去选目录。
    let game = match game_path {
        Ok(p) => p,
        Err(e) => {
            result.mode = "error".to_string();
            if e == "GAME_DIR_INVALID" {
                result.error_code = "GAME_PATH_MISSING".to_string();
                result.error = "请先在设置里配置游戏路径".to_string();
            } else {
                result.error_code = "GAME_PATH_READ_FAILED".to_string();
                result.error = format!("读取游戏路径失败：{e}");
            }
            return Ok((meta, result));
        }
    };
    let (root, kind) = match derive_local_root(&meta.category, &meta.mod_key, Some(&game)) {
        Ok(v) => v,
        Err(e) => {
            result.mode = "error".to_string();
            result.error_code = "GAME_PATH_INVALID".to_string();
            result.error = e;
            return Ok((meta, result));
        }
    };
    result.expected_root = root.to_string_lossy().to_string();
    result.root_kind = kind.to_string();

    if !root.is_dir() {
        result.mode = "error".to_string();
        result.error_code = "ROOT_MISSING".to_string();
        result.error = format!(
            "按 {} 规则应读取 {}，但该目录不存在；请确认游戏已安装该模组",
            category_root_label(&meta.category),
            root.display()
        );
        return Ok((meta, result));
    }

    // 已构建过待保存的包：不重扫，避免打开面板时把补丁包作废。
    if meta.built.is_some() {
        if let Some(local) = meta.local_source.as_ref() {
            result.mode = "already".to_string();
            result.root_path = local.root_path.clone();
            if !local.root_kind.is_empty() {
                result.root_kind = local.root_kind.clone();
            }
            if !local.summary.expected_root.is_empty() {
                result.expected_root = local.summary.expected_root.clone();
            }
            return Ok((meta, result));
        }
    }

    // 作者新增的条目不能被重扫清空：保留它们，按记住的源文件回填。
    if !meta.added.is_empty() {
        result.root_path = meta
            .local_source
            .as_ref()
            .map(|l| l.root_path.clone())
            .unwrap_or_default();
        result.root_kind = meta
            .local_source
            .as_ref()
            .map(|l| l.root_kind.clone())
            .unwrap_or_default();
        let mut applied = 0usize;
        let mut dirty = false;
        for (path, staged) in meta.staged.clone() {
            let src = PathBuf::from(&staged.source_path);
            if !staged.source_path.is_empty() && src.is_file() {
                match stage_new_file(dir, &path, &src) {
                    Ok(updated) => {
                        meta.staged.insert(path.clone(), updated);
                        meta.selected.insert(path.clone());
                        applied += 1;
                        dirty = true;
                    }
                    Err(e) => result.skipped.push(format!("{path}: {e}")),
                }
            } else if dir.join("staging").join(&staged.staged_name).is_file() {
                meta.selected.insert(path.clone());
                applied += 1;
                dirty = true;
            } else {
                meta.staged.remove(&path);
                meta.selected.remove(&path);
                result.skipped.push(path);
                dirty = true;
            }
        }
        if dirty {
            meta.selection_initialized = true;
            meta.built = None;
            meta.updated_at = now_secs();
            save_meta(dir, &meta)?;
        }
        result.applied = applied;
        result.mode = if applied > 0 { "remembered" } else { "none" }.to_string();
        return Ok((meta, result));
    }

    // 全量按清单逐条映射 + 指纹比对（每次打开都重新校验，文件被移走会逐条列出）。
    let expected = result.expected_root.clone();
    let requested_root = expected.clone();
    let (mut imported, summary) = import_directory_inner(dir, meta, &requested_root)?;
    let effective_root = imported
        .local_source
        .as_ref()
        .map(|l| l.root_path.clone())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| requested_root.clone());
    imported.local_dir = effective_root.clone();
    if let Some(local) = imported.local_source.as_mut() {
        local.root_kind = kind.to_string();
        local.summary.expected_root = expected;
    }
    result.mode = "import".to_string();
    result.applied = summary.changed;
    result.root_path = effective_root;
    Ok((imported, result))
}

