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
// 下载复用 db::download 的多线程引擎（服务端支持 Range 时 8 线程分块，失败自动
// 重试/回退单流），与 app 更新、前置安装同一套下载实现。
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

use crate::db::download::{DownloadProgress, ProgressFn, download_file};
use crate::db::subscribe::read_game_path;

/// 下载目录名（位于游戏根目录下）。与安装目录完全隔离，用户可自行取用/删除。
const DOWNLOADS_DIR_NAME: &str = "sfmmmDownloads";

/// 默认分块线程数（与前置安装一致；实际是否并行由服务端 Range 支持情况决定）
const DEFAULT_THREADS: u32 = 8;

/// 目标文件（小写路径）→ taskId：同一文件已在下载时直接复用该任务，
/// 避免重复点按钮把同一个 zip 下载两遍、两个引擎并发写同一文件导致损坏。
static ACTIVE_PATHS: Lazy<Arc<Mutex<HashMap<String, i64>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 任务号自增（仅下载任务用，不落库——没有"重启后恢复"诉求：
/// 下载完就是个 zip 文件，进程重启后重新点一次即可）
static NEXT_TASK_ID: AtomicI64 = AtomicI64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveProgress {
    task_id: i64,
    mod_key: String,
    lang_code: String,
    percent: u32,
    /// 实时下载速度（字节/秒），仅 downloading 阶段有意义
    speed: u64,
    /// downloading / done / failed
    status: String,
    error: String,
    /// 最终落盘路径（下载完成后即完整路径，进行中为 .part 临时路径）
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

fn emit_progress(
    app: &tauri::AppHandle,
    task_id: i64,
    mod_key: &str,
    lang_code: &str,
    percent: u32,
    speed: u64,
    status: &str,
    error: &str,
    path: &str,
) {
    let _ = app.emit(
        "archive-download-progress",
        ArchiveProgress {
            task_id,
            mod_key: mod_key.to_string(),
            lang_code: lang_code.to_string(),
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
    let thread_count = threads.filter(|t| *t > 0).unwrap_or(DEFAULT_THREADS);
    let part_for_task = part_path.clone();
    let target_for_task = target.clone();

    // tokio::spawn 的句柄 drop 只是"不再等待"，任务照常跑完；
    // 这里无需保留句柄（没有取消入口），丢弃即可，故不引入句柄表避免无谓状态。
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
            url,
            part_for_task.clone(),
            target_for_task.clone(),
            thread_count,
        )
        .await;
        if let Err(e) = result {
            emit_progress(
                &app,
                task_id,
                &mk,
                &lc,
                0,
                0,
                "failed",
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
        // 任务结束，撤销活跃登记
        if let Ok(mut set) = ACTIVE_PARTS.lock() {
            set.remove(&part_for_task);
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
    url: String,
    part_path: PathBuf,
    target: PathBuf,
    threads: u32,
) -> Result<(), String> {
    let target_str = target.to_string_lossy().to_string();
    emit_progress(
        &app,
        task_id,
        &mod_key,
        &lang_code,
        0,
        0,
        "downloading",
        "",
        &target_str,
    );

    // 不设总超时：耗时由下载本身决定，避免大文件下到一半被硬超时打断
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .user_agent(concat!(
            "sfmmm/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/b9348/sfmmm)"
        ))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    let app_for_progress = app.clone();
    let mk_for_progress = mod_key.clone();
    let lc_for_progress = lang_code.clone();
    let target_for_progress = target_str.clone();
    // 引擎内部已做约 400ms 节流，这里直接广播即可
    let on_progress: ProgressFn = Arc::new(move |p: DownloadProgress| {
        emit_progress(
            &app_for_progress,
            task_id,
            &mk_for_progress,
            &lc_for_progress,
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
        // 无取消需求（详情页内的短任务）：固定传一个永不置位的标志
        Arc::new(AtomicBool::new(false)),
    )
    .await?;

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
        100,
        0,
        "done",
        "",
        &target_str,
    );
    Ok(())
}