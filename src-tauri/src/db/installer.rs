// 更新安装包下载 / 应用：installer_path、db_prepare_update、db_apply_update。
//
// 改造前：db_prepare_update 通过 invoke 直连 Channel 流式回传进度，进度/状态只存在
//         前端 GameSettings 组件内存里——离开设置页/切换标签组件卸载后事件无人接收，
//         重新进入只能看到初始态"立即更新"（经典 Web 跨端问题，与订阅下载同款）。
// 改造后：下载迁至 Rust 后台任务（与 db/subscribe.rs、db/bepinex.rs 同模式），
//         与前端组件生命周期解耦；进度通过全局事件 "update-progress" 广播，
//         状态持久化到 SQLite update_tasks 表，任何页面/重启后 db_get_update_status
//         都能恢复进度/错误/已就绪。
//
// 命令：db_prepare_update / db_get_update_status / db_apply_update
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;
use tokio::task::JoinHandle;

use crate::db::subscribe::open_sqlite;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn installer_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(data_dir.join("sfmmm_update.exe"))
}

// ── 全局任务句柄表（与 subscribe.rs / bepinex.rs 同款）─────────────────
static TASK_HANDLES: Lazy<Arc<Mutex<HashMap<i64, JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn tasks() -> &'static Mutex<HashMap<i64, JoinHandle<()>>> {
    &TASK_HANDLES
}

/// 该任务在本进程内是否真的有后台任务在跑（有句柄 = 活着）
fn task_alive(id: i64) -> bool {
    tasks().lock().map(|m| m.contains_key(&id)).unwrap_or(false)
}

/// 将残留运行态行重置为 failed/interrupted（进程重启后无人接管的下载）
fn reset_stale_task(conn: &Connection, id: i64) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE update_tasks
         SET status = 'failed', percent = 0, stage = 'interrupted',
             error = '上次下载被中断，请重新下载', updated_at = ?, finished_at = ?
         WHERE id = ?",
        rusqlite::params![now, now, id],
    )
    .map_err(|e| format!("重置陈旧任务失败: {e}"))?;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    task_id: i64,
    percent: u32,
    stage: String,
    status: String,
    error: String,
}

// ── 任务状态写回（update_tasks 表）────────────────────────
fn update_task_status(
    app_handle: &tauri::AppHandle,
    task_id: i64,
    status: &str,
    percent: u32,
    stage: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_sqlite(app_handle)?;
    let now = chrono::Utc::now().to_rfc3339();
    let finished = if status == "ready" || status == "failed" || status == "cancelled" {
        Some(now.clone())
    } else {
        None
    };
    conn.execute(
        "UPDATE update_tasks SET status = ?, percent = ?, stage = ?, error = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![status, percent as i64, stage, error.map(|e| e.to_string()).unwrap_or_default(), now, task_id],
    )
    .map_err(|e| format!("更新任务状态失败: {e}"))?;
    if let Some(ts) = finished {
        let _ = conn.execute(
            "UPDATE update_tasks SET finished_at = ? WHERE id = ?",
            rusqlite::params![ts, task_id],
        );
    }
    Ok(())
}

fn emit_progress(
    app_handle: &tauri::AppHandle,
    task_id: i64,
    percent: u32,
    stage: &str,
    status: &str,
    error: &str,
) {
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            task_id,
            percent,
            stage: stage.into(),
            status: status.into(),
            error: error.into(),
        },
    );
}

// ── 主任务体（spawn 执行）──────────────────────────────────
async fn run_update_download_task(app_handle: tauri::AppHandle, task_id: i64, url: String) {
    // 失败辅助：独立 async fn 避免闭包引用 lifetime 问题（同 subscribe.rs 做法）
    async fn fail(app_handle: &tauri::AppHandle, task_id: i64, stage: &str, err: &str) {
        let _ = update_task_status(app_handle, task_id, "failed", 0, stage, Some(err));
        emit_progress(app_handle, task_id, 0, stage, "failed", err);
    }

    let _ = update_task_status(&app_handle, task_id, "downloading", 0, "downloading", None);
    emit_progress(&app_handle, task_id, 0, "downloading", "downloading", "");

    // 流式下载到应用数据目录（与订阅下载同款 reqwest 客户端）
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            fail(&app_handle, task_id, "downloading", &format!("构建 HTTP client 失败: {e}")).await;
            return;
        }
    };
    let response = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            fail(&app_handle, task_id, "downloading", &format!("下载失败 HTTP {}", r.status())).await;
            return;
        }
        Err(e) => {
            fail(&app_handle, task_id, "downloading", &format!("下载失败: {e}")).await;
            return;
        }
    };
    let total = response.content_length().unwrap_or(0);
    let path = match installer_path(&app_handle) {
        Ok(p) => p,
        Err(e) => {
            fail(&app_handle, task_id, "downloading", &e).await;
            return;
        }
    };
    let mut file = match fs::File::create(&path) {
        Ok(f) => f,
        Err(e) => {
            fail(&app_handle, task_id, "downloading", &format!("创建文件失败: {e}")).await;
            return;
        }
    };
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
                if let Err(e) = file.write_all(&c) {
                    fail(&app_handle, task_id, "downloading", &format!("写入文件失败: {e}")).await;
                    let _ = fs::remove_file(&path);
                    return;
                }
                downloaded += c.len() as u64;
                let percent = if total > 0 { (downloaded * 100 / total) as u32 } else { 0 };
                let _ = update_task_status(&app_handle, task_id, "downloading", percent, "downloading", None);
                emit_progress(&app_handle, task_id, percent, "downloading", "downloading", "");
            }
            Err(e) => {
                fail(&app_handle, task_id, "downloading", &format!("下载中断: {e}")).await;
                let _ = fs::remove_file(&path);
                return;
            }
        }
    }
    drop(file);

    // ready：安装包已就绪，等用户"重启并更新"（或下次启动自动应用）
    let _ = update_task_status(&app_handle, task_id, "ready", 100, "done", None);
    emit_progress(&app_handle, task_id, 100, "done", "ready", "");
    // 清理句柄
    if let Ok(mut m) = tasks().lock() {
        m.remove(&task_id);
    }
}

// ── Tauri 命令 ─────────────────────────────────────────────

/// 创建更新安装包下载后台任务并立即返回 task_id；下载在 Rust 后台执行，
/// 离开设置页/切换标签不中断，进度通过全局事件 "update-progress" 广播。
/// 去重：仅当查到的运行态任务在本进程内确实有句柄（TASK_HANDLES）时才复用，
/// 避免重复下载；进程重启后残留的运行态行没有句柄接管，重置为 failed 后新建任务。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_prepare_update(
    app_handle: tauri::AppHandle,
    url: String,
) -> Result<serde_json::Value, String> {
    let conn = open_sqlite(&app_handle)?;
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM update_tasks
             WHERE status IN ('pending', 'downloading')
             ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    let (task_id, is_new) = if let Some(id) = existing.filter(|&id| task_alive(id)) {
        // 本进程确实在后台跑：复用，不重下
        (id, false)
    } else {
        // 无进行中任务，或上次进程残留的运行态行（句柄表为空，无人接管）——
        // 残留行先重置为 failed，再新建任务，保证下载能真正重新拉起
        if let Some(id) = existing {
            let _ = reset_stale_task(&conn, id);
        }
        let id = conn
            .query_row(
                "INSERT INTO update_tasks (url, status) VALUES (?, 'pending') RETURNING id",
                rusqlite::params![url],
                |r| r.get(0),
            )
            .map_err(|e| format!("写入任务记录失败: {e}"))?;
        (id, true)
    };
    drop(conn);

    if !is_new {
        return Ok(serde_json::json!({ "taskId": task_id, "deduplicated": true }));
    }

    // spawn 后台任务
    let app = app_handle.clone();
    let handle: JoinHandle<()> = tokio::spawn(async move {
        run_update_download_task(app, task_id, url).await;
    });
    if let Ok(mut m) = tasks().lock() {
        m.insert(task_id, handle);
    }

    Ok(serde_json::json!({ "taskId": task_id }))
}

/// 查询最近一次更新下载任务状态（设置页挂载时恢复进行中进度/错误/已就绪）。
/// 无任务记录但安装包已存在（旧版本下载完成的残留）时按已就绪返回；
/// 完全无记录返回 null，前端据此走默认态。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_update_status(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conn = open_sqlite(&app_handle)?;
    // 进程重启后残留的运行态行（本进程没有句柄接管）先重置为 failed，
    // 避免前端永久显示"下载中"并停留在不可恢复的转圈状态
    let stale_ids: Vec<i64> = conn
        .prepare(
            "SELECT id FROM update_tasks
             WHERE status IN ('pending', 'downloading')",
        )
        .map_err(|e| format!("查询任务失败: {e}"))?
        .query_map([], |r| r.get(0))
        .map_err(|e| format!("查询任务失败: {e}"))?
        .filter_map(Result::ok)
        .filter(|id| !task_alive(*id))
        .collect();
    for id in stale_ids {
        let _ = reset_stale_task(&conn, id);
    }
    let row: Option<serde_json::Value> = conn
        .query_row(
            "SELECT id, url, status, percent, stage, error, created_at, updated_at, finished_at
             FROM update_tasks ORDER BY id DESC LIMIT 1",
            [],
            |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "url": r.get::<_, String>(1)?,
                    "status": r.get::<_, String>(2)?,
                    "percent": r.get::<_, i64>(3)?,
                    "stage": r.get::<_, String>(4)?,
                    "error": r.get::<_, String>(5)?,
                    "createdAt": r.get::<_, String>(6)?,
                    "updatedAt": r.get::<_, String>(7)?,
                    "finishedAt": r.get::<_, String>(8)?,
                }))
            },
        )
        .optional()
        .map_err(|e| format!("查询任务失败: {e}"))?;
    // 兜底：旧版本下载完成后不留任务记录，安装包在即视为已就绪
    let has_installer = installer_path(&app_handle).map(|p| p.exists()).unwrap_or(false);
    match row {
        Some(mut v) => {
            if has_installer && v.get("status").and_then(|s| s.as_str()) == Some("failed") {
                // 任务失败但安装包完整落盘（如仅状态写入失败）：按已就绪处理
                v["status"] = serde_json::json!("ready");
                v["percent"] = serde_json::json!(100);
                v["stage"] = serde_json::json!("done");
            }
            Ok(v)
        }
        None if has_installer => Ok(serde_json::json!({
            "id": 0,
            "url": "",
            "status": "ready",
            "percent": 100,
            "stage": "done",
            "error": "",
        })),
        None => Ok(serde_json::Value::Null),
    }
}

/// 清理过期的已就绪更新（残留）：删除 ready 任务记录与已下载的安装包。
/// 场景：旧版本下载完成后任务/安装包残留，即使当前已是最新版本仍一直提示
/// "立即重启并更新"。由前端在恢复 ready 状态并与最新版本比对后调用。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_clear_update(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let conn = open_sqlite(&app_handle)?;
    conn.execute("DELETE FROM update_tasks WHERE status = 'ready'", [])
        .map_err(|e| format!("清理更新任务记录失败: {e}"))?;
    if let Ok(p) = installer_path(&app_handle) {
        if p.exists() {
            let _ = fs::remove_file(&p);
        }
    }
    Ok(serde_json::json!({ "cleared": true }))
}

/// 启动已下载的安装包并退出当前应用，安装完成后自动重启
#[tauri::command]
pub async fn db_apply_update(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = installer_path(&app_handle)?;
    if !path.exists() {
        return Err("未找到更新安装包，请重新检查更新".into());
    }

    // 获取当前 exe 路径（安装后的新版本会覆盖此路径）
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("无法获取当前可执行路径: {}", e))?;

    // 创建临时 bat 脚本：等待当前进程退出 → 静默升级 → 启动新版本
    let bat_path = std::env::temp_dir().join("sfmmm_restart_update.bat");
    // /S  = NSIS 静默模式
    // /UPDATE = Tauri NSIS 模板约定的升级参数：跳过"卸载旧版本/请勿卸载"询问页，
    //           直接覆盖安装，保留 %APPDATA%\com.sfmmm.app 下的 sqlite 数据
    let bat_content = format!(
        "@echo off\r\n\
         rem 等待当前应用完全退出\r\n\
         ping 127.0.0.1 -n 5 > nul\r\n\r\n\
         rem 静默升级（不卸载旧版本，直接覆盖）\r\n\
         \"{}\" /S /UPDATE\r\n\r\n\
         rem 启动更新后的应用\r\n\
         start \"\" \"{}\"\r\n\r\n\
         rem 删除更新包，避免残留导致下次启动仍提示可更新\r\n\
         del \"{}\" > nul 2>&1\r\n\r\n\
         rem 删除自身\r\n\
         del \"{}\" > nul 2>&1\r\n",
        path.display(),
        current_exe.display(),
        path.display(),
        bat_path.display(),
    );
    std::fs::write(&bat_path, &bat_content)
        .map_err(|e| format!("创建更新脚本失败: {}", e))?;

    // 启动 bat 脚本（独立进程，不受当前进程退出影响）
    // Windows 上 .bat 默认会弹出 cmd 控制台窗口，用 CREATE_NO_WINDOW 隐藏
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new(&bat_path);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = std::process::Command::new(&bat_path);

    cmd.spawn()
        .map_err(|e| format!("启动更新脚本失败: {}", e))?;

    // 退出当前应用，避免安装程序无法覆盖运行中的 exe
    app_handle.exit(0);

    // 注意：exit 会终止进程，因此 Ok 返回值不会到达前端
    Ok("更新程序已启动，应用将自动更新并重启".into())
}
