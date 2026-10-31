//! 图床（ImgBed）客户端：URL / Token 只在 Rust 侧解封使用，不下发给前端。
//!
//! 前端通过 `db_imgbed_upload_file`（本地临时路径 + 流式上传）触发；
//! 上传过程通过 `imgbed-upload-progress` 事件回报进度。删除走 `db_delete_imgbed_file`。

use crate::db::ApiResponse;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::oneshot;

const PROGRESS_EVENT: &str = "imgbed-upload-progress";
const UPLOAD_TIMEOUT_SECS: u64 = 900;
const DELETE_TIMEOUT_SECS: u64 = 30;

// ── 上传取消信号表（upload_id → 取消通知）─────────────────────
// 用户点「取消」后由 db_cancel_imgbed_upload 触发，send 让 select! 另一分支
// 立刻结束并 drop 上传 future，从而中断进行中的 HTTP 请求（含卡在连接阶段）。
// 上传结束（成功/失败/取消）时移除，避免残留。
static UPLOAD_CANCELS: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();

fn upload_cancels() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    UPLOAD_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn imgbed_url() -> String {
    let raw = option_env!("IMGBED_URL")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("IMGBED_URL").ok())
        .expect("IMGBED_URL 未设置：请在 src-tauri/.env 中配置图床地址，然后重新构建");
    crate::db::secret::reveal(&raw)
}

fn imgbed_token() -> String {
    let raw = option_env!("IMGBED_TOKEN")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("IMGBED_TOKEN").ok())
        .expect("IMGBED_TOKEN 未设置：请在 src-tauri/.env 中配置图床 Token，然后重新构建");
    crate::db::secret::reveal(&raw)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(UPLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

/// 删除/读取这类小请求单独用短超时：复用 900s 的上传 client 会让一次
/// 网络抖动卡住整个替换流程。
fn short_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(DELETE_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

/// reqwest 的 `Display` 只输出 "error sending request for url (...)"，
/// 真实原因（DNS/连接超时/重置/TLS）在 source 链里，这里一并拼上，便于用户报错定位。
fn describe_reqwest_err(e: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str("; ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

/// 从公开访问 URL 提取图床 fileId：`/file/sfm/...` → `sfm/...`。
/// `file/` 是读取路由而不是数据库 key，原样传给删除接口只会得到不存在的路径，
/// 服务端按幂等删除返回 success=true / existed=false，文件实际不会删。
fn imgbed_file_id(file_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(file_url).map_err(|e| format!("file_url 无效: {e}"))?;
    let path = url.path().trim_start_matches('/');
    let id = path.strip_prefix("file/").unwrap_or(path);
    if id.is_empty() {
        return Err("file_url 缺少文件路径".into());
    }
    Ok(id.to_string())
}

/// 校验并提取「本图床、应用上传目录下」的 fileId。
/// 批量清理命令的入参来自前端，必须限制在图床自身与 `sfm/`、`sfmmm/` 之下，
/// 防止被异常调用方拿去删除别处的文件。
pub(crate) fn imgbed_file_id_if_ours(file_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(file_url).map_err(|e| format!("file_url 无效: {e}"))?;
    let base = reqwest::Url::parse(&imgbed_url()).map_err(|e| format!("图床地址无效: {e}"))?;
    if url.host_str() != base.host_str() {
        return Err("不是本图床的地址".into());
    }
    let id = imgbed_file_id(file_url)?;
    if !(id.starts_with("sfm/") || id.starts_with("sfmmm/")) {
        return Err("不是应用上传目录下的文件".into());
    }
    Ok(id)
}

/// 是否为图片文件（按扩展名；运行时清理只删除图片，绝不碰包/安装包/json）
pub(crate) fn is_imgbed_image_id(id: &str) -> bool {
    let name = id.rsplit('/').next().unwrap_or_default();
    let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp"
    )
}

fn mime_for(file_name: &str) -> &'static str {
    match file_name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "zip" => "application/zip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        _ => "application/octet-stream",
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn upload_url(folder: &str, channel: &str, name_type: Option<&str>) -> Result<reqwest::Url, String> {
    let base = imgbed_url();
    let mut url = reqwest::Url::parse(&format!("{}/upload", base.trim_end_matches('/')))
        .map_err(|e| format!("图床地址无效: {e}"))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("uploadChannel", channel);
        q.append_pair("uploadFolder", folder);
        q.append_pair("returnFormat", "full");
        if let Some(t) = name_type {
            q.append_pair("uploadNameType", t);
        }
    }
    Ok(url)
}

async fn send_upload(
    part: reqwest::multipart::Part,
    folder: &str,
    channel: &str,
    name_type: Option<&str>,
) -> Result<ApiResponse, String> {
    let url = upload_url(folder, channel, name_type)?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let res = client()?
        .post(url)
        .bearer_auth(imgbed_token())
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("ImgBed upload failed: {e}"))?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "ImgBed upload failed: HTTP {} - {}",
            status.as_u16(),
            truncate(&text, 200)
        ));
    }

    let list: Vec<Value> =
        serde_json::from_str(&text).map_err(|e| format!("ImgBed upload failed: {e}"))?;
    let first = list
        .first()
        .ok_or_else(|| "ImgBed upload failed: unexpected response".to_string())?;
    let src = first.get("src").and_then(Value::as_str).unwrap_or_default();
    let public_url = first
        .get("publicUrl")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if src.is_empty() && public_url.is_empty() {
        return Err("ImgBed upload failed: unexpected response".into());
    }

    Ok(ApiResponse::ok_val(
        json!({
            "src": src,
            "public_url": public_url,
            "url": if public_url.is_empty() { src } else { public_url },
        }),
        "OK",
    ))
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

/// 带进度回报的读取流：分块读取本地文件，逐块上报后交给 reqwest，
/// 避免整个文件进内存。
type ProgressFn = std::sync::Arc<dyn Fn(u64, u64) + Send + Sync + 'static>;

fn progress_stream(
    file: tokio::fs::File,
    total: u64,
    on_progress: Option<ProgressFn>,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> + Send + 'static {
    futures_util::stream::try_unfold(
        (file, 0u64, on_progress),
        move |(mut file, loaded, on_progress)| async move {
            use tokio::io::AsyncReadExt;

            let mut buf = vec![0u8; 256 * 1024];
            let n = file.read(&mut buf).await?;
            if n == 0 {
                return Ok(None);
            }
            buf.truncate(n);

            let loaded = loaded + n as u64;
            if let Some(cb) = &on_progress {
                cb(loaded, total);
            }
            Ok(Some((buf, (file, loaded, on_progress))))
        },
    )
}

/// 上传本地文件（大文件如 mod 压缩包），流式读取并回报进度。
/// `app` 为 `None` 时不发进度事件（供测试/命令行复用）。
async fn upload_file_streaming(
    file_path: String,
    file_name: String,
    folder: String,
    channel: Option<String>,
    upload_name_type: Option<String>,
    on_progress: Option<ProgressFn>,
) -> Result<ApiResponse, String> {
    let meta = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("读取待上传文件失败: {e}"))?;
    let total = meta.len();
    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("打开待上传文件失败: {e}"))?;

    let body = reqwest::Body::wrap_stream(progress_stream(file, total, on_progress));
    let part = reqwest::multipart::Part::stream_with_length(body, total)
        .file_name(file_name.clone())
        .mime_str(mime_for(&file_name))
        .map_err(|e| format!("设置 MIME 失败: {e}"))?;

    send_upload(
        part,
        &folder,
        channel.as_deref().unwrap_or("telegram"),
        upload_name_type.as_deref(),
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

/// 取消进行中的图床上传：send 取消信号，select! 立即 drop 上传 future 中断 HTTP 请求。
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

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_imgbed_file(file_url: String) -> Result<ApiResponse, String> {
    match delete_imgbed_file_inner(&file_url).await {
        Ok((file_id, existed)) => {
            // existed=false 表示图床里本就没有这条记录（重复删除/已清理），仍然算成功，
            // 但把结果回传，避免"静默成功"掩盖 key 拼错之类的问题。
            let msg = if existed == Some(false) {
                "ImgBed file already absent"
            } else {
                "ImgBed file deleted"
            };
            Ok(ApiResponse::ok_val(
                json!({ "file_id": file_id, "existed": existed }),
                msg,
            ))
        }
        Err(e) => Ok(ApiResponse::err(&e)),
    }
}

/// 删除单个图床文件（供单删命令与批量清理复用）。返回 (file_id, existed)。
pub(crate) async fn delete_imgbed_file_inner(
    file_url: &str,
) -> Result<(String, Option<bool>), String> {
    let file_id = imgbed_file_id(file_url)?;

    // 与 upload_url 保持一致：直接拼接字符串，避免 `Url::join` 相对路径丢掉 base 的路径前缀
    let delete_url = reqwest::Url::parse(&format!(
        "{}/api/manage/delete/{}",
        imgbed_url().trim_end_matches('/'),
        file_id
    ))
    .map_err(|e| format!("删除地址无效: {e}"))?;

    // 删除是幂等的：直连图床偶发连接超时/重置，重试一次比让用户看到"删除失败"更可靠
    let client = short_client()?;
    let mut last_err = String::new();
    let mut res = None;
    for attempt in 0..2 {
        match client
            .get(delete_url.clone())
            .bearer_auth(imgbed_token())
            .send()
            .await
        {
            Ok(r) => {
                res = Some(r);
                break;
            }
            Err(e) => {
                last_err = describe_reqwest_err(&e);
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }
    let Some(res) = res else {
        return Err(format!("ImgBed delete failed: {last_err}"));
    };

    let status = res.status();
    let text = res.text().await.unwrap_or_default();

    let parsed = serde_json::from_str::<Value>(&text).ok();
    let body_ok = parsed
        .as_ref()
        .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
        .unwrap_or(status.is_success());

    if body_ok {
        let existed = parsed
            .as_ref()
            .and_then(|v| v.get("existed").and_then(|b| b.as_bool()));
        Ok((file_id, existed))
    } else {
        let err_msg = parsed
            .as_ref()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| format!("HTTP {} - {}", status, text));
        Err(format!("ImgBed delete failed: {}", err_msg))
    }
}

#[cfg(test)]
mod tests {
    use super::imgbed_file_id;

    #[test]
    fn file_id_strips_read_route_prefix() {
        let id = imgbed_file_id(
            "https://img.b9349.dpdns.org/file/sfm/455/zh/1.1.0/1793034606986_CustomToys_zh.zip",
        )
        .unwrap();
        assert_eq!(id, "sfm/455/zh/1.1.0/1793034606986_CustomToys_zh.zip");
    }

    #[test]
    fn file_id_keeps_percent_encoding() {
        let id = imgbed_file_id(
            "https://img.b9349.dpdns.org/file/sfm/1/comments/%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE.png",
        )
        .unwrap();
        assert_eq!(id, "sfm/1/comments/%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE.png");
    }

    #[test]
    fn file_id_accepts_url_without_file_segment() {
        let id = imgbed_file_id("https://img.b9349.dpdns.org/sfm/1/a.zip").unwrap();
        assert_eq!(id, "sfm/1/a.zip");
    }

    #[test]
    fn file_id_rejects_invalid_input() {
        assert!(imgbed_file_id("").is_err());
        assert!(imgbed_file_id("https://img.b9349.dpdns.org/").is_err());
        assert!(imgbed_file_id("https://img.b9349.dpdns.org/file/").is_err());
    }
}

