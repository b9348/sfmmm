//! 对外 Tauri 命令：薄壳（lock → load_meta → 领域函数 → save_meta → view）。

use super::*;

use std::collections::{HashMap, HashSet};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;


use crate::db::ApiResponse;

/// 打开（或复用）某语言文件的选择性替换工作区。
///
/// `workspace_id` 传空/无效/与当前版本不匹配时会新建工作区；否则复用本地草稿
/// （staging 与元数据都在磁盘上，进程重启后仍可恢复）。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_open_workspace(
    app: tauri::AppHandle,
    mod_id: u64,
    user_id: u64,
    lang_code: String,
    workspace_id: Option<String>,
    force: Option<bool>,
    fetch_base: Option<bool>,
    // 编辑表单当前选择的分类：决定条目路径按哪个安装根归一。
    // 不传时回退到库里的分类（兼容旧调用方）。
    category: Option<String>,
) -> Result<ApiResponse, String> {
    let force = force.unwrap_or(false);
    let want_base = fetch_base.unwrap_or(false);
    if !is_valid_lang_code(&lang_code) {
        return Err("语言代码无效".to_string());
    }
    // 参数名与函数同名，用模块路径显式调用
    let base = self::fetch_base(mod_id, user_id, lang_code.clone(), force).await?;
    let effective_category =
        sanitize_category(category.as_deref()).unwrap_or_else(|| base.category.clone());

    let root = workspace_root(&app)?;

    // 同一用户 / 同一 mod / 同一语言串行化「打开」：快速关闭再打开时，前端可能
    // 还没把 workspace_id 写进 localStorage，两路会各建一个工作区并并发下载
    // 同一 base.zip。这里按三元组加锁，第二次等第一次落盘后直接复用。
    let _open_guard = lock_workspace(&open_lock_key(mod_id, user_id, &lang_code)).await;

    // 前端保存的草稿若基线已变（典型场景：先暂存替换、又对同语言上传整包），
    // 不能复用。此时明确清理并回报，避免暂存项静默消失；清理与 stage/build
    // 共用工作区锁，等正在进行的操作结束后再删。
    let mut stale_draft_discarded = false;
    if let Some(id) = workspace_id
        .as_deref()
        .filter(|s| is_valid_workspace_id(s))
    {
        let dir = root.join(id);
        if dir.is_dir() {
            let stale = load_meta(&dir)
                .map(|m| {
                    m.user_id == user_id
                        && m.mod_id == mod_id
                        && m.lang_code == lang_code
                        && m.base_file_hash != base.file_hash
                })
                .unwrap_or(false);
            if stale {
                let _stale_guard = lock_workspace(id).await;
                // 锁内复查：期间草稿可能被前端重建或已被清理
                let still_stale = load_meta(&dir)
                    .map(|m| {
                        m.user_id == user_id
                            && m.mod_id == mod_id
                            && m.lang_code == lang_code
                            && m.base_file_hash != base.file_hash
                    })
                    .unwrap_or(false);
                if still_stale {
                    fs::remove_dir_all(&dir)
                        .map_err(|e| format!("清理失效的替换草稿失败: {e}"))?;
                    stale_draft_discarded = true;
                }
            }
        }
    }

    // 复用候选：先用前端保存的 id；没有则按「用户/mod/语言/基线 hash」扫描既有草稿。
    // 无论哪条路径，都先给该工作区加锁再读 meta：若构建/替换正在进行，重新打开
    // 必须等它写完再读，否则末尾的 save_meta 会用旧快照覆盖刚写入的 staged/built。
    // 锁持有到本函数返回（save_meta 之后）。
    let mut candidate_id: Option<String> = workspace_id
        .as_deref()
        .filter(|s| is_valid_workspace_id(s))
        .filter(|id| root.join(id).is_dir())
        .map(|s| s.to_string());
    if candidate_id.is_none() {
        candidate_id =
            find_reusable_workspace(&root, mod_id, user_id, &lang_code, &base.file_hash)
                .map(|m| m.workspace_id);
    }
    let _reuse_guard = match candidate_id.as_deref() {
        Some(id) => Some(lock_workspace(id).await),
        None => None,
    };

    // 1) 复用草稿（要求同一用户/mod/语言/基线 hash）
    let mut reused: Option<(PathBuf, WorkspaceMeta)> = None;
    if let Some(id) = candidate_id.as_deref() {
        let dir = root.join(id);
        if let Ok(meta) = load_meta(&dir) {
            if meta.user_id == user_id
                && meta.mod_id == mod_id
                && meta.lang_code == lang_code
                && meta.base_file_hash == base.file_hash
            {
                reused = Some((dir, meta));
            }
        }
    }

    let (dir, mut meta) = match reused {
        Some(v) => v,
        None => {
            let id = format!("{mod_id}_{lang_code}_{}_{}", now_millis(), std::process::id());
            let dir = root.join(&id);
            fs::create_dir_all(dir.join("staging"))
                .map_err(|e| format!("创建编辑工作区失败: {e}"))?;
            let meta = WorkspaceMeta {
                workspace_id: id,
                user_id,
                mod_id,
                lang_code: lang_code.clone(),
                mod_key: base.mod_key.clone(),
                base_file_url: base.file_url.clone(),
                base_file_name: base.file_name.clone(),
                base_file_hash: base.file_hash.clone(),
                base_file_hashes: base.file_hashes.clone(),
                base_version: base.version.clone(),
                base_size: base.file_size,
                manifest: base.manifest.clone(),
                manifest_dirty: false,
                category: effective_category.clone(),
                base_ready: false,
                created_at: now_secs(),
                updated_at: now_secs(),
                entries: Vec::new(),
                staged: HashMap::new(),
                selected: HashSet::new(),
                selection_initialized: false,
                excluded: HashSet::new(),
                added: HashSet::new(),
                local_dir: String::new(),
                local_source: None,
                built: None,
                base_paths_normalized: None,
                pending_upload: None,
            };
            save_meta(&dir, &meta)?;
            (dir, meta)
        }
    };

    // 2) 原包只复用本地已有的（校验 hash），默认不再主动下载：
    //    作者本地有构建产物时，直接走「本地目录导入」，底包下载是按需路径。
    let base_path = dir.join("base.zip");
    let mut base_usable = base_path.is_file() && hash_matches(&base_path, &base.file_hash);
    if !base_usable && base_path.is_file() {
        // 复用的旧 base.zip 与基线不一致（CDN 旧副本/被改写）：丢弃
        let _ = fs::remove_file(&base_path);
    }
    if !base_usable && want_base {
        ensure_base_zip(&app, &dir, &base.file_url, &base.file_hash).await?;
        base_usable = true;
    }

    // 3) 底包可用时以 zip 条目为准；否则回退到 DB manifest（无需下载即可展示/比对）。
    //    已有本地目录导入（可能含作者新增条目）时保留工作区条目，避免新增条目丢失。
    if base_usable && meta.local_source.is_none() {
        let p = base_path.clone();
        match tokio::task::spawn_blocking(move || list_entries(&p))
            .await
            .map_err(|e| format!("解析压缩包任务失败: {e}"))?
        {
            Ok(entries) => {
                // 用**原始**条目名记录「底包文件路径是否本来已归一」。
                // 必须在 normalize_meta_paths 之前算，否则归一后就再也判断不出来，
                // 清单自愈捷径会对历史前缀包错误地只改清单。
                let normalized = entries.iter().all(|e| {
                    normalize_entry_path(&effective_category, &base.mod_key, &e.path) == e.path
                });
                meta.base_paths_normalized = Some(normalized);
                meta.entries = entries;
            }
            Err(e) => {
                // 包损坏：删掉，回退 manifest；只有明确要求下载时才重试
                let _ = fs::remove_file(&base_path);
                base_usable = false;
                if want_base {
                    return Err(e);
                }
            }
        }
    }
    if !base_usable && meta.entries.is_empty() {
        // 没有底包也能列出条目：由 DB 记录的文件清单推导（size 未知按 0）
        meta.entries = entries_from_manifest(&base.manifest, &effective_category, &base.mod_key);
    }
    meta.base_ready = base_usable;
    if !base_usable {
        // 没有可校验的底包：之前记录的形态事实可能属于另一份底包，清空后
        // 发布端按「未归一」保守处理，等重新下载底包时再写回。
        meta.base_paths_normalized = None;
    }
    // 类型变化：旧构建产物/待复用上传记录都是按旧类型（条目归一与落盘规则）生成的，
    // 必须作废，否则发布时会出现「清单按旧类型、安装按新类型」的错位。
    if meta.category != effective_category {
        meta.built = None;
        meta.pending_upload = None;
    }
    meta.category = effective_category;
    // 基线元数据以数据库为准（后续 DB 若被其他窗口改过，旧工作区会因 hash 不匹配被丢弃）
    meta.base_file_url = base.file_url;
    meta.base_file_name = base.file_name;
    meta.base_size = base.file_size;
    meta.base_file_hashes = base.file_hashes;
    meta.base_version = base.version;
    meta.manifest = base.manifest;
    // 以数据库当前清单为比较基准重新计算：本次归一是否产生了需要写回的差异
    meta.manifest_dirty = false;
    // 旧数据可能把条目记成「相对游戏根」（带 BepInEx/plugins/ 等父级前缀），
    // 入库到工作区前统一纠正为安装 target_dir 相对路径。
    normalize_meta_paths(&dir, &mut meta);
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;

    // 清理放在最后并跳过当前工作区：避免清理线程删掉刚复用/刚写入的草稿
    prune_in_background(&app, meta.workspace_id.clone());

    let mut payload = view(&meta);
    if stale_draft_discarded {
        // 旧草稿因基线变更已被清理（不是静默丢弃）：前端据此提示用户重新选择文件
        payload["staleDraftDiscarded"] = serde_json::json!(true);
    }
    Ok(ApiResponse::ok_val(payload, "OK"))
}

/// 按需下载底包（本地缓存命中时零网络流量）。成功后切回「原包透传」模式，
/// 之前由本地目录导入的 materials 不再需要，一并清理（staged 替换源保留）。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_ensure_base(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }

    // 重新读 DB：期间若其他窗口发布了新版本，不能继续按旧基线下载
    let base = fetch_base(
        meta.mod_id,
        user_id,
        meta.lang_code.clone(),
        false,
    )
    .await?;
    if base.file_hash != meta.base_file_hash {
        return Err("该语言的文件已在其他窗口更新，请关闭并重新打开本面板".to_string());
    }

    ensure_base_zip(&app, &dir, &base.file_url, &base.file_hash).await?;
    let p = dir.join("base.zip");
    let entries = tokio::task::spawn_blocking(move || list_entries(&p))
        .await
        .map_err(|e| format!("解析压缩包任务失败: {e}"))??;

    // 用原始条目名记录「底包文件路径是否本来已归一」：必须在下面的
    // normalize_meta_paths 之前算，否则归一后判定会恒真。
    let normalized = entries
        .iter()
        .all(|e| normalize_entry_path(&base.category, &meta.mod_key, &e.path) == e.path);
    meta.base_paths_normalized = Some(normalized);
    meta.entries = entries;
    // 切回底包模式后，作者新增的条目不存在于底包中，必须一并丢弃，
    // 否则打包时会报「条目不在原压缩包中」。替换条目按新条目集合裁剪。
    let valid_paths: HashSet<String> = meta.entries.iter().map(|e| e.path.clone()).collect();
    meta.added.clear();
    meta.staged.retain(|p, _| valid_paths.contains(p));
    meta.selected.retain(|p| valid_paths.contains(p));
    meta.excluded.retain(|p| valid_paths.contains(p));
    meta.base_ready = true;
    meta.category = base.category;
    meta.base_file_url = base.file_url;
    meta.base_file_name = base.file_name;
    meta.base_size = base.file_size;
    meta.base_file_hashes = base.file_hashes;
    meta.base_version = base.version;
    meta.manifest = base.manifest;
    // 切回底包模式：本地目录材料作废，避免两套来源并存
    meta.local_source = None;
    let _ = fs::remove_dir_all(dir.join("materials"));
    let _ = fs::remove_file(dir.join("package.zip"));
    meta.built = None;
    normalize_meta_paths(&dir, &mut meta);
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;
    Ok(ApiResponse::ok_val(view(&meta), "OK"))
}

/// 从本地构建产物目录导入替换来源：不需要 base.zip。
///
/// 目录内文件按 classify 映射到 DB manifest 条目：
/// - 只允许命中已存在条目（未命中的本地文件只作为「多余」提示，不会被打包）；
/// - 内容与基线指纹一致的记入 materials（打包取字节用，不算替换）；
/// - 内容不同的才记入 staged（真正的替换源）；
/// - 缺失条目会在返回结果里列出来，打包阶段仍会硬性拦截，绝不生成残缺包。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_import_directory(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    dir_path: String,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    // 成功失败都记住路径：下次「使用本地文件」可直接命中；localStorage 丢失时也能兜底。
    if meta.local_dir != dir_path {
        meta.local_dir = dir_path.clone();
        meta.updated_at = now_secs();
        save_meta(&dir, &meta)?;
    }
    let dir_for_task = dir.clone();
    let (mut meta, mut summary) = tokio::task::spawn_blocking(move || {
        import_directory_inner(&dir_for_task, meta, &dir_path)
    })
    .await
    .map_err(|e| format!("导入本地目录任务失败: {e}"))??;

    // 手动指定目录属于覆盖手段：来路记 manual；同时带上该类别期望根目录，
    // 让缺失条目能提示「本应在 <game>/CustomMissions/... 查找」。
    let game_path = crate::db::subscribe::read_game_path(&app).ok();
    let expected_root = derive_local_root(&meta.category, &meta.mod_key, game_path.as_deref())
        .map(|(p, _)| p.to_string_lossy().to_string())
        .unwrap_or_default();
    summary.expected_root = expected_root.clone();
    if let Some(local) = meta.local_source.as_mut() {
        local.root_kind = "manual".to_string();
        local.summary.expected_root = expected_root;
    }
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;

    let mut payload = view(&meta);
    payload["import"] = serde_json::to_value(summary)
        .map_err(|e| format!("导入结果序列化失败: {e}"))?;
    Ok(ApiResponse::ok_val(payload, "OK"))
}

/// 打开面板后自动套用上次的本地来源（目录扫描 → 逐条记忆兜底）。
///
/// `local_dir` 是前端 localStorage 里记住的路径提示：工作区可能被 TTL 清理后重建，
/// 此时 `workspace.json` 的 `local_dir` 为空，若不把提示传进来，就会误判为
/// 「没有本地来源」而挡住构建。目录实际存在时优先采用提示里的路径。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_auto_apply(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    local_dir: Option<String>,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    // 与安装流程同一个来源：sqlite config 里的 game_path，不新增配置项。
    // 读取失败/未配置时把原因带回前端，避免静默退化成「无来源」。
    let game_path = crate::db::subscribe::read_game_path(&app);
    let dir_for_task = dir.clone();
    let (meta, auto) = tokio::task::spawn_blocking(move || {
        auto_apply_inner(&dir_for_task, meta, local_dir, game_path)
    })
    .await
    .map_err(|e| format!("自动套用本地文件任务失败: {e}"))??;
    let mut payload = view(&meta);
    payload["auto"] = serde_json::to_value(auto)
        .map_err(|e| format!("自动套用结果序列化失败: {e}"))?;
    Ok(ApiResponse::ok_val(payload, "OK"))
}

/// 强制重扫本地目录：先丢弃已构建的补丁包、本次新增记忆与替换内容，
/// 再按游戏目录全量重新比对。用于「构建之后又改了本地文件」的场景
/// （普通打开会为了保留待发布包而跳过重扫）。前端必须在确认弹窗里
/// 明确告知作者会作废已构建的补丁包。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_rescan_local(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    // 先确认本地来源可用，再清空工作区：否则校验失败会留下「built/staged 已清、
    // 新扫描又没跑成」的半成品状态，前端来源与重扫入口也会一起消失。
    let game = match crate::db::subscribe::read_game_path(&app) {
        Ok(g) => g,
        Err(e) => {
            return Err(if e == "GAME_DIR_INVALID" {
                "请先在设置里配置游戏路径".to_string()
            } else {
                format!("读取游戏路径失败：{e}")
            });
        }
    };
    let (root, _) = derive_local_root(&meta.category, &meta.mod_key, Some(&game))?;
    if !root.is_dir() {
        return Err(format!(
            "按 {} 规则应读取 {}，但该目录不存在；请确认游戏已安装该模组",
            category_root_label(&meta.category),
            root.display()
        ));
    }
    // 与 import_directory_inner 同一校验：云端 manifest 为空/不可用的历史 mod
    // 根本无法扫描，必须在清理旧 staged/built/package.zip 之前拦下。
    if normalized_manifest_files(&meta.manifest, &meta.category, &meta.mod_key)?.is_empty() {
        return Err("该语言没有可用的文件清单，无法按游戏目录比对".to_string());
    }
    let game_path = Ok(game);
    let dir_for_task = dir.clone();
    let (meta, auto) = tokio::task::spawn_blocking(move || {
        let mut meta = meta;
        // 清掉 built / added / staged，下面的 auto_apply 才会走全量扫描而不是
        // 「already」「remembered」两个保留分支。
        reset_local_import(&dir_for_task, &mut meta)?;
        meta.updated_at = now_secs();
        save_meta(&dir_for_task, &meta)?;
        auto_apply_inner(&dir_for_task, meta, None, game_path)
    })
    .await
    .map_err(|e| format!("强制重扫本地文件任务失败: {e}"))??;
    let mut payload = view(&meta);
    payload["auto"] = serde_json::to_value(auto)
        .map_err(|e| format!("强制重扫结果序列化失败: {e}"))?;
    Ok(ApiResponse::ok_val(payload, "OK"))
}

/// 暂存一个替换文件：把用户选择的本地文件复制进工作区 staging/。
/// 只允许绑定到已存在的条目，路径不变。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_stage_replace(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    entry_path: String,
    source_path: String,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let root = workspace_root(&app)?;
    let dir = root.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }

    let src = PathBuf::from(&source_path);
    let meta_src = fs::metadata(&src).map_err(|e| format!("读取替换文件失败: {e}"))?;
    if !meta_src.is_file() {
        return Err("选择的路径不是文件".to_string());
    }

    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    if !meta.entries.iter().any(|e| e.path == entry_path) {
        return Err("目标条目不在原压缩包中（本期只允许替换已存在的文件）".to_string());
    }
    let staged_name = format!(
        "stage_{}.bin",
        hex::encode(Sha256::digest(entry_path.as_bytes()))
    );
    let staged_path = dir.join("staging").join(&staged_name);
    // 先写临时文件再原子替换：即使打包线程正在读取，也不会读到写了一半的内容
    let tmp_path = dir.join("staging").join(format!("{staged_name}.tmp"));
    let _ = fs::remove_file(&tmp_path);
    if let Err(e) = fs::copy(&src, &tmp_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("复制替换文件到工作区失败: {e}"));
    }
    if let Err(e) = fs::rename(&tmp_path, &staged_path) {
        let _ = fs::remove_file(&staged_path);
        fs::rename(&tmp_path, &staged_path)
            .map_err(|e2| format!("保存替换文件失败: {e} / {e2}"))?;
    }
    let size = fs::metadata(&staged_path)
        .map_err(|e| format!("读取暂存文件失败: {e}"))?
        .len();
    let source_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    meta.staged.insert(
        entry_path.clone(),
        StagedMeta {
            staged_name,
            source_name,
            source_path: src.to_string_lossy().to_string(),
            size,
        },
    );
    // 手动替换同样默认勾选进入本次更新
    meta.selected.insert(entry_path);
    meta.selection_initialized = true;
    // 文件内容变了，之前打好的包作废
    meta.built = None;
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;
    Ok(ApiResponse::ok_val(view(&meta), "OK"))
}

/// 撤销某个条目的替换（删除 staging 文件，保留原条目）。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_unstage_replace(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    entry_path: String,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    if meta.added.contains(&entry_path) {
        return Err("该条目是本次新增的文件，请使用「删除」".to_string());
    }
    if let Some(staged) = meta.staged.remove(&entry_path) {
        let _ = fs::remove_file(dir.join("staging").join(staged.staged_name));
        meta.selected.remove(&entry_path);
    } else {
        return Err("该条目没有暂存的替换文件".to_string());
    }
    meta.built = None;
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;
    Ok(ApiResponse::ok_val(view(&meta), "OK"))
}


/// 基于当前清单新增文件（属于内容变化，发布必须提升版本）。
///
/// 两种来源：
/// - `file_paths`：手动选择的绝对路径，按类别规则推导包内路径；
/// - `dir_relative_paths`：当前本地导入目录中的「多余文件」相对路径。
///
/// 目标路径不存在 → 追加为新条目（标记 added、默认勾选）；
/// 已存在 → 按替换处理，并在返回的 `duplicates` 中提示。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_add_files(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    file_paths: Vec<String>,
    dir_relative_paths: Vec<String>,
    game_path: Option<String>,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let total = file_paths.len() + dir_relative_paths.len();
    if total == 0 || total > 500 {
        return Err("一次添加的文件数量不合法（1-500）".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    let game = game_path.map(PathBuf::from);

    // 目标路径 → 来源文件；同一目标多次出现时以最后一次为准
    let mut jobs: HashMap<String, PathBuf> = HashMap::new();
    for raw in &file_paths {
        if raw.trim().is_empty() {
            continue;
        }
        let src = PathBuf::from(raw);
        let target = added_entry_target(&meta, &src, game.as_deref())?;
        jobs.insert(target, src);
    }
    for raw in &dir_relative_paths {
        let local = meta
            .local_source
            .as_ref()
            .ok_or_else(|| "当前没有导入本地目录，无法按相对路径添加".to_string())?;
        let safe = validate_added_path(raw)?;
        let target = if meta.category == "dll" {
            file_name_of(&safe)
        } else {
            safe.clone()
        };
        jobs.insert(target, PathBuf::from(&local.root_path).join(safe));
    }
    if jobs.is_empty() {
        return Err("没有选择要添加的文件".to_string());
    }

    let mut duplicates: Vec<String> = Vec::new();
    let mut paths: Vec<String> = jobs.keys().cloned().collect();
    paths.sort();
    let next_index = meta
        .entries
        .iter()
        .map(|e| e.index)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    let mut rollback = StagingRollback::new(&dir);
    let batch = (|| -> Result<(), String> {
        for (offset, target) in paths.iter().enumerate() {
            let src = jobs.get(target).expect("job 已按同一 key 构建");
            let src_meta = fs::metadata(src)
                .map_err(|e| format!("读取文件失败（{}）: {e}", src.display()))?;
            if !src_meta.is_file() {
                return Err(format!("选择的路径不是文件：{}", src.display()));
            }
            let existed = meta.entries.iter().any(|e| e.path == *target);
            if existed && !meta.added.contains(target) {
                // 与原条目重名：按替换处理，明确提示
                duplicates.push(target.clone());
            }
            rollback.prepare(target)?;
            let staged = stage_new_file(&dir, target, src)?;
            if !existed {
                meta.entries.push(EntryMeta {
                    index: next_index + offset,
                    path: target.clone(),
                    size: src_meta.len(),
                });
                meta.added.insert(target.clone());
            }
            meta.staged.insert(target.clone(), staged);
            // 新增条目默认勾选；同时撤销此前可能存在的「本次不打包」
            meta.selected.insert(target.clone());
            meta.excluded.remove(target);
        }
        Ok(())
    })();
    if let Err(e) = batch {
        // 整批失败：清理/还原本轮已写入的暂存文件；meta 未写盘，无需恢复
        rollback.rollback();
        return Err(e);
    }
    rollback.commit();
    meta.selection_initialized = true;
    meta.built = None;
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;

    let mut payload = view(&meta);
    payload["duplicates"] = serde_json::to_value(&duplicates)
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    Ok(ApiResponse::ok_val(payload, "OK"))
}

/// 删除本次新增的条目（从清单与暂存中彻底移除）。
/// 前端已统一改用 set_entry_excluded 的「删除 / 撤销」语义；该命令保留供兼容旧调用。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_remove_added_entry(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    entry_path: String,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    if !meta.added.contains(&entry_path) {
        return Err("只能删除本次新增的条目".to_string());
    }
    meta.entries.retain(|e| e.path != entry_path);
    meta.added.remove(&entry_path);
    meta.selected.remove(&entry_path);
    meta.excluded.remove(&entry_path);
    if let Some(staged) = meta.staged.remove(&entry_path) {
        let _ = fs::remove_file(dir.join("staging").join(staged.staged_name));
    }
    meta.built = None;
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;
    Ok(ApiResponse::ok_val(view(&meta), "OK"))
}

/// 标记 / 撤销「删除」的条目（支持批量）。
///
/// 只作用于本次生成的新包：不会删除订阅者已安装的文件，安装端仍是解压覆盖。
/// 移除属于内容变化，发布时必须提升版本；撤销后原替换（staged）仍然生效。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_set_entry_excluded(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    entry_paths: Vec<String>,
    excluded: bool,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    if entry_paths.is_empty() || entry_paths.len() > 500 {
        return Err("条目数量不合法".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    for path in &entry_paths {
        // 只允许文件条目，且必须是原包/清单中已有路径（不做新增/删除之外的改名）
        let is_file_entry = meta
            .entries
            .iter()
            .any(|e| e.path == *path && !e.path.ends_with('/'));
        if !is_file_entry {
            return Err(format!("条目不在当前文件清单中，无法移除：{path}"));
        }
    }
    for path in entry_paths {
        if excluded {
            meta.excluded.insert(path);
        } else {
            meta.excluded.remove(&path);
        }
    }
    meta.built = None;
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;
    Ok(ApiResponse::ok_val(view(&meta), "OK"))
}

/// 勾选 / 取消「用本地新内容更新」的条目（batch 支持多条）。
///
/// 只有 staged（本地内容与基线不同）条目可勾选；取消勾选后打包会改用
/// 基线原样，因此需要底包（构建时按需获取）。与「本次不打包」互不影响。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_set_entry_selected(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    entry_paths: Vec<String>,
    selected: bool,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    if entry_paths.is_empty() || entry_paths.len() > 500 {
        return Err("条目数量不合法".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    for path in &entry_paths {
        if !meta.staged.contains_key(path.as_str()) {
            return Err(format!("该条目没有本地新内容，无法勾选：{path}"));
        }
    }
    for path in entry_paths {
        if selected {
            meta.selected.insert(path);
        } else {
            meta.selected.remove(&path);
        }
    }
    meta.selection_initialized = true;
    meta.built = None;
    meta.updated_at = now_secs();
    save_meta(&dir, &meta)?;
    Ok(ApiResponse::ok_val(view(&meta), "OK"))
}


/// 生成整包：未替换条目原样透传，替换条目按原路径写入；随后重算
/// size / file_hash / file_hashes，并校验 manifest。
///
/// 本地目录模式下，若有「取消勾选」的变化条目，打包需要底包里的基线原字节：
/// 依次尝试工作区 base.zip → 内容寻址缓存 → 按需下载（`fetch_base` +
/// `ensure_base_zip`），失败直接返回明确错误，不会生成不完整的包。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_build_package(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
    // 前端草稿快照；编辑阶段不落盘，构建时一次性应用
    draft: Option<DraftSegments>,
    // 编辑表单当前选择的分类；与打开工作区时同一口径，决定条目路径归一规则
    category: Option<String>,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    let mut meta = load_meta(&dir)?;
    if meta.user_id != user_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }

    // 分类变化必须在本轮构建内生效：按新分类重新归一所有条目路径，
    // 并作废旧产物；否则会出现「路径按旧分类归一、库里却写成新分类」。
    if let Some(cat) = sanitize_category(category.as_deref()) {
        if cat != meta.category {
            meta.category = cat;
            meta.built = None;
            meta.pending_upload = None;
            normalize_meta_paths(&dir, &mut meta);
        }
    }

    // 草稿一次性落盘（复制新增/替换文件、覆盖勾选/删除集合）
    let duplicates = match draft.as_ref() {
        Some(d) => apply_draft_segments(&dir, &mut meta, d)?,
        None => Vec::new(),
    };

    let use_local = meta.local_source.is_some();
    // 仅清单需要归一（没有任何文件替换/新增/剔除）时不必重新打包：直接生成
    // 一个「清单纠正」构建结果，发布端只做条件 UPDATE，不上传新包、不要求升版本。
    // 典型场景：旧数据把 BepInEx/、BepInEx/plugins/ 等目录条目写进了 manifest。
    // 但清单里的文件名本身还带安装根前缀时不能走这个捷径：那说明旧包条目也没归一，
    // 只改清单会让云端清单与包内条目脱节，必须落到下面的完整打包路径。
    // 判定必须用「打开/下载底包时按原始条目名算出并持久化」的事实：
    // 此时 meta.manifest 已被 normalize_meta_paths 就地归一，再判断必然恒真。
    if !use_local
        && meta.staged.is_empty()
        && meta.excluded.is_empty()
        && meta.manifest_dirty
        && meta.base_paths_normalized == Some(true)
    {
        let manifest = normalize_manifest(&meta.category, &meta.mod_key, &meta.manifest);
        let file_name = if meta.base_file_name.trim().is_empty() {
            format!("{}_{}.zip", meta.mod_key, meta.lang_code)
        } else {
            meta.base_file_name.clone()
        };
        let built = BuiltMeta {
            file_name,
            file_size: meta.base_size.max(0) as u64,
            file_hash: meta.base_file_hash.clone(),
            file_hashes: meta.base_file_hashes.clone(),
            manifest: manifest.clone(),
            replaced: 0,
            added: 0,
            changed: false,
            manifest_dirty: manifest != meta.manifest || meta.manifest_dirty,
            category: meta.category.clone(),
            // 底包原始条目名已确认是归一形态，发布端可以只改清单
            base_paths_normalized: true,
        };
        meta.manifest = manifest;
        meta.built = Some(built.clone());
        meta.updated_at = now_secs();
        save_meta(&dir, &meta)?;
        let workspace = view(&meta);
        return Ok(ApiResponse::ok_val(
            serde_json::json!({ "built": built, "workspace": workspace, "duplicates": duplicates }),
            "OK",
        ));
    }
    // manifest_dirty 也算一次待保存变更：打开工作区时归一清单（删目录条目）
    // 即使作者没有改任何文件，也要允许构建，才能把纠正后的清单发布写回。
    if meta.staged.is_empty() && meta.excluded.is_empty() && !use_local && !meta.manifest_dirty {
        return Err("还没有替换或移除任何文件".to_string());
    }

    // 未勾选的变化条目、本地缺失条目 = 回退到基线原样，必须能从底包取回这些条目的字节。
    // 工作区已有可用 base.zip 时无需联网；否则先查本地缓存，最后才下载。
    if use_local {
        let needs_base = !local_base_fallback_paths(&meta).is_empty();
        if needs_base {
            let base_path = dir.join("base.zip");
            if !(base_path.is_file() && hash_matches(&base_path, &meta.base_file_hash)) {
                if copy_from_base_cache(&app, &base_path, &meta.base_file_hash) {
                    log::info!("命中本地原包缓存（保留未改动条目）: {}", meta.base_file_hash);
                } else {
                    let base = fetch_base(
                        meta.mod_id,
                        user_id,
                        meta.lang_code.clone(),
                        false,
                    )
                    .await
                    .map_err(|e| {
                        format!("需要底包保留未改动条目的原内容，但读取文件记录失败：{e}")
                    })?;
                    if base.file_hash != meta.base_file_hash {
                        return Err(
                            "该语言的文件已在其他窗口更新，请关闭并重新打开本面板".to_string()
                        );
                    }
                    ensure_base_zip(&app, &dir, &base.file_url, &base.file_hash)
                        .await
                        .map_err(|e| {
                            format!("需要底包保留未改动条目的原内容，底包获取失败：{e}")
                        })?;
                }
                meta.base_ready = true;
                meta.updated_at = now_secs();
                save_meta(&dir, &meta)?;
            }
        }
    }

    let dir_for_task = dir.clone();
    let (built_meta, built) = tokio::task::spawn_blocking(move || {
        if use_local {
            build_from_local_source(&dir_for_task, meta)
        } else {
            build_package_inner(&dir_for_task, meta)
        }
    })
    .await
    .map_err(|e| format!("打包任务失败: {e}"))??;
    // 返回最新工作区视图：构建时一次性应用的草稿在此同步回前端，
    // 前端据此清空本地草稿状态（而不需要再额外发一次查询）。
    let workspace = view(&built_meta);
    Ok(ApiResponse::ok_val(
        serde_json::json!({ "built": built, "workspace": workspace, "duplicates": duplicates }),
        "OK",
    ))
}

/// 放弃工作区（删除本地草稿与暂存文件）。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_discard_workspace(
    app: tauri::AppHandle,
    workspace_id: String,
    user_id: u64,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let _guard = lock_workspace(&workspace_id).await;
    let dir = workspace_root(&app)?.join(&workspace_id);
    if dir.is_dir() {
        let meta = load_meta(&dir)?;
        if meta.user_id != user_id {
            return Err("工作区不属于当前用户".to_string());
        }
        fs::remove_dir_all(&dir).map_err(|e| format!("删除工作区失败: {e}"))?;
    }
    Ok(ApiResponse::ok_msg("workspace discarded"))
}
