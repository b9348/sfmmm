//! 文件上传：新版直接上传到 hk 服务器（`/api/user/upload`），不再走 Telegram 图床。
//!
//! 前端通过 `db_imgbed_upload_file` 触发；进度经 `imgbed-upload-progress` 事件回报。
//! 删除 / 批量清理已改为服务端 RPC（见 `db.rs` 的代理命令）。

use crate::db::ApiResponse;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::Emitter;
use tokio::sync::oneshot;

const PROGRESS_EVENT: &str = "imgbed-upload-progress";

// ── 上传取消信号表（upload_id → 取消通知）─────────────────────
static UPLOAD_CANCELS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();

fn upload_cancels() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    UPLOAD_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
struct UploadProgress {
    /// 前端生成的上传标识：事件全局广播，前端据此过滤属于自己的进度
    upload_id: String,
    loaded: u64,
    total: u64,
    /// 实时上传速度（字节/秒）
    speed: u64,
}

/// 上传速度计：每 400ms 按字节增量算一次，其它事件沿用上次结果
struct SpeedMeter {
    last_bytes: u64,
    last_instant: Instant,
    speed: u64,
}

impl SpeedMeter {
    fn new() -> Self {
        Self {
            last_bytes: 0,
            last_instant: Instant::now(),
            speed: 0,
        }
    }

    fn update(&mut self, loaded: u64) -> u64 {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_instant).as_secs_f64();
        if elapsed >= 0.4 {
            self.speed = ((loaded.saturating_sub(self.last_bytes)) as f64 / elapsed) as u64;
            self.last_bytes = loaded;
            self.last_instant = now;
        }
        self.speed
    }
}

/// 进度回调类型（供发布流程复用）。
pub(crate) type ProgressFn = std::sync::Arc<dyn Fn(u64, u64) + Send + Sync + 'static>;

/// 上传本地文件（大文件如 mod 压缩包），流式读取并回报进度。
pub(crate) async fn upload_file_streaming(
    file_path: String,
    file_name: String,
    folder: String,
    channel: Option<String>,
    upload_name_type: Option<String>,
    on_progress: Option<ProgressFn>,
) -> Result<ApiResponse, String> {
    crate::api::upload_file(
        file_path,
        file_name,
        folder,
        channel,
        upload_name_type,
        None,
        on_progress,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_imgbed_upload_file(
    app: tauri::AppHandle,
    file_path: String,
    file_name: String,
    folder: String,
    channel: Option<String>,
    upload_name_type: Option<String>,
    upload_id: Option<String>,
) -> Result<ApiResponse, String> {
    let upload_id = upload_id.unwrap_or_default();
    let app_for_progress = app.clone();
    let meter = std::sync::Mutex::new(SpeedMeter::new());
    let event_upload_id = upload_id.clone();
    let on_progress: ProgressFn = std::sync::Arc::new(move |loaded, total| {
        let speed = meter
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .update(loaded);
        let _ = app_for_progress.emit(
            PROGRESS_EVENT,
            UploadProgress {
                upload_id: event_upload_id.clone(),
                loaded,
                total,
                speed,
            },
        );
    });

    // 注册取消信号（仅在 upload_id 非空时启用）
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    if !upload_id.is_empty() {
        if let Ok(mut m) = upload_cancels().lock() {
            m.insert(upload_id.clone(), cancel_tx);
        }
    }

    let result = tokio::select! {
        res = upload_file_streaming(
            file_path,
            file_name,
            folder,
            channel,
            upload_name_type,
            Some(on_progress),
        ) => res,
        _ = &mut cancel_rx => Err("上传已取消".to_string()),
    };

    if !upload_id.is_empty() {
        if let Ok(mut m) = upload_cancels().lock() {
            m.remove(&upload_id);
        }
    }

    result
}

/// 取消进行中的上传：send 取消信号，select! 立即 drop 上传 future 中断 HTTP 请求。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_cancel_imgbed_upload(upload_id: String) -> Result<ApiResponse, String> {
    let tx = upload_cancels()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&upload_id));
    if let Some(tx) = tx {
        let _ = tx.send(());
    }
    Ok(ApiResponse::ok_msg("cancelled"))
}
