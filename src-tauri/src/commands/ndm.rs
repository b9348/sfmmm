//! NDM（Neat Download Manager）集成：把下载任务交给正在运行的 NDM。
//!
//! 通道与 NDM 的浏览器扩展完全一致：本机 `ws://127.0.0.1:10007/download`，
//! 子协议 `neatextension.v1`，载荷用字段号形式的行协议（`1:GET` / `2:<url>` / …）。
//! NDM 没有公开的命令行加链接参数，这是唯一可编程的入口。
//!
//! 只探测端口、不查找安装路径、不代为启动：NDM 的浏览器扩展同样只能往
//! 「已经开着的 NDM」推送，不会去拉起它。刻意不猜安装位置——别人的 NDM 装在哪
//! 无从得知（实测本机在 `Program Files\Neat Download Manager\NeatDM.exe`，
//! 与常见的 `NeatDownloadManager.exe` 并不一致），猜错只会把"能用"误判成"没装"。
//!
//! 端口没监听时由前端提示「请先打开 NDM」并把地址复制到剪贴板；用户开着 NDM
//! 再点一次即可。
//!
//! 域名改写交给 `db::cdn::rewrite_url`：用户在设置里选的线路（含自动测速结论）
//! 对内置下载和 NDM 必须一致，否则同一次下载两种速度。

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::SinkExt;
use serde::Serialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// NDM 本地服务的固定端口（其浏览器扩展硬编码同一个，不提供配置项）。
const NDM_PORT: u16 = 10007;
/// 回环连接的读写超时：本机通信慢成这样就是没起来，不必久等。
const IO_TIMEOUT: Duration = Duration::from_secs(5);
/// 端口探测超时：回环 connect 正常是亚毫秒级，等这么久还没结果就是没监听。
const PROBE_TIMEOUT: Duration = Duration::from_millis(600);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NdmStatus {
    /// NDM 是否正在运行（= 本地服务端口是否在监听）
    pub running: bool,
}

/// NDM 是否已在监听（回环 TCP 能连上就算就绪）。
async fn port_ready() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], NDM_PORT));
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// 组任务载荷。
///
/// 字段号沿用 NDM 浏览器扩展的格式：`1:` 方法、`2:` URL、`4:` 留空（文件名由 NDM
/// 从 URL 末段解出，我们的地址本身带 `.zip` 原名）、`6:normal` 进普通队列。
/// 实测该格式会被 NDM 接受并立即建任务（其 LogFile 里能看到对应的 GET 请求）。
fn build_payload(url: &str) -> String {
    format!(
        "1:GET\r\n\
         2:{url}\r\n\
         User-Agent:{ua}\r\n\
         4:\r\n\
         6:normal\r\n",
        ua = crate::db::user_agent()
    )
}

/// 把任务推给正在监听的 NDM。
///
/// 注意：握手成功后 NDM 会先推几条与任务无关的控制消息（ShowPanel* 等），
/// 我们不读也不依赖它——任务是否真的建立以 NDM 自己为准，这里只保证指令送达。
async fn push_task(url: &str) -> Result<(), String> {
    let endpoint = format!("ws://127.0.0.1:{NDM_PORT}/download");
    let mut request = endpoint
        .into_client_request()
        .map_err(|e| format!("构造 NDM 请求失败: {e}"))?;
    // NDM 只认带自家子协议的升级请求，缺了会在握手阶段被拒
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "neatextension.v1"
            .parse()
            .map_err(|_| "构造子协议头失败".to_string())?,
    );
    // 浏览器扩展带的是自家 origin；NDM 只在回环上，给个普通 http 源即可
    request.headers_mut().insert(
        "Origin",
        "http://localhost/"
            .parse()
            .map_err(|_| "构造 Origin 头失败".to_string())?,
    );

    let (mut ws, _resp) = tokio::time::timeout(
        IO_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "连接 NDM 超时".to_string())?
    .map_err(|e| format!("连接 NDM 失败: {e}"))?;

    ws.send(Message::Text(build_payload(url).into()))
        .await
        .map_err(|e| format!("发送下载任务失败: {e}"))?;

    // 主动关帧：NDM 收到即收尾，不必等它回话
    let _ = tokio::time::timeout(IO_TIMEOUT, ws.close(None)).await;
    Ok(())
}

/// 探测 NDM 是否在运行。前端据此决定是否给出「请先打开 NDM」提示。
#[tauri::command(rename_all = "snake_case")]
pub async fn ndm_status() -> NdmStatus {
    NdmStatus {
        running: port_ready().await,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NdmSendResult {
    /// NDM 是否正在运行（false 时前端提示用户先打开它）
    pub running: bool,
    /// 是否真的把任务交出去了
    pub sent: bool,
    /// 实际交给 NDM 的地址（已按当前线路改写），未运行时前端用它复制到剪贴板
    pub url: String,
    /// 失败原因（未运行时为 None，由前端按 `running` 分支给文案）
    pub error: Option<String>,
}

/// 把下载任务交给 NDM。
///
/// 地址先经 `cdn::rewrite_url` 改写，保证 NDM 拿到的域名与软件内选定的线路一致
/// （用户关掉优选域名时，NDM 也必须走原始域名）。
#[tauri::command(rename_all = "snake_case")]
pub async fn ndm_send_download(url: String) -> Result<NdmSendResult, String> {
    if url.trim().is_empty() {
        return Err("缺少下载地址".into());
    }
    let rewritten = crate::db::cdn::rewrite_url(&url);

    // NDM 没开就没法接管：不代为启动，直接把（改写后的）地址交回前端
    if !port_ready().await {
        return Ok(NdmSendResult {
            running: false,
            sent: false,
            url: rewritten,
            error: None,
        });
    }

    match push_task(&rewritten).await {
        Ok(()) => Ok(NdmSendResult {
            running: true,
            sent: true,
            url: rewritten,
            error: None,
        }),
        Err(e) => Ok(NdmSendResult {
            running: true,
            sent: false,
            url: rewritten,
            error: Some(e),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 载荷必须包含 NDM 扩展约定的字段：方法、URL、队列类型。
    /// 少任何一个 NDM 都不会建任务，且失败是静默的（握手照样成功）。
    #[test]
    fn payload_carries_required_fields() {
        let url = "https://img.example.com/file/sfm/1.zip";
        let payload = build_payload(url);
        assert!(payload.starts_with("1:GET\r\n"), "缺方法字段");
        assert!(payload.contains(&format!("2:{url}\r\n")), "缺 URL 字段");
        assert!(payload.contains("4:\r\n"), "缺字段 4（留空占位）");
        assert!(payload.contains("6:normal\r\n"), "缺队列类型字段");
        // 行分隔必须是 CRLF：NDM 按 \r\n 切字段，单个 \n 会解析失败
        for line in payload.split("\r\n").filter(|l| !l.is_empty()) {
            assert!(!line.contains('\n'), "出现了裸 \\n 行分隔: {line}");
        }
    }

    /// URL 里带中文时不能破坏字段结构（真实 mod 包文件名常含中文）。
    #[test]
    fn payload_tolerates_non_ascii_url() {
        let url = "https://img.example.com/file/sfm/1794282813707_塞雷卡_en.zip";
        let payload = build_payload(url);
        assert!(payload.contains(url));
        // 字段数不受影响
        let fields = payload.split("\r\n").filter(|l| !l.is_empty()).count();
        assert_eq!(fields, 5, "字段数应为 5");
    }
}
