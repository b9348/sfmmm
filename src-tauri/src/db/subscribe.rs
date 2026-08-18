// 创意工坊订阅下载：把原来在前端 installMod.js 里执行的下载→解压→哈希→写库
// 全链路迁到 Rust 后台任务，使其不依赖前端组件生命周期——离开页面/切换标签
// 照常执行。任务状态持久化到 SQLite subscription_tasks 表，重启可恢复。
//
// 命令：db_subscribe_mod / db_list_subscription_tasks / db_cancel_subscription
//
// 进度通过 app_handle.emit("subscription-progress", …) 全局广播，前端任意页面
// listen 即可刷新；不依赖 invoke 的 Channel（Channel 与前端调用绑定，离开页面就断）。
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;
use serde_json;
use sha2::{Digest, Sha256};
use std::io::Read;
use tauri::Emitter;
use tauri::Manager;
use tokio::task::JoinHandle;
use mysql::prelude::*;
use zip::ZipArchive;

use crate::db::{with_conn_pool, DbState};

// ── 全局任务句柄表（取消用）──────────────────────────────
// 用 once_cell + 函数封装而非 lazy_static 宏，避免宏展开在闭包里类型推断崩
use once_cell::sync::Lazy;
static TASK_HANDLES: Lazy<Arc<Mutex<HashMap<i64, JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

fn tasks() -> &'static Mutex<HashMap<i64, JoinHandle<()>>> {
    &TASK_HANDLES
}

// ── SQLite 路径 ────────────────────────────────────────────
// tauri_plugin_sql 把 "sqlite:config.db" 解析到 app_data_dir 下（开发时为工作目录）。
// rusqlite 必须打开同一文件才能与前端 getDb() 共享 subscription_tasks 表。
pub(crate) fn config_db_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 开发时 plugin-sql 落盘到当前工作目录；生产时到 app_data_dir。
    // 优先用 app_data_dir，回退到 cwd，二者都试打开确认。
    if let Ok(dir) = app_handle.path().app_data_dir() {
        let p = dir.join("config.db");
        if p.exists() {
            return Ok(p);
        }
    }
    // 开发时工作目录（src-tauri/）下的 config.db
    if let Ok(cwd) = std::env::current_exe() {
        if let Some(exe_dir) = cwd.parent() {
            let p = exe_dir.join("config.db");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    std::env::current_dir()
        .map(|d| d.join("config.db"))
        .map_err(|e| format!("无法获取工作目录: {e}"))
}

pub(crate) fn open_sqlite(app_handle: &tauri::AppHandle) -> Result<Connection, String> {
    let path = config_db_path(app_handle)?;
    let conn = Connection::open(&path).map_err(|e| format!("打开 SQLite 失败: {e}"))?;
    // 强制 WAL：与前端 tauri_plugin_sql 并发读写不锁库（修订点 2）
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("设置 WAL 失败: {e}"))?;
    Ok(conn)
}

// ── 游戏目录读取（不依赖前端传参，后台任务自洽）──────────
pub(crate) fn read_game_path(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let conn = open_sqlite(app_handle)?;
    let path: String = conn
        .query_row(
            "SELECT value FROM config WHERE `key` = 'game_path'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取 game_path 失败: {e}"))?;
    if path.is_empty() {
        return Err("未配置游戏路径，请先在设置中配置".into());
    }
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("游戏目录不存在: {path}"));
    }
    Ok(path)
}

// ── 任务状态写回（每阶段更新 + 前端可查）─────────────────
fn update_task_status(
    app_handle: &tauri::AppHandle,
    task_id: i64,
    status: &str,
    percent: u32,
    stage: &str,
    error: Option<&str>,
    extras: &[(&str, &str)],
) -> Result<(), String> {
    let conn = open_sqlite(app_handle)?;
    let now = chrono::Utc::now().to_rfc3339();
    let finished = if status == "done" || status == "failed" || status == "cancelled" {
        Some(now.clone())
    } else {
        None
    };

    // 动态拼额外列（target_dir / manifest 等）
    let extra_cols: Vec<String> = extras.iter().map(|(k, _)| format!("`{}` = ?", k)).collect();
    let extra_sql = if extra_cols.is_empty() {
        String::new()
    } else {
        format!(", {}", extra_cols.join(", "))
    };

    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(status.to_string()),
        Box::new(percent as i64),
        Box::new(stage.to_string()),
        Box::new(error.map(|e| e.to_string()).unwrap_or_default()),
        Box::new(now),
    ];
    for (_, v) in extras {
        params.push(Box::new(v.to_string()));
    }
    params.push(Box::new(task_id));

    // finished_at 单独处理（NULL 时不覆盖）
    let err_opt = conn.execute(
        &format!(
            "UPDATE subscription_tasks SET status = ?, percent = ?, stage = ?, error = ?, updated_at = ?{} WHERE id = ?",
            extra_sql
        ),
        rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())),
    );
    if let Err(e) = err_opt {
        return Err(format!("更新任务状态失败: {e}"));
    }
    if let Some(ts) = finished {
        let _ = conn.execute(
            "UPDATE subscription_tasks SET finished_at = ? WHERE id = ?",
            rusqlite::params![ts, task_id],
        );
    }
    Ok(())
}

// ── zip slip 防护（复刻前端 safeZipPath）──────────────────
fn safe_zip_path(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("zip 内存在空路径".into());
    }
    let norm = path.replace('\\', "/");
    let stripped = norm.trim_start_matches('/');
    if stripped.split('/').any(|seg| seg == "..") {
        return Err(format!("zip 内存在非法相对路径: {path}"));
    }
    Ok(stripped.to_string())
}

// ── 递归解压（含嵌套 .zip，复刻前端 extractAll 语义）────────
struct ExtractOutcome {
    files: Vec<String>,     // 相对 target_dir 的部署清单（manifest 用）
    target_dir: String,     // composite 可能收窄
}

fn extract_zip_recursive(
    bytes: &[u8],
    target_dir: &str,
    category: &str,
    base: &str,
    plugins_dir: &str,
) -> Result<ExtractOutcome, String> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("读取 zip 失败: {e}"))?;

    let mut files: Vec<String> = Vec::new();
    let target = PathBuf::from(target_dir);

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip entry 失败: {e}"))?;
        let raw_name = entry.name().to_string();

        // 目录条目：创建（dll 类平铺，跳过）
        if entry.is_dir() {
            if category == "dll" {
                continue;
            }
            let safe = safe_zip_path(raw_name.trim_end_matches('/'))?;
            let dir_path = target.join(safe.replace('/', std::path::MAIN_SEPARATOR_STR));
            let _ = fs::create_dir_all(&dir_path);
            continue;
        }

        // 读出文件字节
        let mut buf: Vec<u8> = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取 zip 内文件失败: {e}"))?;

        // 嵌套 zip：递归展开，不写出该 zip 本身
        if raw_name.to_lowercase().ends_with(".zip") {
            match extract_zip_recursive(&buf, target_dir, category, base, plugins_dir) {
                Ok(inner) => {
                    files.extend(inner.files);
                    continue;
                }
                Err(e) => {
                    log::warn!("[subscribe] 嵌套 zip 解析失败，按普通文件写出: {raw_name} -> {e}");
                }
            }
        }

        // 计算目标路径
        let (target_path, manifest_entry) = if category == "dll" {
            let file_name = raw_name
                .split('/')
                .last()
                .filter(|s| !s.is_empty())
                .unwrap_or(&raw_name)
                .to_string();
            (PathBuf::from(plugins_dir).join(&file_name), file_name)
        } else {
            let safe = safe_zip_path(&raw_name)?;
            let normalized = safe.replace('/', std::path::MAIN_SEPARATOR_STR);
            let tp = target.join(&normalized);
            if let Some(parent) = tp.parent() {
                let _ = fs::create_dir_all(parent);
            }
            (tp, safe)
        };

        fs::write(&target_path, &buf).map_err(|e| format!("写出文件失败 {}: {e}", target_path.display()))?;
        files.push(manifest_entry);
    }

    // composite 类：从首个文件推断顶层目录，收窄 target_dir 供 open_folder
    let mut final_target = target_dir.to_string();
    if category == "composite" && !files.is_empty() {
        let first = &files[0];
        let segs: Vec<&str> = first.split('/').collect();
        if segs.len() > 1 {
            let top_dir_segs = &segs[..segs.len() - 1];
            final_target = format!("{}\\{}", base, top_dir_segs.join("\\"));
        }
    }

    Ok(ExtractOutcome {
        files,
        target_dir: final_target,
    })
}

// ── 逐文件 SHA-256（basename → hash 映射，回填云端）──────
fn compute_zip_file_hashes(bytes: &[u8]) -> Result<String, String> {
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("读取 zip 失败: {e}"))?;
    let mut map: HashMap<String, String> = HashMap::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip entry 失败: {e}"))?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取 zip 内文件失败: {e}"))?;
        let basename = name
            .split('/')
            .last()
            .filter(|s| !s.is_empty())
            .unwrap_or(&name)
            .to_string();
        let mut hasher = Sha256::new();
        hasher.update(&buf);
        let hash = hasher.finalize();
        let hex: String = hash.iter().map(|b| format!("{:02x}", b)).collect();
        map.insert(basename, hex);
    }
    serde_json::to_string(&map).map_err(|e| format!("序列化哈希失败: {e}"))
}

// ── 安装记录写回（installed_workshop_mods / _mod_files）──
fn write_install_record(
    app_handle: &tauri::AppHandle,
    mod_key: &str,
    category: &str,
    version: &str,
    file_hash: &str,
    lang_code: &str,
    manifest: &str,
    file_hashes: Option<&str>,
) -> Result<(), String> {
    let conn = open_sqlite(app_handle)?;
    // mod 级记录（兼容旧表）
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM installed_workshop_mods WHERE mod_key = ?",
            rusqlite::params![mod_key],
            |r| r.get(0),
        )
        .ok();
    if existing.is_some() {
        conn.execute(
            "UPDATE installed_workshop_mods SET category = ?, installed_version = ?, file_hash = ?, lang_code = ?, manifest = ?, file_hashes = ? WHERE mod_key = ?",
            rusqlite::params![category, version, file_hash, lang_code, manifest, file_hashes.unwrap_or(""), mod_key],
        )
        .map_err(|e| format!("更新安装记录失败: {e}"))?;
    } else {
        conn.execute(
            "INSERT INTO installed_workshop_mods (mod_key, category, installed_version, file_hash, lang_code, manifest, file_hashes) VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![mod_key, category, version, file_hash, lang_code, manifest, file_hashes.unwrap_or("")],
        )
        .map_err(|e| format!("写入安装记录失败: {e}"))?;
    }
    // 按语言记录
    conn.execute(
        "INSERT INTO installed_workshop_mod_files (mod_key, lang_code, installed_version, file_hash, manifest)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(mod_key, lang_code) DO UPDATE SET
           installed_version = excluded.installed_version,
           file_hash = excluded.file_hash,
           manifest = excluded.manifest,
           installed_at = CURRENT_TIMESTAMP",
        rusqlite::params![mod_key, lang_code, version, file_hash, manifest],
    )
    .map_err(|e| format!("写入语言安装记录失败: {e}"))?;
    Ok(())
}

// ── 全局任务句柄表（取消用）──────────────────────────────
// TASK_HANDLES 见文件头部 once_cell 定义（tasks() 取引用）。

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionProgress {
    task_id: i64,
    mod_key: String,
    percent: u32,
    stage: String,
    status: String,
    error: String,
    // 实时下载速度（字节/秒），仅 downloading 阶段有意义；其它阶段 emit 0
    speed: u64,
}

// ── 主任务体（spawn 执行）──────────────────────────────────
async fn run_subscribe_task(
    app_handle: tauri::AppHandle,
    task_id: i64,
    mod_key: String,
    category: String,
    lang_code: String,
    version: String,
    file_url: String,
    file_hash: String,
    retry_of: Option<i64>,
) {
    let _ = retry_of; // 仅记录用，逻辑同
    // 失败辅助：闭包 async 块捕获引用会触发 lifetime 错，改为独立 async fn
    async fn fail(
        app_handle: &tauri::AppHandle,
        task_id: i64,
        mod_key: &str,
        stage: &str,
        err: &str,
    ) {
        let _ = update_task_status(app_handle, task_id, "failed", 0, stage, Some(err), &[]);
        let _ = app_handle.emit(
            "subscription-progress",
            SubscriptionProgress {
                task_id,
                mod_key: mod_key.to_string(),
                percent: 0,
                stage: stage.into(),
                status: "failed".into(),
                error: err.into(),
                speed: 0,
            },
        );
    }

    // 1) 读游戏目录
    let game_path = match read_game_path(&app_handle) {
        Ok(p) => p,
        Err(e) => {
            fail(&app_handle, task_id, &mod_key, "init", &e).await;
            return;
        }
    };
    let base = game_path.trim_end_matches('\\').to_string();
    let plugins_dir = format!("{}\\BepInEx\\plugins", base);

    let target_dir = match category.as_str() {
        "v2" => format!("{}\\CustomMissions2\\{}", base, mod_key),
        "dll" => plugins_dir.clone(),
        "composite" => base.clone(),
        _ => format!("{}\\CustomMissions", base), // v1 及兜底
    };

    // 2) 确保目标目录存在
    if let Err(e) = fs::create_dir_all(&target_dir) {
        fail(&app_handle, task_id, &mod_key, "init", &format!("创建目标目录失败: {e}")).await;
        return;
    }
    let _ = update_task_status(&app_handle, task_id, "downloading", 0, "downloading", None, &[("target_dir", &target_dir)]);
    let _ = app_handle.emit("subscription-progress", SubscriptionProgress {
        task_id, mod_key: mod_key.clone(), percent: 0, stage: "downloading".into(), status: "downloading".into(), error: String::new(), speed: 0,
    });

    // 3) 流式下载到临时文件
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
    {
        Ok(c) => c,
        Err(e) => { fail(&app_handle, task_id, &mod_key, "downloading", &format!("构建 HTTP client 失败: {e}")).await; return; }
    };
    let response = match client.get(&file_url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => { fail(&app_handle, task_id, &mod_key, "downloading", &format!("下载失败 HTTP {}", r.status())).await; return; }
        Err(e) => { fail(&app_handle, task_id, &mod_key, "downloading", &format!("下载失败: {e}")).await; return; }
    };
    let total = response.content_length().unwrap_or(0);
    let temp_path = std::env::temp_dir().join(format!("sfmmm_subscribe_{}.zip", task_id));
    let mut file = match fs::File::create(&temp_path) {
        Ok(f) => f,
        Err(e) => { fail(&app_handle, task_id, &mod_key, "downloading", &format!("创建临时文件失败: {e}")).await; return; }
    };
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    let mut downloaded: u64 = 0;
    // 节流上报 + 实时速度：每 400ms 计算一次增量速度并广播（与 installer.rs 同款）
    let mut prev_bytes: u64 = 0;
    let mut prev_time = tokio::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
                if let Err(e) = file.write_all(&c) {
                    fail(&app_handle, task_id, &mod_key, "downloading", &format!("写入临时文件失败: {e}")).await;
                    let _ = fs::remove_file(&temp_path);
                    return;
                }
                downloaded += c.len() as u64;
                let now = tokio::time::Instant::now();
                let elapsed = now.duration_since(prev_time).as_secs_f64();
                if elapsed >= 0.4 {
                    let speed = if elapsed > 0.0 {
                        ((downloaded - prev_bytes) as f64 / elapsed) as u64
                    } else {
                        0
                    };
                    prev_bytes = downloaded;
                    prev_time = now;
                    let percent = if total > 0 { (downloaded * 100 / total) as u32 } else { 0 };
                    let _ = update_task_status(&app_handle, task_id, "downloading", percent, "downloading", None, &[]);
                    let _ = app_handle.emit("subscription-progress", SubscriptionProgress {
                        task_id, mod_key: mod_key.clone(), percent, stage: "downloading".into(), status: "downloading".into(), error: String::new(), speed,
                    });
                }
            }
            Err(e) => {
                fail(&app_handle, task_id, &mod_key, "downloading", &format!("下载中断: {e}")).await;
                let _ = fs::remove_file(&temp_path);
                return;
            }
        }
    }
    drop(file);

    // 4) 解压
    let _ = update_task_status(&app_handle, task_id, "extracting", 100, "extracting", None, &[]);
    let _ = app_handle.emit("subscription-progress", SubscriptionProgress {
        task_id, mod_key: mod_key.clone(), percent: 100, stage: "extracting".into(), status: "extracting".into(), error: String::new(), speed: 0,
    });
    let bytes = match fs::read(&temp_path) {
        Ok(b) => b,
        Err(e) => { fail(&app_handle, task_id, &mod_key, "extracting", &format!("读取临时文件失败: {e}")).await; let _ = fs::remove_file(&temp_path); return; }
    };
    let outcome = match extract_zip_recursive(&bytes, &target_dir, &category, &base, &plugins_dir) {
        Ok(o) => o,
        Err(e) => { fail(&app_handle, task_id, &mod_key, "extracting", &e).await; let _ = fs::remove_file(&temp_path); return; }
    };
    let _ = fs::remove_file(&temp_path);
    let final_target = outcome.target_dir.clone();
    let manifest = if outcome.files.is_empty() {
        "[]".to_string()
    } else {
        serde_json::to_string(&outcome.files).unwrap_or_else(|_| "[]".into())
    };

    // 5) 逐文件哈希回填云端（失败仅告警）
    let file_hashes_json = match compute_zip_file_hashes(&bytes) {
        Ok(s) => Some(s),
        Err(e) => { log::warn!("[subscribe] 计算逐文件哈希失败: {e}"); None }
    };
    if let Some(ref hashes) = file_hashes_json {
        let _ = backfill_cloud_hashes(&app_handle, &mod_key, &lang_code, hashes).await;
    }

    // 6) 写安装记录
    let _ = update_task_status(&app_handle, task_id, "recording", 100, "recording", None, &[("manifest", &manifest)]);
    if let Err(e) = write_install_record(&app_handle, &mod_key, &category, &version, &file_hash, &lang_code, &manifest, file_hashes_json.as_deref()) {
        fail(&app_handle, task_id, &mod_key, "recording", &e).await;
        return;
    }

    // 7) done
    let _ = update_task_status(&app_handle, task_id, "done", 100, "done", None, &[]);
    let _ = app_handle.emit("subscription-progress", SubscriptionProgress {
        task_id, mod_key, percent: 100, stage: "done".into(), status: "done".into(), error: String::new(), speed: 0,
    });
    // 清理句柄
    if let Ok(mut m) = tasks().lock() {
        m.remove(&task_id);
    }
    let _ = final_target;
}

// 回填云端 file_hashes：复用 DbState 调 db_set_mod_file_hashes 的底层逻辑
async fn backfill_cloud_hashes(
    app_handle: &tauri::AppHandle,
    mod_key: &str,
    lang_code: &str,
    file_hashes: &str,
) -> Result<(), String> {
    let state = app_handle.state::<DbState>();
    // 直接复用 hash.rs 的命令实现需要它 pub；这里走 with_conn_pool 复刻最小版
    let parsed: HashMap<String, String> = serde_json::from_str(file_hashes)
        .map_err(|e| format!("解析 file_hashes 失败: {e}"))?;
    if parsed.is_empty() {
        return Ok(());
    }
    let json = serde_json::to_string(&parsed).map_err(|e| format!("序列化失败: {e}"))?;
    let mk = crate::db::encrypt_det(mod_key)?;
    let lc = lang_code.to_string();
    let _ = with_conn_pool(&state.pool, move |conn: &mut mysql::PooledConn| -> Result<(u64,), String> {
        // 确保 mod_files 有 file_hashes 列（hash.rs 的 ensure 函数是私有的，这里兜底）
        let _: Vec<usize> = conn.query(
            "ALTER TABLE mod_files ADD COLUMN file_hashes LONGTEXT NULL",
        ).unwrap_or_default();
        let res: Vec<usize> = conn.exec(
            "UPDATE mod_files f JOIN mods m ON m.id = f.mod_id
             SET f.file_hashes = ?
             WHERE m.mod_id = ? AND f.lang_code = ?",
            (json.clone(), mk.clone(), lc.clone()),
        ).map_err(|e| e.to_string())?;
        Ok((res.into_iter().next().unwrap_or(0) as u64,))
    }).await?;
    Ok(())
}

// ── Tauri 命令 ─────────────────────────────────────────────

/// 创建订阅下载任务并立即返回 task_id；下载在后台异步执行，不阻塞前端。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_subscribe_mod(
    app_handle: tauri::AppHandle,
    mod_key: String,
    mod_id: Option<i64>,
    category: String,
    lang_code: String,
    version: String,
    file_url: String,
    file_hash: String,
    retry_of: Option<i64>,
    // 冗余存一份工坊卡片展示信息，订阅记录页离线也能显示文件名+简介。
    // translations 前端按 JSON.stringify({zh:{name,...},...}) 传入，原样存原文。
    display_name: Option<String>,
    description: Option<String>,
    translations: Option<String>,
) -> Result<serde_json::Value, String> {
    // 1) 去重：同 mod_key + version + file_hash 若已有进行中或已完成任务，直接返回该 task_id
    //    避免多次退订/订阅产生重复订阅记录（同一 mod 同版本同 hash 视为同一任务）
    //    - 进行中（pending/downloading/extracting/recording）：复用，不重下
    //    - 已完成（done）：幂等返回，不重下——但若 installed_workshop_mods 里对应
    //      安装记录已不在（被退订删掉），done 视为失效允许新建重下重装
    //    - failed/cancelled：不命中，允许新建（视为重试）
    let conn = open_sqlite(&app_handle)?;
    // 1.5) 覆盖旧记录：新订阅意味着同 mod_key+版本+hash 的旧失败/取消行已失效，
    //     删除它们，保证任意时刻同 mod 同版本只一条有效记录——
    //     否则"首次失败 → 重试成功 → 退订"后，旧的 failed 行与新 done(已退订) 行并存
    let _ = conn.execute(
        "DELETE FROM subscription_tasks
         WHERE mod_key = ? AND version = ? AND file_hash = ?
           AND status IN ('failed', 'cancelled')",
        rusqlite::params![mod_key, version, file_hash],
    );
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM subscription_tasks
             WHERE mod_key = ? AND version = ? AND file_hash = ?
               AND status IN ('pending', 'downloading', 'extracting', 'recording', 'done')
             ORDER BY id DESC LIMIT 1",
            rusqlite::params![mod_key, version, file_hash],
            |r| r.get(0),
        )
        .ok();
    let (task_id, is_new) = if let Some(id) = existing {
        // 命中已有任务：进行中直接复用；done 需校验安装记录是否还在
        let need_reinstall = conn
            .query_row(
                "SELECT 1 FROM installed_workshop_mods WHERE mod_key = ? LIMIT 1",
                rusqlite::params![mod_key],
                |_| Ok(1),
            )
            .is_err(); // 查不到行 = 安装记录已不在 = 视为失效
        // 查这个任务的当前状态是否 done（进行中的不进重装分支）
        let task_status: String = conn
            .query_row(
                "SELECT status FROM subscription_tasks WHERE id = ?",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap_or_default();
        if task_status == "done" && need_reinstall {
            // done 但安装记录已被退订删掉：视为失效，新建任务重下重装
            // 直接删掉旧 done 行（不置 superseded 改名），让同 mod_key+版本任意时刻只一条有效记录
            let _ = conn.execute(
                "DELETE FROM subscription_tasks WHERE id = ?",
                rusqlite::params![id],
            );
            let new_id = conn
                .query_row(
                    "INSERT INTO subscription_tasks (mod_key, mod_id, category, lang_code, version, file_url, file_hash, status, retry_of, display_name, description, translations)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                     RETURNING id",
                    rusqlite::params![mod_key, mod_id.unwrap_or(0), category, lang_code, version, file_url, file_hash, id, display_name.clone().unwrap_or_default(), description.clone().unwrap_or_default(), translations.clone().unwrap_or_default()],
                    |r| r.get(0),
                )
                .map_err(|e| format!("写入任务记录失败: {e}"))?;
            (new_id, true)
        } else {
            // 进行中 或 done 且安装记录还在：原样返回，不新建
            (id, false)
        }
    } else {
        // 无命中：写 pending 任务行拿到 task_id
        let id = conn
            .query_row(
                "INSERT INTO subscription_tasks (mod_key, mod_id, category, lang_code, version, file_url, file_hash, status, retry_of, display_name, description, translations)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                 RETURNING id",
                rusqlite::params![mod_key, mod_id.unwrap_or(0), category, lang_code, version, file_url, file_hash, retry_of, display_name.clone().unwrap_or_default(), description.clone().unwrap_or_default(), translations.clone().unwrap_or_default()],
                |r| r.get(0),
            )
            .map_err(|e| format!("写入任务记录失败: {e}"))?;
        (id, true)
    };
    drop(conn);

    // 命中已有任务：直接返回该 task_id，不 spawn 重复任务
    if !is_new {
        return Ok(serde_json::json!({ "taskId": task_id, "deduplicated": true }));
    }

    // 2) spawn 后台任务
    let app = app_handle.clone();
    let handle: JoinHandle<()> = tokio::spawn(async move {
        run_subscribe_task(
            app,
            task_id,
            mod_key,
            category,
            lang_code,
            version,
            file_url,
            file_hash,
            retry_of,
        )
        .await;
    });
    if let Ok(mut m) = tasks().lock() {
        m.insert(task_id, handle);
    }

    Ok(serde_json::json!({ "taskId": task_id }))
}

/// 列出订阅任务（前端订阅记录页用）。status_filter: None=全部, Some=指定状态。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_subscription_tasks(
    app_handle: tauri::AppHandle,
    status_filter: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = open_sqlite(&app_handle)?;
    let limit = limit.unwrap_or(100).min(500);
    let sql = match status_filter.as_deref() {
        Some(s) if !s.is_empty() => format!(
            "SELECT id, mod_key, mod_id, category, lang_code, version, file_url, file_hash, status, percent, stage, error, target_dir, manifest, retry_of, created_at, updated_at, finished_at, display_name, description, translations
             FROM subscription_tasks WHERE status = ? ORDER BY id DESC LIMIT {}",
            limit
        ),
        _ => format!(
            "SELECT id, mod_key, mod_id, category, lang_code, version, file_url, file_hash, status, percent, stage, error, target_dir, manifest, retry_of, created_at, updated_at, finished_at, display_name, description, translations
             FROM subscription_tasks ORDER BY id DESC LIMIT {}",
            limit
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("预备查询失败: {e}"))?;
    let rows: Vec<serde_json::Value> = if status_filter.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
        let s = status_filter.unwrap();
        stmt.query_map(rusqlite::params![s], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "modKey": row.get::<_, String>(1)?,
                "modId": row.get::<_, i64>(2)?,
                "category": row.get::<_, String>(3)?,
                "langCode": row.get::<_, String>(4)?,
                "version": row.get::<_, String>(5)?,
                "fileUrl": row.get::<_, String>(6)?,
                "fileHash": row.get::<_, String>(7)?,
                "status": row.get::<_, String>(8)?,
                "percent": row.get::<_, i64>(9)?,
                "stage": row.get::<_, String>(10)?,
                "error": row.get::<_, String>(11)?,
                "targetDir": row.get::<_, String>(12)?,
                "manifest": row.get::<_, String>(13)?,
                "retryOf": row.get::<_, Option<i64>>(14)?,
                "createdAt": row.get::<_, String>(15)?,
                "updatedAt": row.get::<_, String>(16)?,
                "finishedAt": row.get::<_, String>(17)?,
                "displayName": row.get::<_, String>(18)?,
                "description": row.get::<_, String>(19)?,
                "translations": row.get::<_, String>(20)?,
            }))
        })
        .map_err(|e| format!("查询任务失败: {e}"))?
        .filter_map(|r| r.ok())
        .collect()
    } else {
        stmt.query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "modKey": row.get::<_, String>(1)?,
                "modId": row.get::<_, i64>(2)?,
                "category": row.get::<_, String>(3)?,
                "langCode": row.get::<_, String>(4)?,
                "version": row.get::<_, String>(5)?,
                "fileUrl": row.get::<_, String>(6)?,
                "fileHash": row.get::<_, String>(7)?,
                "status": row.get::<_, String>(8)?,
                "percent": row.get::<_, i64>(9)?,
                "stage": row.get::<_, String>(10)?,
                "error": row.get::<_, String>(11)?,
                "targetDir": row.get::<_, String>(12)?,
                "manifest": row.get::<_, String>(13)?,
                "retryOf": row.get::<_, Option<i64>>(14)?,
                "createdAt": row.get::<_, String>(15)?,
                "updatedAt": row.get::<_, String>(16)?,
                "finishedAt": row.get::<_, String>(17)?,
                "displayName": row.get::<_, String>(18)?,
                "description": row.get::<_, String>(19)?,
                "translations": row.get::<_, String>(20)?,
            }))
        })
        .map_err(|e| format!("查询任务失败: {e}"))?
        .filter_map(|r| r.ok())
        .collect()
    };
    Ok(rows)
}

/// 取消进行中的任务（abort），状态置 cancelled。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_cancel_subscription(
    app_handle: tauri::AppHandle,
    task_id: i64,
) -> Result<serde_json::Value, String> {
    let aborted = {
        if let Ok(mut m) = tasks().lock() {
            if let Some(h) = m.remove(&task_id) {
                h.abort();
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if aborted {
        let _ = update_task_status(&app_handle, task_id, "cancelled", 0, "cancelled", Some("用户取消"), &[]);
        let _ = app_handle.emit(
            "subscription-progress",
            SubscriptionProgress {
                task_id,
                mod_key: String::new(),
                percent: 0,
                stage: "cancelled".into(),
                status: "cancelled".into(),
                error: "用户取消".into(),
                speed: 0,
            },
        );
        Ok(serde_json::json!({ "cancelled": true }))
    } else {
        // 任务可能已结束（done/failed），仍把状态置 cancelled 防前端显示卡死
        let _ = update_task_status(&app_handle, task_id, "cancelled", 0, "cancelled", Some("任务已结束或不存在"), &[]);
        Ok(serde_json::json!({ "cancelled": false, "note": "任务已结束或不存在" }))
    }
}
