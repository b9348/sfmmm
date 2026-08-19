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
// 多线程下载：服务端支持 Range 时按 threads（默认 8）分块并行下载（渐进式落盘 +
// 进度上报）；单个子块失败会在子任务内重试，仍失败则主线程串行补下失败区间，
// 子线程失败不影响主流程；服务端不支持 Range 时自动回退单流下载。图床与
// GitHub Release 两个更新源共用同一引擎。
//
// 命令：db_prepare_update / db_get_update_status / db_apply_update
use std::collections::HashMap;
use std::fs;
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;
use tokio::task::JoinHandle;

use crate::db::download::{DownloadProgress, ProgressFn, download_file};
use crate::db::gh::build_client;
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
    /// 实时下载速度（字节/秒），仅下载中有效
    speed: u64,
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
    speed: u64,
) {
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            task_id,
            percent,
            stage: stage.into(),
            status: status.into(),
            error: error.into(),
            speed,
        },
    );
}

// ── 失败状态写回（多线程/单流路径共用）────────────────────
fn write_fail(app_handle: &tauri::AppHandle, task_id: i64, stage: &str, err: &str) {
    let _ = update_task_status(app_handle, task_id, "failed", 0, stage, Some(err));
    emit_progress(app_handle, task_id, 0, stage, "failed", err, 0);
}

// ── 主任务体（spawn 执行）──────────────────────────────────
async fn run_update_download_task(app_handle: tauri::AppHandle, task_id: i64, url: String, threads: u32) {
    let _ = update_task_status(&app_handle, task_id, "downloading", 0, "downloading", None);
    emit_progress(&app_handle, task_id, 0, "downloading", "downloading", "", 0);

    // 复用 gh.rs 的客户端构建（代理遵循 reqwest 默认系统代理检测，不做额外干预）
    let client = match build_client(300) {
        Ok(c) => c,
        Err(e) => {
            write_fail(&app_handle, task_id, "downloading", &format!("构建 HTTP client 失败: {e}"));
            return;
        }
    };
    let path = match installer_path(&app_handle) {
        Ok(p) => p,
        Err(e) => {
            write_fail(&app_handle, task_id, "downloading", &e);
            return;
        }
    };

    // 共享多线程下载引擎（db/download.rs）：内部完成 Range 探测 → 分块并行 / 单流回退，
    // 节流上报进度（percent + downloaded + total + speed），回调里写库 + 广播。
    let app = app_handle.clone();
    let on_progress: ProgressFn = Arc::new(move |p: DownloadProgress| {
        let _ = update_task_status(&app, task_id, "downloading", p.percent, "downloading", None);
        emit_progress(&app, task_id, p.percent, "downloading", "downloading", "", p.speed);
    });
    if let Err(e) = download_file(&client, &url, &path, threads, on_progress).await {
        write_fail(&app_handle, task_id, "downloading", &e);
        return; // 半成品文件已由引擎删除
    }

    // ready：安装包已就绪，等用户"重启并更新"（或下次启动自动应用）
    let _ = update_task_status(&app_handle, task_id, "ready", 100, "done", None);
    emit_progress(&app_handle, task_id, 100, "done", "ready", "", 0);
    // 清理句柄
    if let Ok(mut m) = tasks().lock() {
        m.remove(&task_id);
    }
}

// ── Tauri 命令 ─────────────────────────────────────────────

/// 创建更新安装包下载后台任务并立即返回 task_id；下载在 Rust 后台执行，
/// 离开设置页/切换标签不中断，进度通过全局事件 "update-progress" 广播。
/// threads 指定分块下载线程数（默认 8，范围 1-16；服务端不支持 Range 时
/// 自动回退单流）。图床与 GitHub Release 两个更新源共用此命令。
/// 去重：仅当查到的运行态任务在本进程内确实有句柄（TASK_HANDLES）时才复用，
/// 避免重复下载；进程重启后残留的运行态行没有句柄接管，重置为 failed 后新建任务。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_prepare_update(
    app_handle: tauri::AppHandle,
    url: String,
    version: Option<String>,
    threads: Option<u32>,
) -> Result<serde_json::Value, String> {
    let threads = threads.unwrap_or(8).clamp(1, 16);
    let version = version.unwrap_or_default();
    let conn = open_sqlite(&app_handle)?;
    // 去重复用任意存活任务（不区分 URL）：所有下载任务都写同一个目标文件
    // installer_path()（sfmmm_update.exe），若对不同 URL 各自新建任务会导致两个
    // 后台任务并发截断/写入同一文件，安装包损坏。因此只要本进程有存活任务就
    // 复用（单一写入者），不新建并发任务。
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
        // 本进程确实在后台跑：复用，不重下。仅当复用任务尚未开始下载
        // （status='pending'）且 URL 一致时才同步版本——已进入 downloading 的
        // 任务正在写文件，重标版本会让 ready 行声称是最新版本而安装包实际是
        // 旧构建（前端据此静默安装旧版）；保留原版本则前端版本门会触发重新下载
        if !version.is_empty() {
            if let Err(e) = conn.execute(
                "UPDATE update_tasks SET version = ? WHERE id = ? AND url = ? AND status = 'pending'",
                rusqlite::params![version, id, url],
            ) {
                log::warn!("[update] 同步复用任务版本失败: {e}");
            }
        }
        (id, false)
    } else {
        // 无进行中任务，或上次进程残留的运行态行（句柄表为空，无人接管）——
        // 残留行先重置为 failed，再新建任务，保证下载能真正重新拉起
        if let Some(id) = existing {
            let _ = reset_stale_task(&conn, id);
        }
        let id = conn
            .query_row(
                "INSERT INTO update_tasks (url, version, status) VALUES (?, ?, 'pending') RETURNING id",
                rusqlite::params![url, version],
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
        run_update_download_task(app, task_id, url, threads).await;
    });
    if let Ok(mut m) = tasks().lock() {
        m.insert(task_id, handle);
    }

    Ok(serde_json::json!({ "taskId": task_id }))
}

/// 将 update_tasks 行映射为前端状态 JSON。
/// 参数顺序与 SELECT 列序（id, url, version, status, percent, stage, error,
/// created_at, updated_at, finished_at）一一对应，抽成纯函数便于单测列序不漂移。
fn status_row_json(
    id: i64,
    url: &str,
    version: &str,
    status: &str,
    percent: i64,
    stage: &str,
    error: &str,
    created_at: &str,
    updated_at: &str,
    finished_at: &str,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "url": url,
        "version": version,
        "status": status,
        "percent": percent,
        "stage": stage,
        "error": error,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "finishedAt": finished_at,
    })
}

/// 清除 config 表中的待应用更新标志（单一写入点，消除与前端 ready 事件异步写入的竞态）
fn clear_pending_update(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM config WHERE `key` = 'pending_update'", [])
        .map(|_| ())
        .map_err(|e| format!("清除 pending_update 标志失败: {e}"))
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
            "SELECT id, url, version, status, percent, stage, error, created_at, updated_at, finished_at
             FROM update_tasks ORDER BY id DESC LIMIT 1",
            [],
            |r| {
                Ok(status_row_json(
                    r.get::<_, i64>(0)?,
                    &r.get::<_, String>(1)?,
                    &r.get::<_, String>(2)?,
                    &r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    &r.get::<_, String>(5)?,
                    &r.get::<_, String>(6)?,
                    &r.get::<_, String>(7)?,
                    &r.get::<_, String>(8)?,
                    &r.get::<_, String>(9)?,
                ))
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
            } else if v.get("status").and_then(|s| s.as_str()) == Some("failed") {
                // 失败的过期残留（安装包不存在，如网络失败后已清理）：
                // 直接删除任务记录并返回 null，避免每次打开设置页都显示过期的下载失败错误
                if let Some(id) = v.get("id").and_then(|x| x.as_i64()) {
                    let _ = conn.execute("DELETE FROM update_tasks WHERE id = ?", rusqlite::params![id]);
                }
                return Ok(serde_json::Value::Null);
            }
            // 供前端判断"就绪安装包是否确实在盘上"：ready 任务行可能是残留
            // （安装包已被上次 bat 安装成功后删除/安装失败清理），文件缺失时
            // 前端应重新下载而非提升 pending_update，避免对不存在的包重复 applyUpdate
            v["installerExists"] = serde_json::json!(has_installer);
            Ok(v)
        }
        None if has_installer => Ok(serde_json::json!({
            "id": 0,
            "url": "",
            "version": "",
            "status": "ready",
            "percent": 100,
            "stage": "done",
            "error": "",
            "installerExists": true,
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
    // 注意：bat 内容必须保持纯 ASCII。cmd.exe 按系统 ANSI 代码页（中文系统为 GBK）
    // 读取 bat 文件，若把含中文的路径直接写入内容（UTF-8 字节）会被 GBK 误读成乱码
    // （如 "初\" → "鍒濆"），导致安装包路径失效、更新失败。因此路径一律通过命令行
    // 参数（%~1/%~2）传入——Windows 命令行是 UTF-16 宽字符，天然支持中文路径，
    // 不受代码页影响（用户目录为中文用户名时同样成立）。
    let bat_path = std::env::temp_dir().join("sfmmm_restart_update.bat");
    // /S  = NSIS 静默模式
    // /UPDATE = Tauri NSIS 模板约定的升级参数：跳过"卸载旧版本/请勿卸载"询问页，
    //           直接覆盖安装，保留 %APPDATA%\com.sfmmm.app 下的 sqlite 数据
    let bat_content = "\
@echo off\r\n\
rem wait for the current app to fully exit\r\n\
ping 127.0.0.1 -n 5 > nul\r\n\
\r\n\
rem silently update (overwrite install, keep app data)\r\n\
\"%~1\" /S /UPDATE\r\n\
\r\n\
rem launch the updated app\r\n\
start \"\" \"%~2\"\r\n\
\r\n\
rem remove the installer package to avoid re-prompting on next start\r\n\
del \"%~1\" > nul 2>&1\r\n\
\r\n\
rem remove this script\r\n\
del \"%~f0\" > nul 2>&1\r\n";
    std::fs::write(&bat_path, &bat_content)
        .map_err(|e| format!("创建更新脚本失败: {}", e))?;

    // 启动 bat 脚本（独立进程，不受当前进程退出影响）
    // Windows 上 .bat 默认会弹出 cmd 控制台窗口，用 CREATE_NO_WINDOW 隐藏
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new(&bat_path);
        c.arg(&path).arg(&current_exe);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new(&bat_path);
        c.arg(&path).arg(&current_exe);
        c
    };

    cmd.spawn()
        .map_err(|e| format!("启动更新脚本失败: {}", e))?;

    // 同步清除待更新标志（单一写入点，消除与前端 ready 事件异步写入 pending_update
    // 的竞态）：走到 spawn 成功这一步即代表更新已确定要执行，此时才消费标志并退出，
    // 避免新进程读到残留标志对已删除的安装包重复 applyUpdate（bat 安装成功后 del 包）。
    // 注意必须在 spawn 成功之后清理：若 bat 写入/启动失败（返回 Err），标志保留，
    // 下次启动仍可重试自动应用，而不是白白丢掉一个已就绪的有效安装包。
    match open_sqlite(&app_handle) {
        Ok(conn) => {
            if let Err(e) = clear_pending_update(&conn) {
                log::warn!("[update] {e}");
            }
        }
        Err(e) => log::warn!("[update] 打开 SQLite 清除 pending_update 标志失败: {e}"),
    }

    // 退出当前应用，避免安装程序无法覆盖运行中的 exe
    app_handle.exit(0);

    // 注意：exit 会终止进程，因此 Ok 返回值不会到达前端
    Ok("更新程序已启动，应用将自动更新并重启".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// 构造与 lib.rs migration 14（create_update_tasks）一致的 update_tasks 表结构
    fn create_update_tasks_without_version(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS update_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                percent INTEGER DEFAULT 0,
                stage TEXT DEFAULT '',
                error TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT DEFAULT ''
            );",
        )
        .unwrap();
    }

    /// 构造与 lib.rs migration 2（ensure_tables_exist）一致的 config 表结构
    fn create_config_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS config (
                id INTEGER PRIMARY KEY,
                `key` TEXT NOT NULL UNIQUE,
                value TEXT
            );",
        )
        .unwrap();
    }

    /// migration 16 契约：ALTER TABLE 新增 version 列后，插入/读取 version 往返一致
    #[test]
    fn migration16_version_column_roundtrips() {
        let conn = Connection::open_in_memory().unwrap();
        create_update_tasks_without_version(&conn);
        // 执行 migration 16 的 SQL
        conn.execute_batch("ALTER TABLE update_tasks ADD COLUMN version TEXT DEFAULT ''")
            .unwrap();

        conn.execute(
            "INSERT INTO update_tasks (url, version, status) VALUES ('https://example.com/setup.exe', '1.2.3', 'pending')",
            [],
        )
        .unwrap();
        let ver: String = conn
            .query_row("SELECT version FROM update_tasks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ver, "1.2.3");
    }

    /// status_row_json 列序映射：SELECT 10 列的索引 → JSON 字段一一对应
    #[test]
    fn status_row_json_maps_select_columns_in_order() {
        let conn = Connection::open_in_memory().unwrap();
        create_update_tasks_without_version(&conn);
        conn.execute_batch("ALTER TABLE update_tasks ADD COLUMN version TEXT DEFAULT ''")
            .unwrap();
        conn.execute(
            "INSERT INTO update_tasks (url, version, status, percent, stage, error) VALUES ('https://example.com/setup.exe', '2.0.0', 'ready', 100, 'done', '')",
            [],
        )
        .unwrap();

        let v: serde_json::Value = conn
            .query_row(
                "SELECT id, url, version, status, percent, stage, error, created_at, updated_at, finished_at
                 FROM update_tasks ORDER BY id DESC LIMIT 1",
                [],
                |r| {
                    Ok(status_row_json(
                        r.get::<_, i64>(0)?,
                        &r.get::<_, String>(1)?,
                        &r.get::<_, String>(2)?,
                        &r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        &r.get::<_, String>(5)?,
                        &r.get::<_, String>(6)?,
                        &r.get::<_, String>(7)?,
                        &r.get::<_, String>(8)?,
                        &r.get::<_, String>(9)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(v["version"], "2.0.0");
        assert_eq!(v["status"], "ready");
        assert_eq!(v["percent"], 100);
        assert_eq!(v["stage"], "done");
        assert_eq!(v["url"], "https://example.com/setup.exe");
    }

    /// clear_pending_update 删除 config 表中的待应用标志
    #[test]
    fn clear_pending_update_deletes_flag() {
        let conn = Connection::open_in_memory().unwrap();
        create_config_table(&conn);
        conn.execute(
            "INSERT INTO config (`key`, value) VALUES ('pending_update', 'true')",
            [],
        )
        .unwrap();
        clear_pending_update(&conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM config WHERE `key` = 'pending_update'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
