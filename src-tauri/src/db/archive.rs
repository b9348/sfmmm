// 创意工坊"仅下载不安装"：把 mod 的原始压缩包直接落到游戏根目录下的
// sfmmmDownloads 文件夹，不解压、不写任何安装记录。
//
// 为什么独立于 db::subscribe（安装链路）：
//   安装链路要解压到 BepInEx/CustomMissions* 并写 installed_workshop_mods，
//   "仅下载"只是把原始 zip 存一份给用户自己处理，两者语义与落点完全不同，
//   塞进 subscribe.rs 会给安装链路挂上一堆无关分支。
//
// 命令：db_download_mod_archive
//
// 下载复用 db::download 的共享引擎（默认单流；threads > 1 且服务端支持 Range 时
// 才分块并行，失败自动重试/回退单流），与 app 更新、前置安装同一套下载实现。
// 进度经 app_handle.emit("archive-download-progress", …) 全局广播——沿用本项目
// "事件而非 Channel"的约定：用户离开详情页后下载照常完成，回来仍能看到结果。
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::Emitter;

use crate::db::download::{
    download_file, DownloadProgress, ProgressFn, DEFAULT_DOWNLOAD_THREADS,
    DOWNLOAD_CONNECT_TIMEOUT,
};
use crate::db::subscribe::read_game_path;

/// 下载目录名（位于游戏根目录下）。与安装目录完全隔离，用户可自行取用/删除。
const DOWNLOADS_DIR_NAME: &str = "sfmmmDownloads";

/// 目标文件（小写路径）→ taskId：同一文件已在下载时直接复用该任务，
/// 避免重复点按钮把同一个 zip 下载两遍、两个引擎并发写同一文件导致损坏。
static ACTIVE_PATHS: Lazy<Arc<Mutex<HashMap<String, i64>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 任务号自增（仅下载任务用，不落库——没有"重启后恢复"诉求：
/// 下载完就是个 zip 文件，进程重启后重新点一次即可）
static NEXT_TASK_ID: AtomicI64 = AtomicI64::new(1);

/// 任务取消标志（taskId → 标志）。与 subscribe.rs 的 CANCEL_FLAGS 同款：
/// 下载引擎在每个分块/每次读之后都会检查它，置位即尽快退出并删除半成品。
static CANCEL_FLAGS: Lazy<Arc<Mutex<HashMap<i64, Arc<AtomicBool>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 活跃任务快照（taskId → 最近一次进度）。前端离开详情页后若想知道"还有哪些
/// 仅下载任务在跑"，只能靠事件；而事件是瞬时的，晚挂载的页面会漏掉之前的帧。
/// 这里保存最近状态供 `db_list_archive_tasks` 查询，终态即时摘除。
///
/// 不落 SQLite 的理由与 NEXT_TASK_ID 相同：仅下载的产物就是一个 zip 文件，
/// 进程重启后这个"任务"不再有意义（下载中断 → 重新点一次即可），持久化只会
/// 在库里堆一堆无法恢复的僵尸行。
static TASK_SNAPSHOTS: Lazy<Arc<Mutex<HashMap<i64, ArchiveTaskSnapshot>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveProgress {
    task_id: i64,
    mod_key: String,
    lang_code: String,
    percent: u32,
    /// 实时下载速度（字节/秒），仅 downloading 阶段有意义
    speed: u64,
    /// downloading / done / failed / cancelled
    status: String,
    error: String,
    /// 最终落盘路径（下载完成后即完整路径，进行中为 .part 临时路径）
    path: String,
    /// 冗余存一份显示名，供悬浮下载条在任意页面展示（事件 payload 同款，
    /// 恢复查询也用它）；空串时前端回退到 mod_key
    display_name: String,
}

/// `db_list_archive_tasks` 返回的行：字段与事件 payload 对齐，
/// 前端一条更新通路即可同时消费"恢复"与"实时事件"。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTaskSnapshot {
    task_id: i64,
    mod_key: String,
    lang_code: String,
    display_name: String,
    percent: u32,
    speed: u64,
    status: String,
    error: String,
    path: String,
}

/// 取下载目录（不存在则创建）。返回 Err 时带人类可读原因。
fn ensure_downloads_dir(base: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(base).join(DOWNLOADS_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
    Ok(dir)
}

/// 把上传文件名/URL 尾段清洗成安全的 Windows 文件名：
/// 去掉路径分隔符与查询串，过滤 `< > : " | ? *` 与控制字符，
/// 去掉首尾空白和结尾的点/空格（Windows 上尾随点与空格是非法名）。
fn sanitize_file_name(raw: &str) -> String {
    let tail = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let tail = tail.split(['?', '#']).next().unwrap_or("");
    let cleaned: String = tail
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    cleaned.to_string()
}

/// 从原始文件名/URL 尾段里取扩展名（只认常见压缩包后缀），取不到返回 "zip"。
/// 作者上传的可能就是 zip（安装链路只解 zip），但"仅下载"不该替用户改格式。
fn archive_ext(file_name: &str, file_url: &str) -> String {
    for raw in [file_name, file_url] {
        let tail = sanitize_file_name(raw);
        if let Some(idx) = tail.rfind('.') {
            let ext = tail[idx + 1..].to_ascii_lowercase();
            if matches!(ext.as_str(), "zip" | "7z" | "rar" | "tar" | "gz" | "bz2" | "xz" | "mod") {
                return ext;
            }
        }
    }
    "zip".to_string()
}

/// 拼最终文件名：`{mod_key}[_{语言}][_v{版本}].{扩展名}`。
///
/// 刻意不用作者上传的原始文件名直接落盘：同一个 mod 的多语言文件常常同名
/// （都叫 mission.zip），直接用作者名会让第 2 个语言命中"文件已存在"而永远下载不到；
/// 不同 mod 之间也可能撞名。以 mod_key + 语言 + 版本为准既唯一（mod_files 里
/// (mod_id, lang_code) 唯一）又能自解释，扩展名仍取作者原样。
fn resolve_file_name(
    file_name: &str,
    file_url: &str,
    mod_key: &str,
    lang_code: &str,
    version: &str,
) -> String {
    let mut name = sanitize_file_name(mod_key);
    if name.is_empty() {
        name = "mod".to_string();
    }
    if !lang_code.is_empty() {
        name.push('_');
        name.push_str(&sanitize_file_name(lang_code));
    }
    if !version.is_empty() {
        name.push_str("_v");
        name.push_str(&sanitize_file_name(version));
    }
    name.push('.');
    name.push_str(&archive_ext(file_name, file_url));
    name
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    app: &tauri::AppHandle,
    task_id: i64,
    mod_key: &str,
    lang_code: &str,
    display_name: &str,
    percent: u32,
    speed: u64,
    status: &str,
    error: &str,
    path: &str,
) {
    // 先更新快照再广播：前端收到事件时若顺手查一次 / 或在事件间隙挂载，
    // 都能看到与事件一致的状态，不会出现"事件说 40%、查询说 0%"的回跳。
    if let Ok(mut map) = TASK_SNAPSHOTS.lock() {
        if matches!(status, "done" | "failed" | "cancelled") {
            // 终态立即摘除：列表只反映"还在跑"的任务，前端拿到终态事件后
            // 自行展示完成提示并倒计时关闭，不需要再回来查
            map.remove(&task_id);
        } else {
            map.insert(
                task_id,
                ArchiveTaskSnapshot {
                    task_id,
                    mod_key: mod_key.to_string(),
                    lang_code: lang_code.to_string(),
                    display_name: display_name.to_string(),
                    percent,
                    speed,
                    status: status.to_string(),
                    error: error.to_string(),
                    path: path.to_string(),
                },
            );
        }
    }
    let _ = app.emit(
        "archive-download-progress",
        ArchiveProgress {
            task_id,
            mod_key: mod_key.to_string(),
            lang_code: lang_code.to_string(),
            display_name: display_name.to_string(),
            percent,
            speed,
            status: status.to_string(),
            error: error.to_string(),
            path: path.to_string(),
        },
    );
}

/// 仅下载 mod 压缩包到 `<游戏根目录>\sfmmmDownloads\`。
///
/// 立即返回 taskId，下载在后台任务执行（与 db_subscribe_mod 同款契约）：
/// - `{ status: "started", taskId, path, dir }`：已入队，前端等 archive-download-progress 事件；
/// - `{ status: "exists", path }`：目标文件已存在，未重复下载（用户可在资源管理器里自行确认）；
/// - `{ status: "downloading", taskId, path }`：同一文件正在下载，复用既有任务。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_download_mod_archive(
    app_handle: tauri::AppHandle,
    mod_key: String,
    lang_code: String,
    version: Option<String>,
    file_url: String,
    file_name: Option<String>,
    threads: Option<u32>,
    // 悬浮下载条与恢复查询展示用；缺省时前端回退 mod_key
    display_name: Option<String>,
) -> Result<serde_json::Value, String> {
    if file_url.trim().is_empty() {
        return Err("缺少下载地址".into());
    }
    // 游戏目录未配置/无效时回传 GAME_DIR_INVALID——前端 localizeError 已有对应文案
    let game_path = read_game_path(&app_handle)?;
    let dir = ensure_downloads_dir(game_path.trim_end_matches('\\'))?;
    // 清理历史进程残留的 .part 临时文件（本进程活跃任务的不受影响）
    cleanup_stale_parts(&dir);
    let name = resolve_file_name(
        file_name.as_deref().unwrap_or(""),
        &file_url,
        &mod_key,
        &lang_code,
        version.as_deref().unwrap_or(""),
    );
    let target = dir.join(&name);

    // 已存在且非空：直接回 exists，不重复占用带宽。
    // （0 字节的半成品视为无效，继续下载覆盖）
    if let Ok(meta) = fs::metadata(&target) {
        if meta.is_file() && meta.len() > 0 {
            return Ok(serde_json::json!({
                "status": "exists",
                "path": target.to_string_lossy(),
                "dir": dir.to_string_lossy(),
            }));
        }
    }

    // 同一文件正在下载：复用既有任务，避免并发写同一 zip
    let key = target.to_string_lossy().to_lowercase();
    {
        let map = ACTIVE_PATHS.lock().map_err(|_| "下载任务表已损坏".to_string())?;
        if let Some(&tid) = map.get(&key) {
            return Ok(serde_json::json!({
                "status": "downloading",
                "taskId": tid,
                "path": target.to_string_lossy(),
                "dir": dir.to_string_lossy(),
            }));
        }
    }

    let task_id = NEXT_TASK_ID.fetch_add(1, Ordering::Relaxed);
    ACTIVE_PATHS
        .lock()
        .map_err(|_| "下载任务表已损坏".to_string())?
        .insert(key.clone(), task_id);

    let part_path = dir.join(format!(".sfmmm_dl_{task_id}.part"));
    let app = app_handle.clone();
    let url = file_url.clone();
    let mk = mod_key.clone();
    let lc = lang_code.clone();
    let dn = display_name.unwrap_or_default();
    let thread_count = threads.filter(|t| *t > 0).unwrap_or(DEFAULT_DOWNLOAD_THREADS);
    let part_for_task = part_path.clone();
    let target_for_task = target.clone();
    // 立即登记快照：前端拿到 started 后可能会立刻查询活跃任务（例如用户正好
    // 切回详情页），若等首个进度事件才开始登记，会出现短暂的"查不到任务"空窗
    if let Ok(mut map) = TASK_SNAPSHOTS.lock() {
        map.insert(
            task_id,
            ArchiveTaskSnapshot {
                task_id,
                mod_key: mk.clone(),
                lang_code: lc.clone(),
                display_name: dn.clone(),
                percent: 0,
                speed: 0,
                status: "downloading".into(),
                error: String::new(),
                path: target_for_task.to_string_lossy().to_string(),
            },
        );
    }

    // spawn 句柄 drop 后任务照常跑完；取消依赖 CANCEL_FLAGS 里的标志
    // （下载引擎在每个分块 / 每次读之后检查），不靠 abort 打断。
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = CANCEL_FLAGS.lock() {
        m.insert(task_id, Arc::clone(&cancel));
    }
    tokio::spawn(async move {
        // 登记活跃 .part 路径，防止被 cleanup_stale_parts 误删
        if let Ok(mut set) = ACTIVE_PARTS.lock() {
            set.insert(part_for_task.clone());
        }
        let result = run_archive_task(
            app.clone(),
            task_id,
            mk.clone(),
            lc.clone(),
            dn.clone(),
            url,
            part_for_task.clone(),
            target_for_task.clone(),
            thread_count,
            cancel.clone(),
        )
        .await;
        // 取消与否必须区分开：取消是用户主动行为，不该显示成"下载失败"，
        // 且前端拿到 cancelled 后要清掉进度条而不是弹错误。
        let cancelled = cancel.load(Ordering::Relaxed);
        if let Err(e) = result {
            // 失败也摘除快照（emit_progress 内统一处理终态），并保证有终态事件
            emit_progress(
                &app,
                task_id,
                &mk,
                &lc,
                &dn,
                0,
                0,
                if cancelled { "cancelled" } else { "failed" },
                &e,
                &target_for_task.to_string_lossy(),
            );
        }
        // 无论成败都清占用，允许再次点击重下
        if let Ok(mut map) = ACTIVE_PATHS.lock() {
            map.remove(&key);
        }
        if let Ok(meta) = fs::metadata(&part_for_task) {
            if meta.is_file() {
                let _ = fs::remove_file(&part_for_task);
            }
        }
        // 任务结束，撤销活跃登记与取消标志，避免表无限增长
        if let Ok(mut set) = ACTIVE_PARTS.lock() {
            set.remove(&part_for_task);
        }
        if let Ok(mut m) = CANCEL_FLAGS.lock() {
            m.remove(&task_id);
        }
    });

    Ok(serde_json::json!({
        "status": "started",
        "taskId": task_id,
        "path": target.to_string_lossy(),
        "dir": dir.to_string_lossy(),
    }))
}

/// 活跃任务的 .part 临时文件路径集合：重启清理残留 .part 时排除本进程仍在写的文件
static ACTIVE_PARTS: Lazy<Arc<Mutex<std::collections::HashSet<PathBuf>>>> =
    Lazy::new(|| Arc::new(Mutex::new(std::collections::HashSet::new())));

/// 清理历史进程崩溃/被杀残留的 .part 临时文件（排除本进程活跃任务正在写的）。
/// .part 文件名带任务号，任务号重启后从 1 重新自增，跨进程无意义。
fn cleanup_stale_parts(dir: &PathBuf) {
    let active = ACTIVE_PARTS.lock().map(|m| m.clone()).unwrap_or_default();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with(".sfmmm_dl_") && name.ends_with(".part") && !active.contains(&p) {
                let _ = fs::remove_file(&p);
            }
        }
    }
}

/// 后台任务本体：下载到 .part 临时文件，成功后 rename 成正式文件名。
/// 用临时文件而非直写目标名：下载失败/中断不会在下载目录留下半截 zip 被误当可用文件。
async fn run_archive_task(
    app: tauri::AppHandle,
    task_id: i64,
    mod_key: String,
    lang_code: String,
    display_name: String,
    url: String,
    part_path: PathBuf,
    target: PathBuf,
    threads: u32,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let target_str = target.to_string_lossy().to_string();
    emit_progress(
        &app,
        task_id,
        &mod_key,
        &lang_code,
        &display_name,
        0,
        0,
        "downloading",
        "",
        &target_str,
    );

    // 不设总超时：耗时由下载本身决定，避免大文件下到一半被硬超时打断。
    // 建连超时统一用引擎里的常量（8s）：线路劣化时快速失败并回退原始域名，
    // 而不是让用户盯着 0% 干等 30 秒。
    let client = reqwest::Client::builder()
        .connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)
        .user_agent(crate::db::user_agent())
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    let app_for_progress = app.clone();
    let mk_for_progress = mod_key.clone();
    let lc_for_progress = lang_code.clone();
    let dn_for_progress = display_name.clone();
    let target_for_progress = target_str.clone();
    // 引擎内部已做约 400ms 节流，这里直接广播即可
    let on_progress: ProgressFn = Arc::new(move |p: DownloadProgress| {
        emit_progress(
            &app_for_progress,
            task_id,
            &mk_for_progress,
            &lc_for_progress,
            &dn_for_progress,
            p.percent,
            p.speed,
            "downloading",
            "",
            &target_for_progress,
        );
    });

    download_file(
        &client,
        &url,
        &part_path,
        threads,
        on_progress,
        // 用户可在详情页按钮或悬浮条点「取消下载」：置位后引擎停止并删半成品
        cancel.clone(),
    )
    .await?;

    // 收尾竞态：取消可能恰好发生在引擎返回之后、rename 之前。此时若继续落盘并广播
    // done，前端已经把这条任务当"用户主动放弃"移除了，文件却留在目录里无人认领。
    // 因此这里再确认一次，取消就当作任务失败返回，由调用处按 cancelled 广播。
    if cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(&part_path);
        return Err("下载已取消".into());
    }

    // Windows 下 rename 会覆盖同名文件；失败则删旧文件再试一次
    if let Err(e) = fs::rename(&part_path, &target) {
        let _ = fs::remove_file(&target);
        fs::rename(&part_path, &target).map_err(|e2| format!("保存文件失败: {e} / {e2}"))?;
    }

    emit_progress(
        &app,
        task_id,
        &mod_key,
        &lang_code,
        &display_name,
        100,
        0,
        "done",
        "",
        &target_str,
    );
    Ok(())
}

/// 列出仍在进行中的「仅下载」任务（前端悬浮下载条恢复进度用）。
///
/// 只返回内存快照里的活跃任务：终态在 emit 时已摘除，进程重启后任务本身也
/// 不复存在（见 TASK_SNAPSHOTS 的说明）。前端拿到列表后接着 listen
/// `archive-download-progress` 即可无缝续上实时进度。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_archive_tasks() -> Result<Vec<ArchiveTaskSnapshot>, String> {
    let list = TASK_SNAPSHOTS
        .lock()
        .map(|m| m.values().cloned().collect::<Vec<_>>())
        .map_err(|_| "下载任务表已损坏".to_string())?;
    Ok(list)
}

/// 清理上次进程崩溃/被强杀时留在下载目录里的 .part（启动时调一次）。
///
/// 与 subscribe 的临时包同因：`.sfmmm_dl_<taskId>.part` 里的任务号重启后从 1
/// 重新计数，旧文件永远不会再被引用。放在启动而不是 `db_list_archive_tasks`
/// 里，是为了让"查进度"保持纯只读——查询顺手删文件既难预期也难排查。
pub fn cleanup_stale_parts_on_startup(app_handle: &tauri::AppHandle) {
    let Ok(game_path) = read_game_path(app_handle) else { return };
    let dir = PathBuf::from(game_path.trim_end_matches('\\')).join(DOWNLOADS_DIR_NAME);
    if dir.is_dir() {
        cleanup_stale_parts(&dir);
    }
}

/// 取消「仅下载」任务，并删除它已经落下的缓存文件。
///
/// 与安装链路的 db_cancel_subscription 分开：那个任务的下游是游戏目录里的
/// 已解压文件 + 安装记录，取消只需中止下载；这里的唯一产物就是一个 zip，
/// 用户点"取消"的语义就是"我不要这个文件了"，所以连同目标文件一起删。
///
/// 处理三种情形：
/// - 任务在跑：置位取消标志，引擎尽快退出，半成品 .part 由任务收尾删除；
/// - 任务已跑完（快照已摘除，磁盘上有完整 zip）：用调用方给的回填路径删文件；
/// - 任务不存在且没给路径：什么都不做，返回结果供前端提示。
///
/// `path` 只在"任务已结束"时有意义（前端从任务快照里带的落盘路径回填）。
/// 它会被限制在 `<游戏根目录>\sfmmmDownloads` 内，避免这条命令变成任意文件删除。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_cancel_archive_download(
    app_handle: tauri::AppHandle,
    task_id: i64,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    // 1) 置位取消标志（任务活着才有）
    let flagged = {
        let m = CANCEL_FLAGS.lock().map_err(|_| "下载任务表已损坏".to_string())?;
        match m.get(&task_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    };

    // 2) 从快照里取目标路径（任务活着时必有；已结束时为 None）
    let snapshot = TASK_SNAPSHOTS
        .lock()
        .ok()
        .and_then(|m| m.get(&task_id).cloned());

    // 3) 摘除快照：终态由任务收尾或这里兜底，避免"取消了但列表还挂着"
    if let Ok(mut m) = TASK_SNAPSHOTS.lock() {
        m.remove(&task_id);
    }

    // 4) 判断要删的目标：优先快照里的（权威），否则用调用方回填的路径。
    //    后者必须落在下载目录内——这条命令不接受任意路径。
    let downloads_dir = read_game_path(&app_handle)
        .ok()
        .map(|p| PathBuf::from(p.trim_end_matches('\\')).join(DOWNLOADS_DIR_NAME));
    let target_path: Option<PathBuf> = match (snapshot.as_ref(), path.as_deref()) {
        (Some(snap), _) => Some(PathBuf::from(&snap.path)),
        (None, Some(p)) if !p.trim().is_empty() => {
            let candidate = PathBuf::from(p);
            // canonicalize 后比较前缀：仅接受下载目录下的文件
            let ok = match (downloads_dir.as_ref().and_then(|d| d.canonicalize().ok()), candidate.canonicalize().ok()) {
                (Some(dir), Some(file)) => file.starts_with(&dir),
                _ => false,
            };
            if ok { Some(candidate) } else { None }
        }
        _ => None,
    };

    // 5) 删已落盘的完整文件。任务仍在跑时目标还不存在（写的是 .part），
    //    这步自然无操作；任务已结束时它就是那个缓存 zip —— 这正是"移除缓存"。
    let mut removed_target = false;
    if let Some(target) = target_path.as_ref() {
        if target.is_file() {
            removed_target = match fs::remove_file(target) {
                Ok(()) => true,
                Err(e) => {
                    // 文件被占用（资源管理器预览/杀软扫描）等：如实回报，不假装成功
                    return Err(format!("删除下载文件失败: {e}"));
                }
            };
        }
        // 顺带删同任务的 .part（正常流程由任务收尾删，这里防"取消后立刻重启"的残留）
        if let Some(dir) = target.parent() {
            let part = dir.join(format!(".sfmmm_dl_{task_id}.part"));
            if part.is_file() {
                let _ = fs::remove_file(&part);
            }
        }
    }

    // 6) 任务活着才广播终态：已结束的任务前端早已收到 done/failed，
    //    再补一条 cancelled 会让浮条把"已完成"改写成"已取消"
    if let Some(snap) = snapshot.as_ref() {
        emit_progress(
            &app_handle,
            task_id,
            &snap.mod_key,
            &snap.lang_code,
            &snap.display_name,
            0,
            0,
            "cancelled",
            "用户取消",
            &snap.path,
        );
    }

    Ok(serde_json::json!({
        "cancelled": true,
        // flagged=false 且 removedTarget=false：任务早已结束且文件不在，
        // 调用方据此可提示"没有需要清理的内容"
        "flagged": flagged,
        "removedTarget": removed_target,
    }))
}
