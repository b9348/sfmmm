//! 编辑工作区元数据：结构体定义与 workspace.json 的存取底座。

use super::*;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct WorkspaceMeta {
    pub(crate) workspace_id: String,
    /// 打开该工作区的用户；复用时必须一致，避免同机切换账号读到他人草稿。
    /// 旧版本草稿缺少该字段（反序列化为 0），不会被新版本复用。
    #[serde(default)]
    pub(crate) user_id: u64,
    pub(crate) mod_id: u64,
    pub(crate) lang_code: String,
    pub(crate) mod_key: String,
    pub(crate) base_file_url: String,
    pub(crate) base_file_name: String,
    pub(crate) base_file_hash: String,
    /// 原文件的逐文件指纹（JSON，可能为空）
    pub(crate) base_file_hashes: String,
    pub(crate) base_version: String,
    pub(crate) base_size: i64,
    /// 工作区内的 manifest 明文（已按当前 category 归一；保留目录条目，
    /// 只丢弃安装根本身/上级结构目录）
    pub(crate) manifest: String,
    /// 归一后的 manifest 与库里的原始 manifest 不一致（例如旧数据把目录条目
    /// 也写进了清单）。发布时即使内容没有变化，也要把归一后的清单写回数据库。
    #[serde(default)]
    pub(crate) manifest_dirty: bool,
    /// v1 / v2 / dll / composite，决定本地目录到包内路径的映射规则
    #[serde(default)]
    pub(crate) category: String,
    /// base.zip 是否已在工作区内可用（可用时走「原包透传」打包）
    #[serde(default)]
    pub(crate) base_ready: bool,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) entries: Vec<EntryMeta>,
    #[serde(default)]
    pub(crate) staged: HashMap<String, StagedMeta>,
    /// 勾选进入本次更新的 staged 条目。未勾选的条目改用基线原样（需要底包）。
    #[serde(default)]
    pub(crate) selected: HashSet<String>,
    /// 是否已明确初始化过勾选状态；用于兼容旧草稿（旧草稿无该字段时全选 staged）
    #[serde(default)]
    pub(crate) selection_initialized: bool,
    /// 本次打包要剔除的条目（仅作用于新包，不会删除已安装用户端的文件）。
    /// 与 staged/selected 独立：撤销剔除后，原替换与勾选仍然生效。
    #[serde(default)]
    pub(crate) excluded: HashSet<String>,
    /// 作者本次新增的条目（原清单中原本不存在）。与 staged 配合：
    /// staged 存内容，added 标记「新增」以便单独删除，不与替换/剔除语义混淆。
    #[serde(default)]
    pub(crate) added: HashSet<String>,
    /// 记忆的本地构建产物目录：导入成功与否都保存，localStorage 丢失时用它兜底。
    /// 本机绝对路径，不算敏感凭据，只存在本地工作区元数据里。
    #[serde(default)]
    pub(crate) local_dir: String,
    /// 本地构建产物目录导入结果（存在时打包以它为准，不需要 base.zip）
    #[serde(default)]
    pub(crate) local_source: Option<LocalSourceMeta>,
    #[serde(default)]
    pub(crate) built: Option<BuiltMeta>,
    /// 底包文件条目名是否**本来**已经是归一化形态（打开工作区/下载底包时，
    /// 用原始条目名和 normalized 结果比较后写入）。
    /// 必须在 `normalize_meta_paths` 之前计算：归一后 meta.manifest/entries
    /// 已经是结果，再判断「是否已归一」必然恒真。
    /// None = 尚未读到过底包，无法判断；发布端只接受 Some(true) 走「仅改清单」。
    #[serde(default)]
    pub(crate) base_paths_normalized: Option<bool>,
    /// 已上传但尚未提交成功的产物记录。发布失败后保留，
    /// 重新点保存时若 op_id 与包内容一致，直接复用该地址，避免重复上传。
    #[serde(default)]
    pub(crate) pending_upload: Option<PendingUploadMeta>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct PendingUploadMeta {
    /// 本次发布的幂等标识：workspace_id + 新包 file_hash 派生
    pub(crate) op_id: String,
    pub(crate) file_hash: String,
    pub(crate) file_name: String,
    pub(crate) file_size: u64,
    pub(crate) file_url: String,
    pub(crate) folder: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct EntryMeta {
    pub(crate) index: usize,
    pub(crate) path: String,
    pub(crate) size: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct StagedMeta {
    /// 工作区 staging/ 下的实际文件名（内部生成，不含用户输入）
    pub(crate) staged_name: String,
    pub(crate) source_name: String,
    /// 该条目上次替换/新增时用的本地文件绝对路径。
    /// 下次打开面板若该文件仍存在，直接按此映射回填并标记已选，
    /// 不必重新逐行挑选；文件已不存在时再降级为目录扫描 + hash 比对。
    #[serde(default)]
    pub(crate) source_path: String,
    pub(crate) size: u64,
}

/// 本地目录导入结果。
/// - 内容与基线指纹一致的条目记入 `materials`（只用于打包取字节，不算「替换」）；
/// - 内容有差异的条目记入 `staged`（真正的替换源）；
/// - `missing` 非空时不允许打包，避免生成缺文件的残缺包。
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct LocalSourceMeta {
    pub(crate) root_path: String,
    /// 根目录的来路：manual / game_root / custom_missions / custom_missions2 / plugins。
    /// 前端据此显示「来源：游戏根目录 E:\...」，让作者一眼确认取的是哪一层。
    #[serde(default)]
    pub(crate) root_kind: String,
    pub(crate) imported_at: i64,
    #[serde(default)]
    pub(crate) materials: HashMap<String, MaterialMeta>,
    #[serde(default)]
    pub(crate) summary: ImportSummary,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct MaterialMeta {
    /// 工作区 materials/ 下的实际文件名（内部生成，不含用户输入）
    pub(crate) material_name: String,
    pub(crate) source_rel: String,
    pub(crate) size: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct ImportSummary {
    pub(crate) root_path: String,
    pub(crate) matched: usize,
    pub(crate) changed: usize,
    pub(crate) unchanged: usize,
    pub(crate) missing: Vec<String>,
    pub(crate) extra: Vec<String>,
    /// 「路径无法解析」的条目（本地有多个候选、不做猜测）。只存条目键，
    /// 便于前端按行标状态；候选详情见 `ambiguous_details`。
    pub(crate) ambiguous: Vec<String>,
    /// 与 `ambiguous` 一一对应的可读说明（条目 + 候选路径）。
    #[serde(default)]
    pub(crate) ambiguous_details: Vec<String>,
    pub(crate) invalid: Vec<String>,
    /// 基线逐文件指纹缺失/不可用时，所有条目都按「已变化」处理
    pub(crate) baseline_unverified: bool,
    /// 嵌套 zip 自身不在基线指纹里（指纹只含其内部文件），只能保守视为已变化
    pub(crate) nested_zip_unverified: usize,
    /// 预估写库的 file_hashes 体积超过 TEXT 容量时的预警（不阻断）
    pub(crate) file_hash_budget_exceeded: bool,
    pub(crate) total_manifest_files: usize,
    /// 该类别在安装时使用的根目录（绝对路径）。缺失条目据此逐条给出
    /// 「在 <expected_root>/<相对路径> 未找到」，避免作者只看到数量。
    #[serde(default)]
    pub(crate) expected_root: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct BuiltMeta {
    pub(crate) file_name: String,
    pub(crate) file_size: u64,
    pub(crate) file_hash: String,
    pub(crate) file_hashes: String,
    pub(crate) manifest: String,
    pub(crate) replaced: usize,
    /// 本次新增的条目数（从 staging 写入、原包中不存在）
    #[serde(default)]
    pub(crate) added: usize,
    pub(crate) changed: bool,
    /// 清单需要纠正（与库里的原始清单不同），但文件内容本身没有变化。
    /// 发布端据此只做一次「清单条件更新」，不要求提升版本、也不重复上传。
    #[serde(default)]
    pub(crate) manifest_dirty: bool,
    /// 本次构建时使用的 mod 类型。发布前与工作区当前类型比对：
    /// 类型变了，条目路径的归一/落盘规则就变了，旧产物必须重新构建。
    #[serde(default)]
    pub(crate) category: String,
    /// 底包里的文件条目名是否本来就已经是归一化形态。
    /// 历史包可能把安装根前缀（`BepInEx/plugins/`、`CustomMissions/`）写进条目名：
    /// 这时只把归一化后的清单写回数据库，会让云端清单与实际包内条目脱节，
    /// 发布端必须改成「连带重打包」，见 `mod_edit_publish_package` 的注释。
    #[serde(default)]
    pub(crate) base_paths_normalized: bool,
}

#[derive(Clone, serde::Deserialize)]
pub(crate) struct BaseInfo {
    pub(crate) mod_key: String,
    pub(crate) category: String,
    pub(crate) file_url: String,
    pub(crate) file_name: String,
    pub(crate) file_size: i64,
    pub(crate) file_hash: String,
    pub(crate) file_hashes: String,
    pub(crate) version: String,
    pub(crate) manifest: String,
}

pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join("workspace.json")
}

pub(crate) fn save_meta(dir: &Path, meta: &WorkspaceMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("序列化工作区失败: {e}"))?;
    fs::write(meta_path(dir), json).map_err(|e| format!("写入工作区元数据失败: {e}"))
}

pub(crate) fn load_meta(dir: &Path) -> Result<WorkspaceMeta, String> {
    let raw = fs::read_to_string(meta_path(dir))
        .map_err(|e| format!("读取工作区元数据失败: {e}"))?;
    let mut meta: WorkspaceMeta =
        serde_json::from_str(&raw).map_err(|e| format!("解析工作区元数据失败: {e}"))?;
    // 旧草稿没有勾选字段：默认把已有替换全部视为勾选，保持原行为
    if !meta.selection_initialized && !meta.staged.is_empty() {
        meta.selected = meta.staged.keys().cloned().collect();
        meta.selection_initialized = true;
    }
    // 旧数据/旧入口可能按「相对游戏根」记录了条目（dll 带 BepInEx/plugins/ 前缀等），
    // 读入时统一纠正为安装 target_dir 相对路径，保证 manifest 与最终 zip 一致。
    normalize_meta_paths(dir, &mut meta);
    Ok(meta)
}

pub(crate) fn view(meta: &WorkspaceMeta) -> serde_json::Value {
    serde_json::json!({
        "workspace_id": meta.workspace_id,
        "entries": meta.entries,
        "staged": meta.staged,
        // 旧草稿没有勾选字段：按「全部已勾选」回显，避免界面与实际打包行为不一致
        "selected": selected_paths(meta),
        "excluded": meta.excluded,
        // 本次新增的条目（与原始条目的删除/撤销走同一套语义）
        "added": meta.added,
        // 勾选状态是否已初始化：false 时 selected_paths 按「全部变化条目已选」处理，
        // 前端必须用同一口径渲染，不能一边后端全选、一边前端显示 0 选中。
        "selection_initialized": meta.selection_initialized,
        // 记忆的本地目录：localStorage 丢失/被清时前端用它兜底
        "local_dir": meta.local_dir,
        "category": meta.category,
        // 归一后的清单与库里原始清单不一致（旧数据带目录条目/前缀叠加）。
        // 前端据此把「仅清单纠正」也视为一次待保存变更，保存时走构建+发布。
        "manifest_dirty": meta.manifest_dirty,
        "base_ready": meta.base_ready,
        "local_source": meta.local_source.as_ref().map(|l| serde_json::json!({
            "root_path": l.root_path,
            // 根目录来路：game_root/custom_missions/custom_missions2/plugins/manual
            "root_kind": l.root_kind,
            "imported_at": l.imported_at,
            "summary": l.summary,
            "materials": l.materials.len(),
        })),
        "base": {
            "file_url": meta.base_file_url,
            "file_name": meta.base_file_name,
            "file_size": meta.base_size,
            "file_hash": meta.base_file_hash,
            "version": meta.base_version,
            "manifest": meta.manifest,
            // 逐文件指纹条目数：>0 时导入按 hash 精确比对，0 时只能按存在性保守处理。
            // 前端据此明确告知作者「比对是否真的走了 hash」。
            // 双键格式下必须按路径键计数，否则同名不同目录会被少算。
            "file_hash_count": crate::db::hash::count_file_hashes(
                Some(meta.base_file_hashes.clone()),
            ),
        },
        "built": meta.built,
    })
}

/// 本次打包实际生效的勾选集合。
///
/// 旧草稿（升级前没有 `selected` / `selection_initialized` 字段）视作全部
/// staged 条目已勾选，与升级前的打包行为一致。
pub(crate) fn selected_paths(meta: &WorkspaceMeta) -> HashSet<String> {
    if meta.selection_initialized {
        meta.selected.clone()
    } else {
        meta.staged.keys().cloned().collect()
    }
}
