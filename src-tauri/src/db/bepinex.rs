// BepInEx 前置一键安装：与创意工坊订阅下载（db/subscribe.rs）同一套后台任务模式。
//
// 改造前：前端 BepInExPrereqBanner / ModList 里用 invoke + Channel 直连下载，
//         Channel 与前端调用绑定，离开页面/切换标签就中断下载（经典 Web 跨端问题）。
// 改造后：下载→解压全链路迁至 Rust 后台任务，与前端组件生命周期解耦，
//         进度通过全局事件 "bepinex-progress" 广播，前端任意页面 listen 即可刷新。
//         任务状态持久化到 SQLite bepinex_tasks 表，重启后残留的运行态行
//         （无进程内任务句柄接管）自动重置为 failed，可重新发起安装。
//
// 命令：db_install_bepinex / db_get_bepinex_task
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::Emitter;
use tokio::task::JoinHandle;

use crate::db::subscribe::{config_db_path, open_sqlite, read_game_path};

// ── 全局任务句柄表（与 subscribe.rs 同款）──────────────────
static TASK_HANDLES: Lazy<Arc<Mutex<HashMap<i64, JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn tasks() -> &'static Mutex<HashMap<i64, JoinHandle<()>>> {
    &TASK_HANDLES
}

// ── 陈旧任务识别与重置（重启恢复的关键）────────────────────
// 任务"存活"只由内存 TASK_HANDLES 表判定：进程重启后句柄表为空，
// DB 里残留的运行态行（pending/downloading/extracting）不会被任何任务接管，
// 必须在创建/查询前重置为 failed，否则去重会永久拦截后续安装、前端也永远
// 停留在"安装中"。

/// 该任务在本进程内是否真的有后台任务在跑（有句柄 = 活着）
fn task_alive(id: i64) -> bool {
    tasks().lock().map(|m| m.contains_key(&id)).unwrap_or(false)
}

/// 将残留运行态行重置为 failed/interrupted（进程重启后无人接管的下载）
fn reset_stale_task(conn: &Connection, id: i64) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE bepinex_tasks
         SET status = 'failed', percent = 0, stage = 'interrupted',
             error = '上次安装被中断，请重新安装', updated_at = ?, finished_at = ?
         WHERE id = ?",
        rusqlite::params![now, now, id],
    )
    .map_err(|e| format!("重置陈旧任务失败: {e}"))?;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BepinexProgress {
    task_id: i64,
    percent: u32,
    stage: String,
    status: String,
    error: String,
}

// ── 任务状态写回（bepinex_tasks 表）────────────────────────
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
    let finished = if status == "done" || status == "failed" || status == "cancelled" {
        Some(now.clone())
    } else {
        None
    };
    conn.execute(
        "UPDATE bepinex_tasks SET status = ?, percent = ?, stage = ?, error = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![status, percent as i64, stage, error.map(|e| e.to_string()).unwrap_or_default(), now, task_id],
    )
    .map_err(|e| format!("更新任务状态失败: {e}"))?;
    if let Some(ts) = finished {
        let _ = conn.execute(
            "UPDATE bepinex_tasks SET finished_at = ? WHERE id = ?",
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
        "bepinex-progress",
        BepinexProgress {
            task_id,
            percent,
            stage: stage.into(),
            status: status.into(),
            error: error.into(),
        },
    );
}

// ── 主任务体（spawn 执行）──────────────────────────────────
async fn run_bepinex_task(app_handle: tauri::AppHandle, task_id: i64, url: String) {
    // 失败辅助：独立 async fn 避免闭包引用 lifetime 问题（同 subscribe.rs 做法）
    async fn fail(app_handle: &tauri::AppHandle, task_id: i64, stage: &str, err: &str) {
        let _ = update_task_status(app_handle, task_id, "failed", 0, stage, Some(err));
        emit_progress(app_handle, task_id, 0, stage, "failed", err);
    }

    // 1) 读游戏目录（后台任务自洽，不依赖前端传参）
    let game_path = match read_game_path(&app_handle) {
        Ok(p) => p,
        Err(e) => {
            fail(&app_handle, task_id, "init", &e).await;
            return;
        }
    };
    let target_dir = game_path.trim_end_matches('\\').to_string();

    let _ = update_task_status(&app_handle, task_id, "downloading", 0, "downloading", None);
    emit_progress(&app_handle, task_id, 0, "downloading", "downloading", "");

    // 2) 流式下载到临时文件
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
    let temp_path = std::env::temp_dir().join(format!("sfmmm_bepinex_{}.7z", task_id));
    let mut file = match fs::File::create(&temp_path) {
        Ok(f) => f,
        Err(e) => {
            fail(&app_handle, task_id, "downloading", &format!("创建临时文件失败: {e}")).await;
            return;
        }
    };
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
                if let Err(e) = file.write_all(&c) {
                    fail(&app_handle, task_id, "downloading", &format!("写入临时文件失败: {e}")).await;
                    let _ = fs::remove_file(&temp_path);
                    return;
                }
                downloaded += c.len() as u64;
                let percent = if total > 0 { (downloaded * 100 / total) as u32 } else { 0 };
                let _ = update_task_status(&app_handle, task_id, "downloading", percent, "downloading", None);
                emit_progress(&app_handle, task_id, percent, "downloading", "downloading", "");
            }
            Err(e) => {
                fail(&app_handle, task_id, "downloading", &format!("下载中断: {e}")).await;
                let _ = fs::remove_file(&temp_path);
                return;
            }
        }
    }
    drop(file);

    // 3) 解压到游戏根目录（.7z 格式，用 sevenz_rust，与原 download_and_extract_7z 一致）
    let _ = update_task_status(&app_handle, task_id, "extracting", 100, "extracting", None);
    emit_progress(&app_handle, task_id, 100, "extracting", "extracting", "");
    if let Err(e) = sevenz_rust::decompress_file(&temp_path, &target_dir) {
        fail(&app_handle, task_id, "extracting", &format!("解压失败: {e}")).await;
        let _ = fs::remove_file(&temp_path);
        return;
    }
    let _ = fs::remove_file(&temp_path);

    // 4) done
    let _ = update_task_status(&app_handle, task_id, "done", 100, "done", None);
    emit_progress(&app_handle, task_id, 100, "done", "done", "");
    // 清理句柄
    if let Ok(mut m) = tasks().lock() {
        m.remove(&task_id);
    }
}

// ── Tauri 命令 ─────────────────────────────────────────────

/// 创建 BepInEx 前置安装后台任务并立即返回 task_id；下载/解压在后台执行，不阻塞前端。
/// 去重：仅当查到的运行态任务在本进程内确实有句柄（TASK_HANDLES）时才复用，
/// 避免重复下载；进程重启后残留的运行态行没有句柄接管，重置为 failed 后新建任务。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_install_bepinex(
    app_handle: tauri::AppHandle,
    url: String,
) -> Result<serde_json::Value, String> {
    let conn = open_sqlite(&app_handle)?;
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM bepinex_tasks
             WHERE status IN ('pending', 'downloading', 'extracting')
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
        // 残留行先重置为 failed，再新建任务，保证安装能真正重新拉起
        if let Some(id) = existing {
            let _ = reset_stale_task(&conn, id);
        }
        let id = conn
            .query_row(
                "INSERT INTO bepinex_tasks (url, status) VALUES (?, 'pending') RETURNING id",
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
        run_bepinex_task(app, task_id, url).await;
    });
    if let Ok(mut m) = tasks().lock() {
        m.insert(task_id, handle);
    }

    Ok(serde_json::json!({ "taskId": task_id }))
}

/// 查询最近一次 BepInEx 安装任务状态（前端挂载时恢复进行中进度/错误）。
/// 无任务记录时返回 null（不报错），前端据此走"未安装"默认态。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_bepinex_task(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let conn = open_sqlite(&app_handle)?;
    // 进程重启后残留的运行态行（本进程没有句柄接管）先重置为 failed，
    // 避免前端永久显示"安装中"并停留在不可恢复的转圈状态
    let stale_ids: Vec<i64> = conn
        .prepare(
            "SELECT id FROM bepinex_tasks
             WHERE status IN ('pending', 'downloading', 'extracting')",
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
             FROM bepinex_tasks ORDER BY id DESC LIMIT 1",
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
    Ok(row.map(|v| v).unwrap_or(serde_json::Value::Null))
}
