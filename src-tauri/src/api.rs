//! 云 API 客户端：桌面端不再直连 MySQL，所有云库操作经本地 Tauri 命令代理到
//! `${SFMMM_API_BASE}`（构建期从 `src-tauri/.env` 注入，运行时同名环境变量可覆盖）。
//! 基址不在代码里写死：构建或运行为空时会直接报「未配置」错误。
//!
//! 登录令牌只保存在 Rust 侧（应用配置目录的 `api_token` 文件），前端页面
//! 通过 Tauri command 间接使用，拿不到令牌本身。

use serde::de::DeserializeOwned;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::db::{db_err, ApiResponse, DbErrorKind};

const TOKEN_FILE: &str = "api_token";

static TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
static RECENT_FAILURE: AtomicBool = AtomicBool::new(false);

pub fn recent_failure() -> bool {
    RECENT_FAILURE.load(Ordering::Relaxed)
}

pub fn mark_failure() {
    RECENT_FAILURE.store(true, Ordering::Relaxed);
}

pub fn mark_success() {
    RECENT_FAILURE.store(false, Ordering::Relaxed);
}

fn token_slot() -> &'static Mutex<Option<String>> {
    TOKEN.get_or_init(|| Mutex::new(None))
}

fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(125))
            .user_agent(crate::db::user_agent())
            .build()
            .expect("创建 API HTTP 客户端失败")
    })
}

fn upload_http() -> &'static reqwest::Client {
    static UPLOAD: OnceLock<reqwest::Client> = OnceLock::new();
    UPLOAD.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            // 大文件上传不设总超时（与旧下载引擎口径一致）
            .user_agent(crate::db::user_agent())
            .build()
            .expect("创建上传 HTTP 客户端失败")
    })
}

/// 云 API 基址：运行时 `SFMMM_API_BASE` 优先，其次构建期注入的同名变量；都为空返回空串。
/// 这样仓库/文档里不再出现真实域名，用自己的服务端只需在 `.env` 里填一次。
pub fn base_url() -> String {
    let pick = |raw: String| {
        let t = raw.trim().trim_end_matches('/').to_string();
        if t.is_empty() { None } else { Some(t) }
    };
    std::env::var("SFMMM_API_BASE")
        .ok()
        .and_then(pick)
        .or_else(|| option_env!("SFMMM_API_BASE").and_then(|s| pick(s.to_string())))
        .unwrap_or_default()
}

/// 取基址，未配置时给出可操作的错误（不再拼出相对 URL 让 reqwest 报天书）。
fn require_base() -> Result<String, String> {
    let base = base_url();
    if base.is_empty() {
        return Err(db_err(
            DbErrorKind::Network,
            "未配置云 API 基址：请在 src-tauri/.env 设置 SFMMM_API_BASE".to_string(),
        ));
    }
    Ok(base)
}

/// 启动时调用：记录配置目录并恢复上次保存的令牌。
pub fn init(config_dir: PathBuf) {
    let _ = std::fs::create_dir_all(&config_dir);
    let _ = CONFIG_DIR.set(config_dir.clone());
    let token_path = config_dir.join(TOKEN_FILE);
    if let Ok(token) = std::fs::read_to_string(&token_path) {
        let token = token.trim().to_string();
        if !token.is_empty() {
            *token_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(token);
        }
    }
}

fn token() -> Option<String> {
    token_slot()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 供通知长连接读取当前令牌（前端永远拿不到令牌本身）。
pub(crate) fn token_snapshot() -> Option<String> {
    token()
}

fn save_token(token: &str) {
    *token_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(token.to_string());
    // 登录/切换账号：唤醒通知长连接监督任务，用新令牌重连
    crate::notify_ws::on_auth_changed();
    let Some(dir) = CONFIG_DIR.get() else {
        return;
    };
    let path = dir.join(TOKEN_FILE);
    let tmp = dir.join(format!("{TOKEN_FILE}.tmp"));
    if std::fs::write(&tmp, token).is_ok() {
        // Windows 上 rename 覆盖已存在文件可能失败：先删再试
        if std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::rename(&tmp, &path);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

pub fn clear_token() {
    *token_slot().lock().unwrap_or_else(|e| e.into_inner()) = None;
    // 退出登录/令牌失效：让长连接立即断开，避免继续用已作废令牌
    crate::notify_ws::on_auth_changed();
    if let Some(dir) = CONFIG_DIR.get() {
        let _ = std::fs::remove_file(dir.join(TOKEN_FILE));
    }
}

pub fn has_token() -> bool {
    token().is_some()
}

/// 通用 RPC：返回原始 JSON。
/// RPC 结果：允许 304（内容未变）作为正常返回，调用方据此复用本地缓存。
pub struct RpcOutcome {
    pub not_modified: bool,
    pub etag: Option<String>,
    pub value: Option<Value>,
}

pub async fn rpc_raw(command: &str, args: Value) -> Result<Value, String> {
    match rpc_raw_etag(command, args, None).await? {
        RpcOutcome { value: Some(value), .. } => Ok(value),
        RpcOutcome { value: None, .. } => Err(db_err(DbErrorKind::Network, "云服务响应为空".to_string())),
    }
}

/// 带 ETag 的 RPC：发送 If-None-Match，服务端回 304 时不解析响应体。
pub async fn rpc_raw_etag(
    command: &str,
    args: Value,
    etag: Option<String>,
) -> Result<RpcOutcome, String> {
    if crate::db::offline_dev() {
        return Err(crate::db::offline_dev_err());
    }
    let url = format!("{}/rpc/{command}", require_base()?);
    // 传输信封：密钥可用时请求体整体加密；信封本身即「新版客户端」能力标记，
    // 服务端据此决定是否加密响应（旧版客户端始终收到明文，完全兼容）。
    let body = crate::xport::seal_args(&args).unwrap_or_else(|| args.clone());
    let mut req = http().post(url).json(&body);
    if let Some(tok) = token() {
        req = req.bearer_auth(tok);
    }
    if let Some(tag) = etag.as_deref() {
        req = req.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    let resp = req.send().await.map_err(|e| {
        mark_failure();
        log::warn!("[api] {command} 请求失败: {e}");
        db_err(
            DbErrorKind::Network,
            format!("无法连接云服务（{}）", describe_reqwest_err(&e)),
        )
    })?;

    let status = resp.status();
    let etag_header = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if status == reqwest::StatusCode::NOT_MODIFIED {
        mark_success();
        return Ok(RpcOutcome {
            not_modified: true,
            etag: etag_header,
            value: None,
        });
    }
    let text = resp.text().await.unwrap_or_default();

    if status.is_success() {
        mark_success();
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| db_err(DbErrorKind::Network, format!("云服务响应格式异常: {e}")))?;
        let value = crate::xport::unwrap_response(value)
            .map_err(|e| db_err(DbErrorKind::Network, format!("云服务响应解封失败: {e}")))?;

        // 登录/注册成功：保存令牌并从返回体移除，前端页面永远看不到
        if matches!(command, "db_login" | "db_register" | "db_legacy_login") {
            let token = value
                .get("data")
                .and_then(|d| d.get("token"))
                .and_then(|t| t.as_str())
                .map(str::to_string);
            if let Some(tok) = token {
                save_token(&tok);
            }
            let mut value = value;
            if let Some(data) = value.get_mut("data").and_then(|d| d.as_object_mut()) {
                data.remove("token");
            }
            return Ok(RpcOutcome { not_modified: false, etag: etag_header, value: Some(value) });
        }
        return Ok(RpcOutcome { not_modified: false, etag: etag_header, value: Some(value) });
    }

    // 非 2xx：服务端统一返回 { error, code }（新版客户端场景下可能被信封包裹）
    mark_failure();
    let parsed = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| crate::xport::unwrap_response(v).ok());
    let error = parsed
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| format!("云服务返回 HTTP {status}"));

    if status == reqwest::StatusCode::UNAUTHORIZED {
        // 令牌失效：清掉，后续请求以匿名身份失败/降级
        clear_token();
        return Err(db_err(DbErrorKind::AuthFailed, error));
    }
    log::warn!("[api] {command} 返回 {status}: {error}");
    Err(error)
}

/// 通用 RPC：反序列化为 ApiResponse。
pub async fn rpc_command(command: &str, args: Value) -> Result<ApiResponse, String> {
    let value = rpc_raw(command, args).await?;
    serde_json::from_value(value)
        .map_err(|e| db_err(DbErrorKind::Network, format!("云服务响应解析失败: {e}")))
}

/// 泛型 RPC（给本地混合流程取 data 用）。
pub async fn rpc_data<T: DeserializeOwned>(command: &str, args: Value) -> Result<T, String> {
    let value = rpc_raw(command, args).await?;
    if value.get("success").and_then(|s| s.as_bool()) == Some(false) {
        let msg = value
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("云服务返回失败");
        return Err(msg.to_string());
    }
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    serde_json::from_value(data)
        .map_err(|e| db_err(DbErrorKind::Network, format!("云服务数据解析失败: {e}")))
}

/// 校验服务端健康状态（信号灯 / 诊断用）。
pub async fn health() -> Result<Value, String> {
    let url = format!("{}/health", require_base()?);
    let resp = http().get(url).send().await.map_err(|e| {
        db_err(
            DbErrorKind::Network,
            format!("无法连接云服务（{}）", describe_reqwest_err(&e)),
        )
    })?;
    resp.json::<Value>()
        .await
        .map_err(|e| db_err(DbErrorKind::Network, format!("健康检查响应异常: {e}")))
}

/// 上传进度回调类型。
pub type UploadProgressFn = std::sync::Arc<dyn Fn(u64, u64) + Send + Sync + 'static>;

fn upload_mime(file_name: &str) -> &'static str {
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
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn upload_error_text(status: reqwest::StatusCode, text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("上传失败：HTTP {status}"))
}

/// 预签名直传：服务端只签发一次性 PUT 地址，文件本体由客户端直飞 R2。
/// 旧服务端无该接口（404/405）时返回 `Ok(None)`，由调用方回退到 multipart 中转。
async fn upload_file_direct(
    file_path: &str,
    file_name: &str,
    folder: &str,
    total: u64,
    on_progress: Option<UploadProgressFn>,
) -> Result<Option<ApiResponse>, String> {
    let base = require_base()?;
    let payload = serde_json::json!({ "name": file_name, "size": total, "folder": folder });
    let mut req = upload_http()
        .post(format!("{base}/upload/presign"))
        .timeout(Duration::from_secs(30))
        .json(&payload);
    if let Some(tok) = token() {
        req = req.bearer_auth(tok);
    }
    let resp = req.send().await.map_err(|e| {
        db_err(
            DbErrorKind::Network,
            format!("直传签名失败: {}", describe_reqwest_err(&e)),
        )
    })?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::METHOD_NOT_ALLOWED {
        return Ok(None);
    }
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            clear_token();
        }
        return Err(db_err(DbErrorKind::Network, upload_error_text(status, &text)));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| db_err(DbErrorKind::Network, format!("直传签名响应异常: {e}")))?;
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let upload_url = data
        .get("upload_url")
        .and_then(Value::as_str)
        .ok_or_else(|| db_err(DbErrorKind::Network, "直传签名缺少上传地址".to_string()))?
        .to_string();
    let object_key = data
        .get("object_key")
        .and_then(Value::as_str)
        .ok_or_else(|| db_err(DbErrorKind::Network, "直传签名缺少对象路径".to_string()))?
        .to_string();

    let file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("打开待上传文件失败: {e}"))?;
    let body = reqwest::Body::wrap_stream(file_stream(file, total, on_progress));
    let put = upload_http()
        .put(&upload_url)
        .header(reqwest::header::CONTENT_LENGTH, total)
        .header(reqwest::header::CONTENT_TYPE, upload_mime(file_name))
        .body(body)
        .send();
    let put_resp = match tokio::time::timeout(Duration::from_secs(1800), put).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(e)) => {
            abandon_direct_upload(&object_key).await;
            return Err(db_err(
                DbErrorKind::Network,
                format!("直传失败: {}", describe_reqwest_err(&e)),
            ));
        }
        Err(_) => {
            abandon_direct_upload(&object_key).await;
            return Err(db_err(DbErrorKind::Network, "直传超时（30 分钟）"));
        }
    };
    if !put_resp.status().is_success() {
        let status = put_resp.status();
        abandon_direct_upload(&object_key).await;
        return Err(db_err(
            DbErrorKind::Network,
            format!("直传失败：HTTP {status}"),
        ));
    }

    let mut req = upload_http()
        .post(format!("{base}/upload/complete"))
        .timeout(Duration::from_secs(60))
        .json(&serde_json::json!({ "object_key": object_key }));
    if let Some(tok) = token() {
        req = req.bearer_auth(tok);
    }
    let resp = req.send().await.map_err(|e| {
        db_err(
            DbErrorKind::Network,
            format!("直传登记失败: {}", describe_reqwest_err(&e)),
        )
    })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(db_err(DbErrorKind::Network, upload_error_text(status, &text)));
    }
    serde_json::from_str::<ApiResponse>(&text)
        .map(Some)
        .map_err(|e| db_err(DbErrorKind::Network, format!("直传登记响应异常: {e}")))
}

/// 直传失败/取消时尽力清理服务端预占与半成品对象（失败不影响主流程报错）。
async fn abandon_direct_upload(object_key: &str) {
    let Ok(base) = require_base() else {
        return;
    };
    let mut req = upload_http()
        .post(format!("{base}/upload/abandon"))
        .timeout(Duration::from_secs(15))
        .json(&serde_json::json!({ "object_key": object_key }));
    if let Some(tok) = token() {
        req = req.bearer_auth(tok);
    }
    let _ = req.send().await;
}

/// 上传本地文件。优先预签名直传（不经服务器转发），旧服务端回退 multipart 中转。
/// `on_progress(loaded, total)` 用于 UI 进度。
pub async fn upload_file(
    file_path: String,
    file_name: String,
    folder: String,
    channel: Option<String>,
    upload_name_type: Option<String>,
    upload_id: Option<String>,
    on_progress: Option<UploadProgressFn>,
) -> Result<ApiResponse, String> {
    if crate::db::offline_dev() {
        return Err(crate::db::offline_dev_err());
    }
    let meta = tokio::fs::metadata(&file_path)
        .await
        .map_err(|e| format!("读取待上传文件失败: {e}"))?;
    let total = meta.len();
    if total == 0 || total > 20 * 1024 * 1024 {
        return Err("待上传文件为空或超过 20 MiB 上限".into());
    }
    // 优先直传 R2：文件本体不经过 HK；旧服务端返回 Ok(None) 时回退 multipart 中转。
    match upload_file_direct(
        &file_path,
        &file_name,
        &folder,
        total,
        on_progress.clone(),
    )
    .await
    {
        Ok(Some(response)) => return Ok(response),
        Ok(None) => {}
        Err(error) => return Err(error),
    }

    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("打开待上传文件失败: {e}"))?;

    let body = reqwest::Body::wrap_stream(file_stream(file, total, on_progress));
    let ext = file_name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "zip" => "application/zip",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    let part = reqwest::multipart::Part::stream_with_length(body, total)
        .file_name(file_name.clone())
        .mime_str(mime)
        .map_err(|e| format!("设置 MIME 失败: {e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .text("folder", folder)
        .text("file_name", file_name);
    if let Some(channel) = channel {
        form = form.text("channel", channel);
    }
    if let Some(name_type) = upload_name_type {
        form = form.text("upload_name_type", name_type);
    }
    let form = form.part("file", part);

    let url = format!("{}/upload", require_base()?);
    let mut req = upload_http().post(url).multipart(form);
    if let Some(tok) = token() {
        req = req.bearer_auth(tok);
    }
    let _ = upload_id; // 取消由调用方 drop future 实现
    let resp = tokio::time::timeout(Duration::from_secs(1800), req.send())
        .await
        .map_err(|_| db_err(DbErrorKind::Network, "上传超时（30 分钟）"))?
        .map_err(|e| {
            db_err(
                DbErrorKind::Network,
                format!("上传失败: {}", describe_reqwest_err(&e)),
            )
        })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        if status == reqwest::StatusCode::UNAUTHORIZED {
            clear_token();
        }
        let error = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| format!("上传失败：HTTP {status}"));
        return Err(db_err(DbErrorKind::Network, error));
    }
    serde_json::from_str::<ApiResponse>(&text)
        .map_err(|e| db_err(DbErrorKind::Network, format!("上传响应解析失败: {e}")))
}

fn file_stream(
    mut file: tokio::fs::File,
    total: u64,
    on_progress: Option<UploadProgressFn>,
) -> impl futures_util::Stream<Item = Result<Vec<u8>, std::io::Error>> + Send + 'static {
    use tokio::io::AsyncReadExt;
    futures_util::stream::try_unfold(
        (file, 0u64, total, on_progress),
        move |(mut file, loaded, total, cb)| async move {
            let mut buf = vec![0u8; 256 * 1024];
            let n = file.read(&mut buf).await?;
            if n == 0 {
                return Ok(None);
            }
            buf.truncate(n);
            let loaded = loaded + n as u64;
            if let Some(cb) = &cb {
                cb(loaded, total);
            }
            Ok(Some((buf, (file, loaded, total, cb))))
        },
    )
}

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
