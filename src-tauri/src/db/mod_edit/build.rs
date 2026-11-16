//! 打包构建：指纹基线比对、整包生成与产物校验。

use super::*;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::Path;

use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub(crate) const MANIFEST_MAX_CHARS: usize = 30000;

/// 发布前确认磁盘上的 package.zip 与打包记录完全一致（防止并发覆盖/外部改动）。
pub(crate) fn verify_built_package(path: &Path, built: &BuiltMeta) -> Result<(), String> {
    let size = fs::metadata(path)
        .map_err(|e| format!("读取打包文件失败: {e}"))?
        .len();
    if size != built.file_size {
        return Err("本地打包文件大小与打包记录不一致，请重新打包".to_string());
    }
    if !hash_matches(path, &built.file_hash) {
        return Err("本地打包文件内容与打包记录不一致，请重新打包".to_string());
    }
    Ok(())
}

/// 递归遍历 zip 计算逐文件指纹，同时产出两套口径：
/// - `by_name`：归一后 basename 小写 → sha256，与历史 `file_hashes` 的对外格式一致；
/// - `by_path`：归一后安装可见路径（相对安装根）小写 → sha256，用于内容变化判定。
///
/// 变化判定必须带目录维度：只按 basename 建表时，同名不同目录的文件会互相覆盖，
/// 「改了内容仍判为未变化」从而走幂等分支丢弃改动。归一规则与写包时用的
/// `normalize_entry_path` 完全一致，保证 base.zip 与 package.zip 的键可直接比较；
/// 嵌套 zip 的条目按解压后的落点计算（不带 zip 自身路径前缀），与安装端展开语义一致。
pub(crate) fn hash_archive<R: Read + Seek>(
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
        let mut f = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        if name.to_ascii_lowercase().ends_with(".zip") {
            crate::db::subscribe::with_nested_zip_archive(&mut f, |inner| {
                hash_archive(inner, category, mod_key, by_name, by_path, depth + 1)?;
                Ok(())
            })?;
            continue;
        }
        // 与写包/清单同一套归一：历史包的 BepInEx/plugins、CustomMissions、
        // CustomMissions2/<mod_key> 前缀都在这里剥掉，两侧键才对得上。
        let norm = normalize_entry_path(category, mod_key, &name);
        if norm.is_empty() || norm.ends_with('/') {
            continue;
        }
        let mut hasher = Sha256::new();
        std::io::copy(&mut f, &mut hasher)
            .map_err(|e| format!("读取 zip 条目内容失败: {e}"))?;
        let hash = hex::encode(hasher.finalize());
        let base = norm.rsplit('/').next().unwrap_or(&norm).to_lowercase();
        by_name.insert(base, hash.clone());
        by_path.insert(norm.to_lowercase(), hash);
    }
    Ok(())
}

/// 计算基线（底包）指纹，返回 (basename 口径, 路径口径)。
/// 优先直接对 base.zip 计算（兼容历史数据没存 file_hashes 的情况）；
/// 底包不可用/与记录不一致时退回工作区里的基线 file_hashes——此时只有
/// basename 口径（新格式的路径键在这里不参与 diff），路径口径为 `None`，
/// 调用方必须退化为保守比较（同名多条一律视为已变化）。
///
/// 注意：这里刻意只取 basename 视图。`changed` 判定是「是否要向用户要一次
/// 新版本」的保守开关，宁可多报一次变化，也不能靠不完整的路径表误判为未变化。
pub(crate) fn baseline_fingerprints(
    dir: &Path,
    meta: &WorkspaceMeta,
) -> (HashMap<String, String>, Option<HashMap<String, String>>) {
    let base_path = dir.join("base.zip");
    if base_path.is_file() && hash_matches(&base_path, &meta.base_file_hash) {
        if let Ok(file) = File::open(&base_path) {
            if let Ok(mut archive) = ZipArchive::new(file) {
                let mut by_name = HashMap::new();
                let mut by_path = HashMap::new();
                if hash_archive(
                    &mut archive,
                    &meta.category,
                    &meta.mod_key,
                    &mut by_name,
                    &mut by_path,
                    0,
                )
                .is_ok()
                {
                    return (by_name, Some(by_path));
                }
            }
        }
    }
    (
        crate::db::hash::parse_file_hashes_opt(Some(meta.base_file_hashes.clone())),
        None,
    )
}

/// 包内是否存在同名不同目录的文件（basename 口径无法区分）。
fn has_duplicate_basenames(by_path: &HashMap<String, String>) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    by_path.keys().any(|p| {
        let base = p.rsplit('/').next().unwrap_or(p);
        !seen.insert(base.to_string())
    })
}

/// 内容是否真的变化。优先用路径口径精确比较；没有路径口径（底包缺失，
/// 只剩历史 basename 指纹）时退化：包内存在同名不同目录则无法可靠比较，
/// 保守判为有变化（宁可多传一次，也不能把改动判成幂等而丢弃）。
pub(crate) fn detect_changed(
    baseline: &(HashMap<String, String>, Option<HashMap<String, String>>),
    by_name: &HashMap<String, String>,
    by_path: &HashMap<String, String>,
    no_baseline_changed: bool,
) -> bool {
    let (base_name, base_path) = baseline;
    match base_path {
        Some(base_paths) => base_paths != by_path,
        None if base_name.is_empty() => no_baseline_changed,
        None => has_duplicate_basenames(by_path) || base_name != by_name,
    }
}

/// 打包并返回工作区元数据与构建结果（纯本地，不碰数据库）。
pub(crate) fn build_package_inner(dir: &Path, mut meta: WorkspaceMeta) -> Result<(WorkspaceMeta, BuiltMeta), String> {
    let base_path = dir.join("base.zip");
    let out_path = dir.join("package.zip");
    let tmp_path = dir.join("package.zip.tmp");
    let _ = fs::remove_file(&tmp_path);

    if !base_path.is_file() {
        return Err(
            "尚未下载底包，也没有导入本地目录；请先下载底包或使用「从本地目录选择」".to_string(),
        );
    }
    // 打包前校验：base.zip 必须仍是该工作区记录的基线，避免打开后被替换的
    // 本地原包参与打包，导致新包与 DB 乐观锁基线（base_file_hash）对不上。
    if !hash_matches(&base_path, &meta.base_file_hash) {
        return Err("本地原压缩包与文件记录不一致（可能已被替换），请重新打开工作区".to_string());
    }

    let base_file = fs::File::open(&base_path).map_err(|e| format!("打开原压缩包失败: {e}"))?;
    let mut archive = ZipArchive::new(base_file).map_err(|e| format!("原文件不是有效 zip: {e}"))?;
    let out_file = fs::File::create(&tmp_path).map_err(|e| format!("创建新压缩包失败: {e}"))?;
    let mut writer = ZipWriter::new(out_file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // 只有「已勾选」的 staged 条目才用本地新内容替换；未勾选的条目原样透传，
    // 也就是保持基线内容，不会进入本次更新。
    let selected = selected_paths(&meta);

    // 写包时统计**实际命中**的 staged key：staging 里存在但原包里找不到的
    // 条目不能静默跳过（否则 replaced 会按未命中数量虚计）。
    let mut hit_staged: HashSet<String> = HashSet::new();
    let mut written_files = 0usize;
    // 归一后可能出现两个原始条目映射到同一路径（旧包同时含带前缀与不带前缀的副本），
    // 只保留第一个，避免新包出现重复条目、manifest 集合去重后与 zip 不一致。
    let mut written_names: HashSet<String> = HashSet::new();
    // 底包文件条目名是否已经就是归一化形态：发布端据此决定能否「只改清单」
    let mut base_paths_normalized = true;
    for i in 0..archive.len() {
        let entry = archive
            .by_index_raw(i)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        let raw_name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| format!("压缩包内存在非 UTF-8 文件名，暂不支持此包：条目 #{i}"))?
            .to_string();
        if raw_name.is_empty() {
            continue;
        }
        // 目录条目保留（含只有空目录、没有文件的条目）：归一后写回新包，
        // 否则重建一次就会把目录集合丢掉，清单里的目录与卸载清空目录都会失准。
        if entry.is_dir() || raw_name.ends_with('/') {
            let dir_name = normalize_entry_path(&meta.category, &meta.mod_key, &raw_name);
            let dir_name = dir_name.trim_end_matches('/');
            if dir_name.is_empty() {
                continue;
            }
            let name = format!("{dir_name}/");
            if !written_names.insert(name.clone()) {
                continue;
            }
            writer
                .add_directory(name.as_str(), options)
                .map_err(|e| format!("写入目录条目失败（{name}）: {e}"))?;
            continue;
        }
        // 条目名必须是「相对安装 target_dir」：旧包里的 BepInEx/plugins/、CustomMissions/ 等
        // 父级前缀在这里统一剥掉，保证新包与 manifest 的解压落点正确。
        let name = normalize_entry_path(&meta.category, &meta.mod_key, &raw_name);
        if name.is_empty() {
            continue;
        }
        if name != raw_name {
            // 历史包把安装根前缀写进了条目名：本次新包会改名，清单也必须连包一起重打
            base_paths_normalized = false;
        }
        // 被剔除的条目直接跳过：只影响新包，不会删除订阅者已安装的文件
        if !name.ends_with('/') && meta.excluded.contains(&name) {
            continue;
        }
        if !written_names.insert(name.clone()) {
            continue;
        }
        // 未勾选的 staged 条目保留基线原样：不做替换，直接透传
        let staged = if selected.contains(&name) {
            meta.staged.get(&name).cloned()
        } else {
            None
        };
        if let Some(staged) = staged {
            hit_staged.insert(name.clone());
            let staged_path = dir.join("staging").join(&staged.staged_name);
            let data = fs::read(&staged_path)
                .map_err(|e| format!("读取替换文件失败（{}）: {e}", staged.source_name))?;
            writer
                .start_file(name.clone(), options)
                .map_err(|e| format!("写入新压缩包失败（{name}）: {e}"))?;
            writer
                .write_all(&data)
                .map_err(|e| format!("写入新压缩包失败（{name}）: {e}"))?;
        } else {
            // 未替换条目原样透传：不解压、不重压缩，元信息保持
            writer
                .raw_copy_file_rename(entry, name.clone())
                .map_err(|e| format!("透传 zip 条目失败（{name}）: {e}"))?;
        }
        if !name.ends_with('/') {
            written_files += 1;
        }
    }

    // 新增条目不在原包中：从 staging 写入（未勾选 / 被剔除的不写，等同于未加入）
    let mut added_paths: Vec<String> = meta
        .added
        .iter()
        .filter(|p| selected.contains(p.as_str()) && !meta.excluded.contains(p.as_str()))
        .cloned()
        .collect();
    added_paths.sort();
    let added_written = added_paths.len();
    for path in &added_paths {
        let Some(staged) = meta.staged.get(path) else {
            drop(writer);
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("新增条目缺少打包字节：{path}"));
        };
        let staged_path = dir.join("staging").join(&staged.staged_name);
        let data = fs::read(&staged_path)
            .map_err(|e| format!("读取新增文件失败（{}）: {e}", staged.source_name))?;
        writer
            .start_file(path.clone(), options)
            .map_err(|e| format!("写入新压缩包失败（{path}）: {e}"))?;
        writer
            .write_all(&data)
            .map_err(|e| format!("写入新压缩包失败（{path}）: {e}"))?;
        written_files += 1;
    }

    if written_files == 0 {
        drop(writer);
        let _ = fs::remove_file(&tmp_path);
        return Err("移除后包内没有任何文件，已取消生成".to_string());
    }

    // staging 中若有已勾选条目在原包里找不到（例如原包被替换/条目被改名），直接报错
    // 并列出具体路径，不能静默 continue 生成一个缺文件的包。未勾选条目保持基线，
    // 原包里没有就自然不写入，不算缺失；本次新增的条目本来就不在原包中。
    let mut missing: Vec<String> = meta
        .staged
        .keys()
        .filter(|p| {
            selected.contains(p.as_str())
                && !hit_staged.contains(p.as_str())
                && !meta.excluded.contains(p.as_str())
                && !meta.added.contains(p.as_str())
        })
        .cloned()
        .collect();
    if !missing.is_empty() {
        missing.sort();
        drop(writer);
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "以下替换条目已不在原压缩包中，无法打包（请撤销后重新选择）：{}",
            missing.join("、")
        ));
    }

    let finished = writer
        .finish()
        .map_err(|e| format!("完成新压缩包失败: {e}"))?;
    drop(finished);
    if let Err(e) = fs::rename(&tmp_path, &out_path) {
        let _ = fs::remove_file(&out_path);
        fs::rename(&tmp_path, &out_path).map_err(|e2| format!("保存新压缩包失败: {e} / {e2}"))?;
    }

    let mut verify = ZipArchive::new(
        fs::File::open(&out_path).map_err(|e| format!("打开新压缩包失败: {e}"))?,
    )
    .map_err(|e| format!("新压缩包校验失败: {e}"))?;

    // 目录条目也一并收集：manifest 发布端本就带末尾 /，只收文件会让重建后的
    // 清单丢掉目录集合（文件列表少显示目录、卸载清不掉空目录）。
    let all_paths = collect_manifest_paths(&mut verify)?;
    let file_paths: Vec<String> = all_paths
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

    // 新包保留目录条目，清单也按「目录 + 文件」重建；与工作区内的归一清单
    // 一致时原样保留。目录条目把清单撑过上限时降级为仅文件条目，
    // 避免为了目录集合导致整次保存失败。
    let mut manifest = resolve_manifest(&meta.manifest, &all_paths, false);
    if manifest.chars().count() > MANIFEST_MAX_CHARS {
        manifest = resolve_manifest(&meta.manifest, &file_paths, false);
    }
    if manifest.chars().count() > MANIFEST_MAX_CHARS {
        return Err(format!(
            "文件清单超过 {MANIFEST_MAX_CHARS} 字符限制，无法保存"
        ));
    }
    let manifest_dirty = meta.manifest_dirty || manifest != meta.manifest;

    let file_size = fs::metadata(&out_path)
        .map_err(|e| format!("读取新压缩包大小失败: {e}"))?
        .len();
    let file_hash = sha256_file(&out_path)?;

    // 打包结束后再校验一次基线 sha256：打包期间 base.zip 若被并发操作/外部改动，
    // 新包内容已不可信，直接丢弃并要求重新打开工作区。
    if !hash_matches(&base_path, &meta.base_file_hash) {
        let _ = fs::remove_file(&out_path);
        return Err("打包期间原压缩包被改动，已丢弃新包，请重新打开工作区".to_string());
    }

    // 是否真的产生了内容变化，以「最终包逐文件指纹 ↔ 基线指纹」的完整比对为准，
    // 而不是看操作痕迹：例如新增后又剔除的文件，最终包与基线一致，不应强制升版本。
    // manifest 归一化（删目录条目/剥前缀）本身不改变文件内容，不算变化；
    // 由 publish 的 manifest_dirty 分支做清单条件更新。
    let replaced = hit_staged
        .iter()
        .filter(|p| !meta.added.contains(p.as_str()))
        .count();
    let changed = detect_changed(
        &baseline_fingerprints(dir, &meta),
        &hashes,
        &path_hashes,
        replaced > 0 || added_written > 0 || !meta.excluded.is_empty(),
    );
    // 双键写入：basename 键供旧客户端按名查询，路径键用于区分同名不同目录。
    let merged_hashes = crate::db::hash::merge_file_hashes(&hashes, &path_hashes);
    let file_hashes = serde_json::to_string(&merged_hashes).unwrap_or_else(|_| "{}".to_string());
    let file_name = if meta.base_file_name.trim().is_empty() {
        format!("{}_{}.zip", meta.mod_key, meta.lang_code)
    } else {
        meta.base_file_name.clone()
    };

    let built = BuiltMeta {
        file_name,
        file_size,
        file_hash,
        file_hashes,
        manifest: manifest.clone(),
        replaced,
        added: added_written,
        changed,
        manifest_dirty,
        category: meta.category.clone(),
        base_paths_normalized,
    };
    meta.manifest = manifest;
    meta.manifest_dirty = manifest_dirty;
    meta.built = Some(built.clone());
    meta.updated_at = now_secs();
    save_meta(dir, &meta)?;
    Ok((meta, built))
}
