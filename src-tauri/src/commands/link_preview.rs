//! 链接卡片（onebox）元数据抓取。
//!
//! 创意工坊的讨论正文 / 评论 / 模组说明里，独占一行的裸链接会被前端渲染成卡片
//! （类似 Discourse 的 onebox）。卡片需要的标题、描述、配图与站点名本应由网页自己
//! 通过 OpenGraph 提供，但 WebView 里的 fetch 会被目标站点的 CORS 拦住，所以统一
//! 走 Rust 侧请求：顺带能设置正常的 User-Agent（不少站点对非浏览器 UA 直接返回 403）。

use futures_util::StreamExt;
use reqwest::header::{CONTENT_TYPE, LOCATION};
use reqwest::redirect::Policy;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::OnceLock;
use std::time::Duration;

/// 只读页面头部：卡片只需要 head 里的 meta，正文再大也用不上
const MAX_HTML_BYTES: u64 = 3 * 1024 * 1024;
/// 防御性上限，避免把整页塞进内存做正则
const MAX_HTML_CHARS: usize = 400_000;
const MAX_DESCRIPTION_CHARS: usize = 300;
const REQUEST_TIMEOUT_SECS: u64 = 12;

/// 抓取结果。前端点击整张卡片时用 url 打开外部浏览器。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LinkPreview {
    /// 用户填写（或规范化后）的链接
    pub url: String,
    /// 站点名（og:site_name），缺省时退化为域名
    pub site_name: String,
    /// 卡片标题（og:title / twitter:title / title 标签）
    pub title: String,
    /// 卡片摘要（og:description / description），可能为空
    pub description: String,
    /// 配图（og:image），可能为空
    pub image: Option<String>,
    /// 站点图标，可能为空
    pub icon: Option<String>,
}

/// 抓取并解析一个链接的卡片元数据。
///
/// 失败时返回 Err，前端会降级成普通链接，不影响正文展示。
#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreview, String> {
    let url = url.trim().to_string();
    validate_url(&url)?;
    // 域名可能解析到内网（DNS 投毒 / 内网域名），请求前再按解析结果查一次
    validate_resolved_host(&url).await?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        // 自己处理重定向：每一跳都重新校验 URL + DNS 解析结果，避免 302 到内网/本机
        .redirect(Policy::none())
        // 与浏览器一致的 UA：GitHub / Cloudflare 前置的站点会拒绝默认的 reqwest UA
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        )
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    const MAX_REDIRECTS: usize = 5;
    let mut current = url.clone();
    let mut fetched = None;
    for _ in 0..=MAX_REDIRECTS {
        validate_url(&current)?;
        validate_resolved_host(&current).await?;
        let resp = client
            .get(&current)
            .header("Accept", "text/html,application/xhtml+xml")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .send()
            .await
            .map_err(|e| format!("请求失败: {e}"))?;

        if resp.status().is_redirection() {
            if let Some(location) = resp.headers().get(LOCATION) {
                let location = location
                    .to_str()
                    .map_err(|_| "重定向地址非法".to_string())?;
                let next = resp
                    .url()
                    .join(location)
                    .map_err(|e| format!("重定向地址非法: {e}"))?;
                current = next.to_string();
                continue;
            }
        }
        fetched = Some(resp);
        break;
    }
    let resp = fetched.ok_or_else(|| "重定向次数过多".to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_HTML_BYTES {
            return Err("页面过大，已跳过卡片解析".into());
        }
    }

    // 流式读取并按实际字节数截断：Content-Length 缺失（chunked）时也不会把整页读进内存
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    // 相对图片/图标要按最终地址解析（跟随重定向后域名可能变化）
    let base_url = resp.url().to_string();
    let mut stream = resp.bytes_stream();
    let mut body: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取响应失败: {e}"))?;
        if body.len() + chunk.len() > MAX_HTML_BYTES as usize {
            return Err("页面过大，已跳过卡片解析".into());
        }
        body.extend_from_slice(&chunk);
    }
    // 按响应头 charset 解码（GBK 等站点由 encoding_rs 处理）
    let html = decode_html(&body, content_type.as_deref());
    let html: String = html.chars().take(MAX_HTML_CHARS).collect();

    let metas = collect_meta(&html);
    let pick = |keys: &[&str]| -> Option<String> {
        keys.iter()
            .find_map(|k| {
                metas
                    .iter()
                    .find(|(name, _)| name == k)
                    .map(|(_, v)| v.clone())
            })
            .map(|v| clean_text(&v))
            .filter(|v| !v.is_empty())
    };

    let title = pick(&["og:title", "twitter:title"])
        .or_else(|| extract_title_tag(&html))
        .unwrap_or_else(|| url.clone());
    let description = pick(&["og:description", "twitter:description", "description"])
        .map(|d| truncate_chars(&d, MAX_DESCRIPTION_CHARS))
        .unwrap_or_default();
    let image = pick(&[
        "og:image",
        "og:image:url",
        "og:image:secure_url",
        "twitter:image",
    ])
    .and_then(|src| absolutize(&base_url, &src));
    let icon = extract_icon(&html).and_then(|href| absolutize(&base_url, &href));
    let site_name = pick(&["og:site_name", "application-name"])
        .or_else(|| host_of(&url))
        .unwrap_or_else(|| url.clone());

    Ok(LinkPreview {
        site_name,
        title,
        description,
        image,
        icon,
        url,
    })
}

/// 只允许 http/https，且拒绝明显指向本机 / 内网的地址。
fn validate_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("仅支持 http/https 链接".into());
    }
    let host = host_of(url).ok_or_else(|| "无法解析链接域名".to_string())?;
    if host.contains('@') {
        return Err("链接格式非法".into());
    }
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err("不支持本机地址".into());
    }
    if is_private_ip(&host) {
        return Err("不支持内网地址".into());
    }
    Ok(())
}

/// 请求前解析域名并按实际 IP 判断是否为内网地址。
///
/// 注：reqwest 建立连接时会再次解析（DNS rebinding 的 TOCTOU 无法完全消除），
/// 但这一步已经能挡住绝大多数「域名指向内网」的情况。
async fn validate_resolved_host(url: &str) -> Result<(), String> {
    let host = host_of(url).ok_or_else(|| "无法解析链接域名".to_string())?;
    if host.contains('@') {
        return Err("链接格式非法".into());
    }
    let (name, port) = split_host_port(&host);
    let default_port = if url.to_ascii_lowercase().starts_with("https://") {
        443
    } else {
        80
    };
    let port = port.unwrap_or(default_port);

    let lookup = tokio::net::lookup_host((name.as_str(), port)).await;
    match lookup {
        Ok(addrs) => {
            let mut any = false;
            for addr in addrs {
                any = true;
                if is_private_addr(addr.ip()) {
                    return Err("不支持内网地址".into());
                }
            }
            if !any {
                return Err("无法解析链接域名".into());
            }
            Ok(())
        }
        Err(_) => {
            // 纯 IP 字面量不需要 DNS；解析失败的情况交给真正的 HTTP 请求报错
            if name.parse::<IpAddr>().is_ok() {
                Ok(())
            } else {
                Err("无法解析链接域名".into())
            }
        }
    }
}

/// 去掉 host 里的端口与 IPv6 方括号
fn strip_port(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match host.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host,
    }
}

fn split_host_port(host: &str) -> (String, Option<u16>) {
    if let Some(rest) = host.strip_prefix('[') {
        if let Some(idx) = rest.find(']') {
            let name = rest[..idx].to_string();
            let port = rest[idx + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok());
            return (name, port);
        }
    }
    match host.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (h.to_string(), p.parse::<u16>().ok())
        }
        _ => (host.to_string(), None),
    }
}

fn is_private_ip(host: &str) -> bool {
    let host = strip_port(host);
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_addr(ip);
    }
    // inet_aton 风格：127.1、2130706433、0x7f000001、0177.0.0.1
    match parse_ipv4_loose(host) {
        Some(v4) => is_private_v4(v4),
        None => false,
    }
}

fn is_private_addr(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_v4(v4);
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
        }
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    matches!(
        (o[0], o[1]),
        (0, _)
            | (10, _)
            | (127, _)
            | (169, 254)
            | (172, 16..=31)
            | (192, 168)
            | (100, 64..=127)
            | (198, 18..=19)
    ) || o[0] >= 224
}

/// 按 inet_aton 语义解析宽松 IPv4（1~4 段，支持十进制/十六进制/八进制）
fn parse_ipv4_loose(host: &str) -> Option<Ipv4Addr> {
    if host.is_empty() {
        return None;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 4 {
        return None;
    }
    let mut vals: Vec<u32> = Vec::with_capacity(parts.len());
    for p in &parts {
        if p.is_empty() {
            return None;
        }
        let v = if let Some(hex) = p.strip_prefix("0x").or_else(|| p.strip_prefix("0X")) {
            u32::from_str_radix(hex, 16).ok()?
        } else if p.len() > 1 && p.starts_with('0') {
            u32::from_str_radix(&p[1..], 8).ok()?
        } else {
            p.parse::<u32>().ok()?
        };
        vals.push(v);
    }
    let n = vals.len();
    let mut addr: u32 = 0;
    for (i, v) in vals.iter().enumerate() {
        if i + 1 < n {
            if *v > 255 {
                return None;
            }
            addr |= *v << (24 - 8 * i);
        } else {
            let max = (1u64 << (8 * (5 - n))) - 1;
            if *v as u64 > max {
                return None;
            }
            addr |= *v;
        }
    }
    Some(Ipv4Addr::from(addr))
}

/// 按 Content-Type 的 charset 解码响应体（缺省 UTF-8）
fn decode_html(bytes: &[u8], content_type: Option<&str>) -> String {
    let label = content_type.and_then(|ct| {
        ct.split(';').find_map(|part| {
            part.trim()
                .strip_prefix("charset=")
                .map(|v| v.trim_matches('"').trim())
        })
    });
    let encoding = label
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

/// 取 "https://host/path" 里的 host（含端口）
fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split(['/', '?', '#']).next()?.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// 取协议 + 域名，用于把相对路径补成绝对地址
fn origin_of(url: &str) -> Option<String> {
    let scheme = url.split("://").next()?;
    let host = host_of(url)?;
    Some(format!("{scheme}://{host}"))
}

fn absolutize(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() {
        return None;
    }
    if href.starts_with("http://") || href.starts_with("https://") {
        return Some(href.to_string());
    }
    let origin = origin_of(base)?;
    if let Some(rest) = href.strip_prefix("//") {
        let scheme = base.split("://").next()?;
        return Some(format!("{scheme}://{rest}"));
    }
    if let Some(rest) = href.strip_prefix('/') {
        return Some(format!("{origin}/{rest}"));
    }
    // 相对路径：按一级目录拼（足够覆盖 favicon / og:image 的常见写法）
    Some(format!("{origin}/{href}"))
}

static META_RE: OnceLock<regex::Regex> = OnceLock::new();

fn meta_re() -> &'static regex::Regex {
    META_RE.get_or_init(|| regex::Regex::new(r"(?is)<meta\s[^>]*>").unwrap())
}

fn collect_meta(html: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for m in meta_re().find_iter(html) {
        let tag = m.as_str();
        let key = attr(tag, "property")
            .or_else(|| attr(tag, "name"))
            .or_else(|| attr(tag, "itemprop"));
        if let (Some(k), Some(v)) = (key, attr(tag, "content")) {
            out.push((k.trim().to_ascii_lowercase(), unescape_html(&v)));
        }
    }
    out
}

/// 从单个标签里取属性值，兼容单双引号与无引号三种写法。
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let bytes = tag.as_bytes();
    let mut from = 0usize;
    while let Some(pos) = lower[from..].find(name) {
        let start = from + pos;
        let prev_ok = start == 0 || bytes[start - 1].is_ascii_whitespace();
        if !prev_ok {
            from = start + name.len();
            continue;
        }
        let mut i = start + name.len();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            from = start + name.len();
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        let quote = bytes[i];
        if quote == b'"' || quote == b'\'' {
            let end = tag[i + 1..].find(quote as char)? + i + 1;
            return Some(tag[i + 1..end].to_string());
        }
        let end = tag[i..]
            .find(|c: char| c.is_whitespace() || c == '>')
            .map(|p| p + i)
            .unwrap_or(tag.len());
        return Some(tag[i..end].to_string());
    }
    None
}

static TITLE_RE: OnceLock<regex::Regex> = OnceLock::new();

fn extract_title_tag(html: &str) -> Option<String> {
    let re = TITLE_RE.get_or_init(|| regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());
    let raw = re.captures(html)?.get(1)?.as_str();
    let text = clean_text(&unescape_html(raw));
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

static LINK_RE: OnceLock<regex::Regex> = OnceLock::new();

fn extract_icon(html: &str) -> Option<String> {
    let re = LINK_RE.get_or_init(|| regex::Regex::new(r"(?is)<link\s[^>]*>").unwrap());
    let mut fallback: Option<String> = None;
    for m in re.find_iter(html) {
        let tag = m.as_str();
        let rel = attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel.contains("icon") {
            continue;
        }
        let Some(href) = attr(tag, "href") else {
            continue;
        };
        if rel.contains("apple-touch-icon") {
            // 尺寸大、通常是 PNG，只作为候选
            if fallback.is_none() {
                fallback = Some(href);
            }
            continue;
        }
        return Some(href);
    }
    fallback
}

/// 折叠空白并去掉首尾空格
fn clean_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 解码标题/描述里常见的 HTML 实体（OG 数据里 &amp; 之类很常见）
fn unescape_html(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '&' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let Some(semi) = chars[i..].iter().position(|&c| c == ';').map(|p| p + i) else {
            out.push(chars[i]);
            i += 1;
            continue;
        };
        if semi - i > 10 {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let entity: String = chars[i + 1..semi].iter().collect();
        let decoded = match entity.as_str() {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ => {
                let code = if let Some(hex) = entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    entity.strip_prefix('#').and_then(|d| d.parse::<u32>().ok())
                };
                code.and_then(char::from_u32)
            }
        };
        match decoded {
            Some(c) => {
                out.push(c);
                i = semi + 1;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<html><head>
        <meta name="viewport" content="width=device-width">
        <meta property="og:site_name" content="Winc" />
        <meta content="Winc: Lighter, Faster, Better to Edit In" property="og:title">
        <meta property="og:description" content='A desktop editor &amp; more'>
        <meta property="og:image" content="/assets/cover.png">
        <link rel="icon" href="https://winc.si/favicon.ico">
        <title>fallback title</title>
    </head><body></body></html>"#;

    #[test]
    fn parses_open_graph() {
        let metas = collect_meta(SAMPLE);
        let get = |k: &str| metas.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("og:site_name").as_deref(), Some("Winc"));
        assert_eq!(
            get("og:title").as_deref(),
            Some("Winc: Lighter, Faster, Better to Edit In")
        );
        // 实体解码
        assert_eq!(
            get("og:description").as_deref(),
            Some("A desktop editor & more")
        );
        assert_eq!(
            extract_icon(SAMPLE).as_deref(),
            Some("https://winc.si/favicon.ico")
        );
        assert_eq!(extract_title_tag(SAMPLE).as_deref(), Some("fallback title"));
        assert_eq!(
            absolutize("https://winc.si/a/b", "/assets/cover.png").as_deref(),
            Some("https://winc.si/assets/cover.png")
        );
    }

    #[test]
    fn rejects_private_and_non_http() {
        assert!(validate_url("file:///C:/x").is_err());
        assert!(validate_url("http://127.0.0.1:8080/x").is_err());
        assert!(validate_url("http://192.0.2.1/").is_err());
        assert!(validate_url("http://localhost/").is_err());
        assert!(validate_url("https://example.com/x").is_ok());
    }

    #[test]
    fn worker_alias_is_not_an_attribute() {
        // attr 必须只匹配前面是空白的属性名，避免 item 命中 itemprop 之外的子串
        assert_eq!(attr(r#"<meta itemprop="a" content="b">"#, "item"), None);
        assert_eq!(
            attr(r#"<meta itemprop="a" content="b">"#, "itemprop").as_deref(),
            Some("a")
        );
    }

    #[test]
    fn rejects_loose_internal_hosts() {
        // inet_aton 各种写法 + IPv6 私有段
        for host in [
            "127.1",
            "2130706433",
            "0x7f000001",
            "0177.0.0.1",
            "[::1]",
            "[::ffff:127.0.0.1]",
            "[fc00::1]",
            "[fe80::1]",
            "100.64.0.1",
            "169.254.1.1",
        ] {
            assert!(is_private_ip(host), "应判定为内网: {host}");
        }
        for host in ["example.com", "8.8.8.8", "1.1.1.1", "github.com"] {
            assert!(!is_private_ip(host), "不应判定为内网: {host}");
        }
    }

    #[test]
    fn decodes_charset() {
        // GBK 的「中文」：D6 D0 CE C4
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        assert_eq!(decode_html(&gbk, Some("text/html; charset=gbk")), "中文");
        assert_eq!(decode_html("中文".as_bytes(), None), "中文");
    }

    #[tokio::test]
    #[ignore = "需要网络"]
    async fn fetch_real_page() {
        let url = std::env::var("LINK_PREVIEW_URL").unwrap_or_else(|_| "https://winc.si".into());
        let p = fetch_link_preview(url).await.unwrap();
        println!("{p:#?}");
        assert!(!p.title.is_empty());
        assert!(!p.site_name.is_empty());
    }
}
