//! F95 站点代理配置。只作用于专用 webview（label `LABEL`），不影响 AI 翻译请求。
use super::*;
use serde::{Deserialize, Serialize};

const SETTING: &str = "f95_proxy";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxySettings {
    host: String,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyView {
    host: String,
    port: u16,
}

impl From<ProxySettings> for ProxyView {
    fn from(value: ProxySettings) -> Self {
        Self { host: value.host, port: value.port }
    }
}

/// 把分开的主机/端口输入校验并拼成 `http://host:port`。
/// 只有地址和端口由用户填写，scheme 固定为 http；需要 socks5 时仍可用环境变量。
fn normalize_proxy(host: &str, port: &str) -> Result<Url, &'static str> {
    let host = host.trim();
    let port = port.trim();
    if host.is_empty()
        || host.len() > 253
        || host.chars().any(char::is_whitespace)
        || host.contains("://")
        || host.contains('/')
        || host.contains('@')
        || host.contains('?')
        || host.contains('#')
    {
        return Err("proxyHost");
    }
    let port: u16 = port.parse().map_err(|_| "proxyPort")?;
    if port == 0 {
        return Err("proxyPort");
    }
    let url = Url::parse(&format!("http://{host}:{port}")).map_err(|_| "proxyHost")?;
    if url.host_str().map_or(true, str::is_empty) || url.port() != Some(port) {
        return Err("proxyHost");
    }
    Ok(url)
}

fn settings(app_handle: &tauri::AppHandle) -> Result<Option<ProxySettings>, &'static str> {
    let db = crate::db::subscribe::open_sqlite(app_handle).map_err(|_| "proxyRead")?;
    let value: Option<String> = db
        .query_row("SELECT value FROM config WHERE key = ?1", [SETTING], |row| row.get(0))
        .optional()
        .map_err(|_| "proxyRead")?;
    value
        .filter(|value| !value.trim().is_empty())
        .map(|value| serde_json::from_str(&value).map_err(|_| "proxyRead"))
        .transpose()
}

/// webview 建窗时取生效代理：用户配置优先，未配置时回退环境变量（保留原 http/socks5 行为）。
pub(super) fn effective_proxy_url(app_handle: &tauri::AppHandle) -> Option<Url> {
    if let Some(config) = settings(app_handle).ok().flatten() {
        if let Ok(url) = normalize_proxy(&config.host, &config.port.to_string()) {
            return Some(url);
        }
    }
    std::env::var("SFMMM_F95_PROXY")
        .ok()
        .and_then(|value| Url::parse(&value).ok())
        .filter(|url| matches!(url.scheme(), "http" | "socks5"))
}

#[tauri::command]
pub fn f95_proxy_settings(window: WebviewWindow) -> Result<Option<ProxyView>, &'static str> {
    require_main(&window)?;
    Ok(settings(window.app_handle())?.map(ProxyView::from))
}

#[tauri::command]
pub async fn f95_save_proxy_settings(
    window: WebviewWindow,
    host: Option<String>,
    port: Option<String>,
) -> Result<Option<ProxyView>, &'static str> {
    require_main(&window)?;
    let app = window.app_handle();

    let view = if host.as_deref().unwrap_or("").trim().is_empty() {
        let db = crate::db::subscribe::open_sqlite(app).map_err(|_| "proxyWrite")?;
        db.execute("DELETE FROM config WHERE key = ?1", params![SETTING])
            .map_err(|_| "proxyWrite")?;
        None
    } else {
        let url = normalize_proxy(host.as_deref().unwrap_or(""), port.as_deref().unwrap_or(""))?;
        let config = ProxySettings {
            host: host.unwrap().trim().to_string(),
            port: url.port().ok_or("proxyPort")?,
        };
        let data = serde_json::to_string(&config).map_err(|_| "proxyWrite")?;
        let db = crate::db::subscribe::open_sqlite(app).map_err(|_| "proxyWrite")?;
        db.execute(
            "INSERT INTO config (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![SETTING, data],
        )
        .map_err(|_| "proxyWrite")?;
        Some(ProxyView::from(config))
    };

    // proxy_url 只在建窗时生效：销毁旧窗口，下次打开按新配置建窗。
    // 不清浏览数据，保留 F95 登录会话。
    let _work = BROWSER_WORK.lock().await;
    if let Some(browser) = app.get_webview_window(LABEL) {
        browser.destroy().map_err(|_| "windowOpen")?;
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::normalize_proxy;

    #[test]
    fn accepts_domains_and_ips() {
        for host in ["proxy.example.com", "127.0.0.1", "[::1]"] {
            let url = normalize_proxy(host, "8080").unwrap();
            assert_eq!(url.scheme(), "http");
            assert_eq!(url.port(), Some(8080));
        }
    }

    #[test]
    fn trims_inputs() {
        let url = normalize_proxy("  proxy.example.com  ", " 3128 ").unwrap();
        assert_eq!(url.host_str(), Some("proxy.example.com"));
        assert_eq!(url.port(), Some(3128));
    }

    #[test]
    fn rejects_bad_hosts() {
        for host in ["", "   ", "http://proxy.example.com", "proxy.example.com/path", "a@b", "a?b", "a#b", "has space", &"a".repeat(254)] {
            assert!(normalize_proxy(host, "8080").is_err(), "host={host:?}");
        }
    }

    #[test]
    fn rejects_bad_ports() {
        for port in ["", "0", "65536", "abc", "80x", "-1"] {
            assert!(normalize_proxy("proxy.example.com", port).is_err(), "port={port:?}");
        }
        assert!(normalize_proxy("proxy.example.com", "65535").is_ok());
    }

    #[test]
    fn rejects_host_with_embedded_port() {
        assert!(normalize_proxy("127.0.0.1:8080", "3128").is_err());
    }
}
