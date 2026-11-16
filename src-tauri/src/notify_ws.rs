//! 桌面端通知长连接（WebSocket）。
//!
//! 位置选择：连接放在 Rust 侧而不是前端，原因有三：
//! - 登录令牌只存在 Rust 侧（`api_token`），前端永远拿不到；
//! - 连接不受 WebView 刷新、页面卸载、后台计时器节流影响；
//! - 已有 `tokio-tungstenite` 依赖，可直接复用。
//!
//! 协议：服务端每 30s 发 JSON `ping`，客户端回 `pong`；任一端 90s 无帧判死。
//! 收到事件后通过 Tauri event 转给前端，前端再按现有 RPC 拉未读数/列表。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::{interval_at, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, USER_AGENT};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// 心跳周期：与服务端默认值一致（服务端 hello 也会回报实际值）。
const HEARTBEAT: Duration = Duration::from_secs(30);
/// 判死阈值：3 个心跳周期。
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// 握手超时。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

static APP: OnceLock<AppHandle> = OnceLock::new();
static AUTH_CHANGED: OnceLock<Notify> = OnceLock::new();
static WAKE: OnceLock<Notify> = OnceLock::new();
/// 最近一次状态快照：前端晚于连接建立才订阅时，用 `notify_ws_wake` 补发，
/// 避免信号灯一直停在 unknown。
static LAST_STATE: OnceLock<Mutex<Option<Value>>> = OnceLock::new();

fn last_state() -> &'static Mutex<Option<Value>> {
    LAST_STATE.get_or_init(|| Mutex::new(None))
}

fn auth_notify() -> &'static Notify {
    AUTH_CHANGED.get_or_init(Notify::new)
}

fn wake_notify() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

/// 启动时调用一次：保存 AppHandle 并拉起监督任务。
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    tauri::async_runtime::spawn(supervisor());
}

/// 登录/退出/换账号时调用：打断当前等待，用新令牌重新决策。
pub fn on_auth_changed() {
    // notify_one 会保留一次「许可」，避免唤醒恰好发生在监督任务进入等待之前而丢失
    auth_notify().notify_one();
}

/// 网络恢复/窗口重新激活时调用：提前结束退避等待。
pub fn wake() {
    wake_notify().notify_one();
}

/// 前端 `window online` / 页面挂载时调用（Tauri command）。
/// 除了唤醒退避，还把最近一次连接状态补发给刚订阅的前端。
#[tauri::command]
pub fn notify_ws_wake() {
    wake();
    let snapshot = last_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let (Some(app), Some(payload)) = (APP.get(), snapshot) {
        let _ = app.emit("cloud-notify-state", payload);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn ws_disabled() -> bool {
    match std::env::var("SFMMM_WS_DISABLE") {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            !(v.is_empty() || v == "0" || v == "false" || v == "off")
        }
        Err(_) => false,
    }
}

/// 从云 API 基址派生 WebSocket 地址。
///
/// 必须用 `url` 解析（`reqwest::Url` 内部做 IDNA），否则中文域名会被
/// `http::Uri` 拒绝；序列化后用 punycode ASCII 交给 tungstenite。
fn ws_url_from(base: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("云 API 地址非法: {e}"))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => return Err(format!("不支持为 {other} 建立 WebSocket")),
    };
    url.set_scheme(scheme)
        .map_err(|_| "切换 WebSocket scheme 失败".to_string())?;
    let path = format!("{}/ws", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

fn ws_url() -> Result<reqwest::Url, String> {
    ws_url_from(&crate::api::base_url())
}

fn emit_state(state: &str, retry: Option<Duration>) {
    let Some(app) = APP.get() else {
        return;
    };
    let mut payload = json!({
        "state": state,
        "since_ms": now_ms(),
    });
    if let Some(delay) = retry {
        payload["retry_in_ms"] = json!(delay.as_millis() as u64);
    }
    *last_state().lock().unwrap_or_else(|e| e.into_inner()) = Some(payload.clone());
    if let Err(e) = app.emit("cloud-notify-state", payload) {
        log::debug!("[notify_ws] 发送状态事件失败: {e}");
    }
}

fn emit_notify(payload: &Value) {
    let Some(app) = APP.get() else {
        return;
    };
    if let Err(e) = app.emit("cloud-notify", payload.clone()) {
        log::debug!("[notify_ws] 发送通知事件失败: {e}");
    }
}

fn backoff_delay(attempt: u32) -> Duration {
    let base_ms: u64 = match attempt {
        0 => 1_000,
        1 => 2_000,
        2 => 4_000,
        3 => 8_000,
        4 => 16_000,
        5 => 30_000,
        6 => 60_000,
        _ => 300_000,
    };
    // 0–25% 抖动，避免服务端重启后所有客户端同频重连
    let span = (base_ms / 4).max(1);
    let jitter = now_ms() % span;
    Duration::from_millis(base_ms + jitter)
}

/// 等待退避时长；登录态变化或网络恢复时提前返回。
async fn wait_any(duration: Duration) {
    tokio::select! {
        _ = tokio::time::sleep(duration) => {}
        _ = auth_notify().notified() => {}
        _ = wake_notify().notified() => {}
    }
}

enum ConnEnd {
    Closed { connected: bool },
    AuthRequired,
    Unsupported,
}

async fn supervisor() {
    let mut attempt: u32 = 0;

    loop {
        if ws_disabled() || crate::db::offline_dev() {
            emit_state("disabled", None);
            wait_any(Duration::from_secs(300)).await;
            continue;
        }

        if crate::api::token_snapshot().is_none() {
            // 未登录不是异常：信号灯保持中性，不显示「登录已失效」
            emit_state("signed_out", None);
            attempt = 0;
            wait_any(Duration::from_secs(30)).await;
            continue;
        }

        emit_state("connecting", None);

        match run_once().await {
            Ok(ConnEnd::Closed { connected }) => {
                if connected {
                    attempt = 0;
                }
            }
            Ok(ConnEnd::AuthRequired) => {
                emit_state("auth_required", None);
                attempt = 0;
                // 等登录态变化；期间不重试，避免对已失效令牌反复握手
                wait_any(Duration::from_secs(3600)).await;
                continue;
            }
            Ok(ConnEnd::Unsupported) => {
                emit_state("unsupported", None);
                attempt = 0;
                wait_any(Duration::from_secs(1800)).await;
                continue;
            }
            Err(e) => {
                log::warn!("[notify_ws] {e}");
            }
        }

        let delay = backoff_delay(attempt);
        attempt = attempt.saturating_add(1);
        emit_state("backoff", Some(delay));
        wait_any(delay).await;
    }
}

async fn run_once() -> Result<ConnEnd, String> {
    let url = ws_url()?;
    let token = crate::api::token_snapshot().ok_or_else(|| "无登录令牌".to_string())?;

    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("构造 WS 请求失败: {e}"))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "令牌含非法头部字符".to_string())?,
    );
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_str(&crate::db::user_agent())
            .map_err(|_| "User-Agent 含非法头部字符".to_string())?,
    );

    let (ws, _resp) = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    {
        Err(_) => return Err("WS 握手超时".to_string()),
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            if let WsError::Http(resp) = &e {
                let status = resp.status().as_u16();
                match status {
                    401 => return Ok(ConnEnd::AuthRequired),
                    404 | 405 => return Ok(ConnEnd::Unsupported),
                    _ => return Err(format!("WS 握手失败 HTTP {status}")),
                }
            }
            return Err(format!("WS 连接失败: {e}"));
        }
    };

    let (mut sink, mut stream) = ws.split();
    let mut connected = false;
    let mut last_rx = Instant::now();
    let mut seq: u64 = 0;

    // 默认 30s / 90s；收到 hello 后按服务端下发的 heartbeat_secs 对齐，
    // 避免运维调大服务端心跳时客户端仍按 90s 判死而误重连。
    let mut hb = HEARTBEAT;
    let mut idle = IDLE_TIMEOUT;
    let mut ticker = interval_at(Instant::now() + hb, hb);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if last_rx.elapsed() > idle {
                    log::warn!("[notify_ws] 心跳超时，准备重连");
                    return Ok(ConnEnd::Closed { connected });
                }
                seq += 1;
                let ping = json!({
                    "type": "ping",
                    "seq": seq,
                    "ts": now_ms(),
                })
                .to_string();
                if sink.send(Message::Text(ping.into())).await.is_err() {
                    return Ok(ConnEnd::Closed { connected });
                }
            }
            _ = auth_notify().notified() => {
                return Ok(ConnEnd::Closed { connected });
            }
            _ = wake_notify().notified() => {
                // 已连接时不因网络事件强制重建；半开连接交给心跳判死
            }
            msg = stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        last_rx = Instant::now();
                        if let Ok(value) = serde_json::from_str::<Value>(text.as_str()) {
                            match value.get("type").and_then(|v| v.as_str()) {
                                Some("hello") => {
                                    if let Some(secs) = value
                                        .get("heartbeat_secs")
                                        .and_then(|v| v.as_u64())
                                        .map(|v| v.clamp(10, 120))
                                    {
                                        let next = Duration::from_secs(secs);
                                        if next != hb {
                                            hb = next;
                                            idle = hb * 3;
                                            ticker = interval_at(Instant::now() + hb, hb);
                                            ticker.set_missed_tick_behavior(
                                                MissedTickBehavior::Delay,
                                            );
                                        }
                                    }
                                    if !connected {
                                        connected = true;
                                        emit_state("connected", None);
                                    }
                                }
                                Some("ping") => {
                                    let seq = value.get("seq").cloned().unwrap_or(Value::Null);
                                    let pong = json!({
                                        "type": "pong",
                                        "seq": seq,
                                        "ts": now_ms(),
                                    })
                                    .to_string();
                                    if sink.send(Message::Text(pong.into())).await.is_err() {
                                        return Ok(ConnEnd::Closed { connected });
                                    }
                                }
                                Some("notify") => emit_notify(&value),
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {
                        last_rx = Instant::now();
                    }
                    // Frame 仅供底层写帧使用，客户端读循环不会收到
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.map(|f| u16::from(f.code)).unwrap_or(1000);
                        return Ok(if code == 4401 {
                            ConnEnd::AuthRequired
                        } else {
                            ConnEnd::Closed { connected }
                        });
                    }
                    Some(Ok(Message::Binary(_))) => {
                        return Ok(ConnEnd::Closed { connected });
                    }
                    Some(Err(_)) | None => {
                        return Ok(ConnEnd::Closed { connected });
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_wss_url_and_idna() {
        let url = ws_url_from("https://api.example.com/api/user").expect("url");
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.path(), "/api/user/ws");
        assert!(url.host_str().unwrap_or("").is_ascii());
    }

    #[test]
    fn builds_ws_url_with_trailing_slash() {
        let url = ws_url_from("http://127.0.0.1:8080/api/user/").expect("url");
        assert_eq!(url.scheme(), "ws");
        assert_eq!(url.path(), "/api/user/ws");
    }

    #[test]
    fn rejects_non_http_scheme() {
        assert!(ws_url_from("ftp://example.com/api/user").is_err());
    }

    #[test]
    fn backoff_grows_to_cap() {
        assert!(backoff_delay(0) <= Duration::from_millis(1_250));
        assert!(backoff_delay(6) >= Duration::from_secs(60));
        assert!(backoff_delay(9) >= Duration::from_secs(300));
    }
}
