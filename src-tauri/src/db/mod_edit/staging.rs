//! 暂存与草稿段：staging 文件落盘、回滚、构建期草稿应用。

use super::*;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// 取路径最后一段文件名（兼容 `/` 与 `\`）。
pub(crate) fn file_name_of(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Windows 路径大小写不敏感：`p` 位于 `base` 之下时返回 `/` 分隔的相对路径。
fn path_relative_under(p: &Path, base: &Path) -> Option<String> {
    let p = p.to_string_lossy().replace('\\', "/");
    let b = base.to_string_lossy().replace('\\', "/");
    let b = b.trim_end_matches('/').to_string();
    if b.is_empty() {
        return None;
    }
    let pl = p.to_lowercase();
    let bl = b.to_lowercase();
    if !pl.starts_with(&format!("{bl}/")) {
        return None;
    }
    let rel = p.get(b.len() + 1..)?.trim_matches('/').to_string();
    if rel.is_empty() {
        None
    } else {
        Some(rel)
    }
}

/// 校验新增条目的包内路径：复用安装/解压同一套 safe_zip_path，
/// 并额外拒绝目录条目与 Windows 无法表示的路径段。
pub(crate) fn validate_added_path(raw: &str) -> Result<String, String> {
    let safe = crate::db::subscribe::safe_zip_path(raw)?;
    if safe.ends_with('/') {
        return Err(format!("新增条目必须是文件而不是目录：{raw}"));
    }
    if !safe.split('/').all(is_windows_safe_component) {
        return Err(format!("新增条目路径含 Windows 非法字符或保留名：{raw}"));
    }
    Ok(safe)
}

/// 手动选择的文件 → 包内条目路径。规则与导入/选择侧保持一致：
/// dll 按 basename 平铺；v1 相对 CustomMissions；composite 相对游戏根；
/// v2 相对 mod 文件夹（优先本地导入根目录，其次游戏根目录）。
pub(crate) fn added_entry_target(
    meta: &WorkspaceMeta,
    src: &Path,
    game_path: Option<&Path>,
) -> Result<String, String> {
    let rel: String = match meta.category.as_str() {
        "dll" => file_name_of(&src.to_string_lossy()),
        "v1" => {
            let game = game_path
                .ok_or_else(|| "无法确定游戏目录，不能按 CustomMissions 规则计算路径".to_string())?;
            path_relative_under(src, &game.join("CustomMissions")).ok_or_else(|| {
                format!("文件不在 CustomMissions 目录下：{}", src.display())
            })?
        }
        "composite" => {
            let game = game_path
                .ok_or_else(|| "无法确定游戏目录，不能计算包内相对路径".to_string())?;
            path_relative_under(src, game)
                .ok_or_else(|| format!("文件不在游戏目录下：{}", src.display()))?
        }
        "v2" => {
            if let Some(local) = meta.local_source.as_ref() {
                if let Some(rel) = path_relative_under(src, Path::new(&local.root_path)) {
                    return validate_added_path(&rel);
                }
            }
            // manifest 相对 CustomMissions2/<mod_key>，不能相对游戏根相减，
            // 否则会把类别子目录也带进包内路径（重复拼接一次）。
            if meta.mod_key.trim().is_empty()
                || meta.mod_key.contains('/')
                || meta.mod_key.contains('\\')
                || meta.mod_key.contains("..")
            {
                return Err(format!(
                    "模组标识不合法，无法定位 CustomMissions2 下的模组目录：{}",
                    meta.mod_key
                ));
            }
            let game = game_path
                .ok_or_else(|| "无法确定游戏目录，不能计算包内相对路径".to_string())?;
            let mod_root = game.join("CustomMissions2").join(&meta.mod_key);
            path_relative_under(src, &mod_root).ok_or_else(|| {
                format!(
                    "v2 模组请选择 {} 目录下的文件，或先导入本地构建目录",
                    mod_root.display()
                )
            })?
        }
        _ => return Err("工作区缺少分类信息，请关闭后重新打开面板".to_string()),
    };
    validate_added_path(&rel)
}

/// 暂存文件落盘路径：按条目路径哈希命名（与 stage_new_file 同一口径）。
fn staged_file_path(dir: &Path, entry_path: &str) -> PathBuf {
    dir.join("staging").join(format!(
        "stage_{}.bin",
        hex::encode(Sha256::digest(entry_path.as_bytes()))
    ))
}

/// 批量 staging 的回滚记录：中途任一文件失败时，把本轮已写入的暂存文件
/// 清理/还原，避免留下 workspace.json 未记录的孤儿文件（或把先前有效的
/// 暂存内容覆盖成半成品）。meta 只在整批成功后才写盘，因此磁盘状态
/// 回滚到批次开始前即可恢复一致。
pub(crate) struct StagingRollback {
    dir: PathBuf,
    /// 批次开始前就存在的暂存文件备份：(备份路径, 正式路径)
    backups: Vec<(PathBuf, PathBuf)>,
    /// 本轮新建（此前不存在）的暂存文件
    created: Vec<PathBuf>,
}

impl StagingRollback {
    pub(crate) fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
            backups: Vec::new(),
            created: Vec::new(),
        }
    }

    /// 在 stage_new_file 之前登记：目标暂存文件已存在则先备份，否则记入新建。
    pub(crate) fn prepare(&mut self, entry_path: &str) -> Result<(), String> {
        let p = staged_file_path(&self.dir, entry_path);
        if p.is_file() {
            let bak = p.with_extension("bin.bak");
            fs::copy(&p, &bak).map_err(|e| format!("备份暂存文件失败: {e}"))?;
            self.backups.push((bak, p));
        } else {
            self.created.push(p);
        }
        Ok(())
    }

    /// 整批成功：丢弃备份。
    pub(crate) fn commit(self) {
        for (bak, _) in &self.backups {
            let _ = fs::remove_file(bak);
        }
    }

    /// 整批失败：还原被覆盖的暂存文件、删除新建的暂存文件。
    pub(crate) fn rollback(&self) {
        for (bak, p) in &self.backups {
            let _ = fs::rename(bak, p);
        }
        for p in &self.created {
            let _ = fs::remove_file(p);
            let _ = fs::remove_file(p.with_extension("bin.tmp"));
        }
    }
}

/// 把来源文件原子复制进 staging/，返回暂存元数据。
pub(crate) fn stage_new_file(dir: &Path, entry_path: &str, src: &Path) -> Result<StagedMeta, String> {
    let staged_name = format!(
        "stage_{}.bin",
        hex::encode(Sha256::digest(entry_path.as_bytes()))
    );
    let staging_dir = dir.join("staging");
    fs::create_dir_all(&staging_dir).map_err(|e| format!("创建暂存目录失败: {e}"))?;
    let staged_path = staging_dir.join(&staged_name);
    let tmp_path = staging_dir.join(format!("{staged_name}.tmp"));
    let _ = fs::remove_file(&tmp_path);
    if let Err(e) = fs::copy(src, &tmp_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("复制文件到工作区失败: {e}"));
    }
    if let Err(e) = fs::rename(&tmp_path, &staged_path) {
        let _ = fs::remove_file(&staged_path);
        fs::rename(&tmp_path, &staged_path)
            .map_err(|e2| format!("保存暂存文件失败: {e} / {e2}"))?;
    }
    let size = fs::metadata(&staged_path)
        .map_err(|e| format!("读取暂存文件失败: {e}"))?
        .len();
    let source_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(StagedMeta {
        staged_name,
        source_name,
        source_path: src.to_string_lossy().to_string(),
        size,
    })
}

/// 草稿里的一项本地文件（替换 / 新增）：包内路径 + 本机来源路径。
/// 前端编辑阶段只把它记在内存，构建时才一次性提交，避免每次点击都读改写
/// workspace.json（那才是「删除等半天」的来源）。
#[derive(Deserialize, Default, Clone)]
pub struct DraftFile {
    #[serde(default)]
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) source_path: String,
}

/// 前端草稿的完整快照。构建时整体应用，草稿阶段不产生任何后端调用。
#[derive(Deserialize, Default, Clone)]
pub struct DraftSegments {
    /// 本次采用的 staged 条目（勾选）
    #[serde(default)]
    pub(crate) selected: Vec<String>,
    /// 本次不打包的条目（前端统一叫「删除」）
    #[serde(default)]
    pub(crate) excluded: Vec<String>,
    /// 行级替换：path 必须是清单已有条目
    #[serde(default)]
    pub(crate) replaced: Vec<DraftFile>,
    /// 新增条目：path 不存在时追加到清单
    #[serde(default)]
    pub(crate) added: Vec<DraftFile>,
    /// 前端最近一次看到的 staged 条目集合。仅用于检测草稿是否落后于工作区：
    /// 面板收起后自动套用可能补入新检出的条目，旧草稿的 selected 会把这些
    /// 新条目静默丢掉（保存后走幂等分支，改动看起来“没发布”）。
    /// 缺省（旧前端）时不校验，保持兼容。
    #[serde(default)]
    pub(crate) staged_paths: Option<Vec<String>>,
}

/// 构建前把前端草稿一次性落到工作区：复制文件到 staging、更新 entries/集合。
/// 只有这里（以及打开面板）会写 workspace.json；编辑交互本身零后端调用。
pub(crate) fn apply_draft_segments(
    dir: &Path,
    meta: &mut WorkspaceMeta,
    draft: &DraftSegments,
) -> Result<Vec<String>, String> {
    // 0) 草稿一致性：工作区当前 staged 条目必须都出现在前端快照里。
    //    打开面板时后端可能刚把新检出的变化补进 staged，而前端沿用的是
    //    收起前的旧草稿；若继续按旧 selected 全量覆盖，新变化会被静默丢弃。
    //    这里明确拦截，让作者重新打开面板刷新草稿后再保存。
    if let Some(paths) = draft.staged_paths.as_ref() {
        let known: HashSet<&str> = paths.iter().map(|p| p.as_str()).collect();
        let mut stale: Vec<String> = meta
            .staged
            .keys()
            .filter(|p| !known.contains(p.as_str()))
            .cloned()
            .collect();
        if !stale.is_empty() {
            stale.sort();
            return Err(format!(
                "DRAFT_STALE: 工作区检测到草稿中未包含的变化条目（{}），请重新打开该语言的面板后再保存",
                stale.join("、")
            ));
        }
    }

    // 1) 行级替换：只允许清单里已有的条目；2) 新增。两步共用一个回滚批次：
    //    中途失败时还原/清理已写入的暂存文件，meta 未写盘，磁盘恢复一致。
    let mut duplicates: Vec<String> = Vec::new();
    let mut next_index = meta.entries.iter().map(|e| e.index).max().map(|m| m + 1).unwrap_or(0);
    let mut rollback = StagingRollback::new(dir);
    let batch = (|| -> Result<(), String> {
        for rep in &draft.replaced {
            if rep.path.trim().is_empty() || rep.source_path.trim().is_empty() {
                continue;
            }
            let path = normalize_entry_path(&meta.category, &meta.mod_key, &rep.path);
            if path.is_empty()
                || !meta
                    .entries
                    .iter()
                    .any(|e| e.path == path && !e.path.ends_with('/'))
            {
                return Err(format!("条目不在当前文件清单中，无法替换：{}", rep.path));
            }
            let src = PathBuf::from(&rep.source_path);
            let src_meta = fs::metadata(&src)
                .map_err(|e| format!("读取替换文件失败（条目 {path} → {}）: {e}", src.display()))?;
            if !src_meta.is_file() {
                return Err(format!("选择的路径不是文件（条目 {path}）：{}", src.display()));
            }
            rollback.prepare(&path)?;
            let staged = stage_new_file(dir, &path, &src)?;
            meta.staged.insert(path.clone(), staged);
            meta.selected.insert(path.clone());
            meta.excluded.remove(&path);
        }

        for add in &draft.added {
            if add.path.trim().is_empty() || add.source_path.trim().is_empty() {
                continue;
            }
            let path = validate_added_path(&normalize_entry_path(
                &meta.category,
                &meta.mod_key,
                &add.path,
            ))?;
            let src = PathBuf::from(&add.source_path);
            let src_meta = fs::metadata(&src)
                .map_err(|e| format!("读取新增文件失败（条目 {path} → {}）: {e}", src.display()))?;
            if !src_meta.is_file() {
                return Err(format!("选择的路径不是文件（条目 {path}）：{}", src.display()));
            }
            let existed = meta.entries.iter().any(|e| e.path == path);
            if existed && !meta.added.contains(&path) {
                duplicates.push(path.clone());
            }
            rollback.prepare(&path)?;
            let staged = stage_new_file(dir, &path, &src)?;
            if !existed {
                meta.entries.push(EntryMeta {
                    index: next_index,
                    path: path.clone(),
                    size: src_meta.len(),
                });
                next_index += 1;
                meta.added.insert(path.clone());
            }
            meta.staged.insert(path.clone(), staged);
            meta.selected.insert(path.clone());
            meta.excluded.remove(&path);
        }
        Ok(())
    })();
    if let Err(e) = batch {
        rollback.rollback();
        return Err(e);
    }
    rollback.commit();

    // 3) 勾选 / 删除是前端草稿的唯一真相：整体覆盖，不再逐条读改写
    let staged_keys: HashSet<String> = meta.staged.keys().cloned().collect();
    meta.selected = draft
        .selected
        .iter()
        .filter(|p| staged_keys.contains(p.as_str()))
        .cloned()
        .collect();
    let valid_entries: HashSet<String> = meta.entries.iter().map(|e| e.path.clone()).collect();
    meta.excluded = draft
        .excluded
        .iter()
        .filter(|p| valid_entries.contains(p.as_str()))
        .cloned()
        .collect();
    // 删除优先于勾选
    meta.selected.retain(|p| !meta.excluded.contains(p));

    meta.selection_initialized = true;
    meta.built = None;
    meta.updated_at = now_secs();
    save_meta(dir, meta)?;
    Ok(duplicates)
}
