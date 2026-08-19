// 蓝奏云分享链接解析：把分享页 URL 转换为可直接下载的文件直链。
//
// 蓝奏云分享页不是直链，需经过多层跳转与反爬挑战（移植自参考 Python 解析器）：
//   1. 移动端 UA 访问分享页；命中 acw_sc__v2 反爬挑战（var arg1='...'）时
//      按 ACW_M/ACW_P 常量计算 cookie，带 cookie 重试；
//   2. 从分享页 HTML 提取 webtp 跳转链接（<a href="...webtp=...">）；
//   3. 访问 webtp（同样可能触发反爬，复用同一套挑战处理）；
//   4. 从下载页 HTML 提取直链（vkjxld+hyggid 拼接 / window.location.href / <a>下载）；
//   5. 手动跟随 30x / meta-refresh 重定向，直到文件流响应，取最终直链。
//
// 注意：解析出的直链有时效性，解析成功后应立即下载；
//       文件名取分享页 <title>（通常即真实文件名，如 BepInEx6.7z），
//       用于推断压缩格式（.7z/.zip）供解压路由。

use once_cell::sync::Lazy;
use regex::Regex;

/// 移动端 UA：蓝奏云移动版页面结构更简单（分享页直接暴露 webtp 下载入口）
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 14; LE2110 Build/UKQ1.230924.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.7922.71 Mobile Safari/537.36";

// ── acw_sc__v2 反爬挑战（阿里云 WAF JS 混淆）常量，与参考实现保持一致 ──
const ACW_M: [usize; 40] = [
    0xF, 0x23, 0x1D, 0x18, 0x21, 0x10, 0x1, 0x26, 0xA, 0x9, 0x13, 0x1F, 0x28, 0x1B, 0x16, 0x17,
    0x19, 0xD, 0x6, 0xB, 0x27, 0x12, 0x14, 0x8, 0xE, 0x15, 0x20, 0x1A, 0x2, 0x1E, 0x7, 0x4,
    0x11, 0x5, 0x3, 0x1C, 0x22, 0x25, 0xC, 0x24,
];
const ACW_P: &str = "3000176000856006061501533003690027800375";

static RE_ARG1: Lazy<Regex> = Lazy::new(|| Regex::new(r"var arg1='([A-F0-9]+)'").unwrap());
static RE_WEBTP: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"<a[^>]+href="([^"]+webtp=[^"]+)""#).unwrap());
static RE_VKJXLD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"var vkjxld\s*=\s*'([^']+)'").unwrap());
static RE_HYGGID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"var hyggid\s*=\s*'([^']+)'").unwrap());
static RE_LOCATION_HREF: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"window\.location\.href\s*=\s*'([^']+)'").unwrap());
static RE_A_DOWNLOAD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"<a[^>]+href="(https?://[^"]+)"[^>]*>下载"#).unwrap());
static RE_META_URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"<meta[^>]+url=["']?([^"' ]+)"#).unwrap());
static RE_TITLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<title>(.+?)</title>").unwrap());

/// 判断是否为蓝奏云分享链接（lanzou 域名族：lanzou/lanzoui/lanzoum/lanzoux/lanzouy/lanzoub…）
pub fn is_lanzou_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .map(|h| h.split('.').any(|seg| seg.starts_with("lanzou")))
        .unwrap_or(false)
}

/// 蓝奏云请求共用浏览器请求头（与参考 Python 解析器 8.py 的 session headers 一致）。
/// 实测蓝奏云 CDN（developer2.lanrar.com 等）只带 UA 会返回 200 HTML 页而非
/// 302 文件流跳转，必须带 Accept/Accept-Language 等完整头才会给出真实直链。
fn apply_browser_headers(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    use reqwest::header::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        ),
    );
    headers.insert(
        reqwest::header::ACCEPT_LANGUAGE,
        HeaderValue::from_static("zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"),
    );
    headers.insert(
        reqwest::header::ACCEPT_ENCODING,
        HeaderValue::from_static("gzip, deflate"),
    );
    headers.insert(
        reqwest::header::UPGRADE_INSECURE_REQUESTS,
        HeaderValue::from_static("1"),
    );
    builder.default_headers(headers)
}

/// 蓝奏云解析专用 client：移动端 UA + 完整浏览器头 + 不自动跟随重定向
/// （30x / meta 刷新需手动逐层处理，以便在文件流响应处停下取最终直链）
fn build_lanzou_client() -> Result<reqwest::Client, String> {
    apply_browser_headers(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent(MOBILE_UA)
            .redirect(reqwest::redirect::Policy::none()),
    )
    .build()
    .map_err(|e| format!("构建蓝奏云解析客户端失败: {e}"))
}

/// 蓝奏云直链下载 client：移动端 UA + 完整浏览器头（与解析会话一致，避免 CDN 校验失败）
pub fn build_lanzou_download_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    apply_browser_headers(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .user_agent(MOBILE_UA),
    )
    .build()
    .map_err(|e| format!("构建蓝奏云下载客户端失败: {e}"))
}

/// 从文件名（如分享页 title "BepInEx6.7z"）推断压缩扩展名，仅识别 zip/7z
pub fn ext_from_name(name: &str) -> Option<String> {
    let lower = name.trim().to_lowercase();
    if lower.ends_with(".zip") {
        Some("zip".to_string())
    } else if lower.ends_with(".7z") {
        Some("7z".to_string())
    } else {
        None
    }
}

/// 计算 acw_sc__v2 反爬 cookie（置换 + 异或，与参考实现一致）：
/// q[j] = arg1[i]（其中 ACW_M[j] == i+1，ACW_M 为 1..=40 的置换），
/// 再把 q 与 ACW_P 按两位十六进制逐组异或得到 cookie 值。
fn anti_cookie(arg1: &str) -> Option<String> {
    let bytes = arg1.as_bytes();
    if bytes.len() < 40 {
        return None;
    }
    let mut q = [0u8; 40];
    for i in 0..40 {
        for j in 0..40 {
            if ACW_M[j] == i + 1 {
                q[j] = bytes[i];
            }
        }
    }
    let u = std::str::from_utf8(&q).ok()?;
    let mut v = String::with_capacity(40);
    for i in (0..40).step_by(2) {
        let uu = u8::from_str_radix(&u[i..i + 2], 16).ok()?;
        let pp = u8::from_str_radix(&ACW_P[i..i + 2], 16).ok()?;
        v.push_str(&format!("{:02x}", uu ^ pp));
    }
    Some(v)
}

/// 相对链接转绝对（与参考实现同语义：基于 base 的 scheme://host 拼接）
fn absolute_url(base: &str, location: &str) -> String {
    if location.starts_with("http://") || location.starts_with("https://") {
        return location.to_string();
    }
    match reqwest::Url::parse(base) {
        Ok(u) => format!(
            "{}://{}{}",
            u.scheme(),
            u.host_str().unwrap_or_default(),
            location
        ),
        Err(_) => location.to_string(),
    }
}

/// 携带反爬 cookie 发起 GET
async fn send_get(
    client: &reqwest::Client,
    url: &str,
    cookie: &Option<String>,
) -> Result<reqwest::Response, String> {
    let mut req = client.get(url);
    if let Some(c) = cookie.as_deref() {
        req = req.header(reqwest::header::COOKIE, format!("acw_sc__v2={c}"));
    }
    req.send()
        .await
        .map_err(|e| format!("请求蓝奏云失败: {e}"))
}

/// GET 页面 HTML：手动跟随 30x（最多 5 层）；命中 acw_sc__v2 反爬挑战时
/// 计算 cookie 并重试一次。cookie 计算后存入参数，供后续同域请求复用。
async fn get_html(
    client: &reqwest::Client,
    url: &str,
    cookie: &mut Option<String>,
) -> Result<String, String> {
    let mut current = url.to_string();
    let mut challenge_solved = false;
    for _ in 0..6 {
        let resp = send_get(client, &current, cookie).await?;
        // 30x：手动跟随 Location
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "重定向缺少 Location".to_string())?;
            current = absolute_url(&current, loc);
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("页面返回 HTTP {}", resp.status()));
        }
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取页面失败: {e}"))?;
        // 反爬挑战：计算 cookie 后重试当前 URL（每次调用只处理一次，避免死循环）
        if !challenge_solved && (text.contains("var arg1=") || text.contains("acw_sc__v2")) {
            if let Some(v) = RE_ARG1
                .captures(&text)
                .and_then(|c| anti_cookie(&c[1]))
            {
                *cookie = Some(v);
                challenge_solved = true;
                continue;
            }
        }
        return Ok(text);
    }
    Err("蓝奏云页面跳转层数过多".into())
}

/// 从 HTML 提取下载直链（与参考实现的三种方式一致）：
/// 1) vkjxld + hyggid 拼接；2) window.location.href；3) <a>下载 链接
fn extract_download_from_html(html: &str) -> Option<String> {
    if let (Some(v), Some(h)) = (RE_VKJXLD.captures(html), RE_HYGGID.captures(html)) {
        return Some(format!("{}{}", &v[1], &h[1]));
    }
    if let Some(m) = RE_LOCATION_HREF.captures(html) {
        return Some(m[1].to_string());
    }
    if let Some(m) = RE_A_DOWNLOAD.captures(html) {
        return Some(m[1].to_string());
    }
    None
}

/// 从下载入口 URL 跟随 30x / meta 刷新，直到文件流响应，返回最终直链。
/// 与参考实现的 _follow_redirects 语义一致（最多 5 层）：
///   - 30x → 跟随 Location；
///   - 200 且 octet-stream / attachment → 当前 URL 即最终直链；
///   - 200 且 HTML → meta 刷新继续跟，页面内直链则作为新入口继续。
async fn follow_to_direct(
    client: &reqwest::Client,
    url: &str,
    cookie: &mut Option<String>,
) -> Result<String, String> {
    let mut current = url.to_string();
    for _ in 0..5 {
        let resp = send_get(client, &current, cookie).await?;

        // 30x：跟随 Location
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "重定向缺少 Location".to_string())?;
            current = absolute_url(&current, loc);
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("下载入口返回 HTTP {}", resp.status()));
        }

        // 文件流响应：当前 URL 即最终直链（不消费 body，连接自动中止）
        let ct = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_lowercase();
        let cd = resp
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_lowercase();
        if ct.contains("octet-stream") || cd.contains("attachment") {
            return Ok(current);
        }

        // HTML：meta 刷新继续跟；页面内直链则作为新入口继续
        if ct.contains("text/html") {
            let text = resp
                .text()
                .await
                .map_err(|e| format!("读取跳转页失败: {e}"))?;
            if let Some(m) = RE_META_URL.captures(&text) {
                current = absolute_url(&current, &m[1]);
                continue;
            }
            if let Some(link) = extract_download_from_html(&text) {
                current = absolute_url(&current, &link);
                continue;
            }
        }
        // 其他（非 HTML 非文件流的 200）：视为最终直链
        return Ok(current);
    }
    Err("蓝奏云下载跳转层数过多".into())
}

/// 解析蓝奏云分享链接 → (文件直链, 文件名)。直链有时效性，解析后需立即下载。
pub async fn resolve(share_url: &str) -> Result<(String, String), String> {
    let client = build_lanzou_client()?;
    let mut cookie: Option<String> = None;

    // 1) 访问分享页（处理反爬挑战）
    let html1 = get_html(&client, share_url, &mut cookie).await?;

    // 2) 提取 webtp 跳转链接
    let webtp = RE_WEBTP
        .captures(&html1)
        .map(|c| c[1].to_string())
        .ok_or_else(|| "分享页未找到下载入口(webtp)".to_string())?;
    let webtp_url = absolute_url(share_url, &webtp);

    // 3) 访问 webtp（可能再次触发反爬）
    let html2 = get_html(&client, &webtp_url, &mut cookie).await?;

    // 4) 提取直链（下载页优先，回退分享页）
    let download_url = extract_download_from_html(&html2)
        .or_else(|| extract_download_from_html(&html1))
        .ok_or_else(|| "未从下载页提取到直链".to_string())?;

    // 5) 跟随 30x / meta 刷新，直到文件流响应取最终直链
    let final_url = follow_to_direct(&client, &download_url, &mut cookie).await?;

    // 6) 文件名取分享页 <title>（通常即真实文件名，如 BepInEx6.7z）
    let name = RE_TITLE
        .captures(&html1)
        .map(|c| c[1].trim().to_string())
        .unwrap_or_default();

    Ok((final_url, name))
}
