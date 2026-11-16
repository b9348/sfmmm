//! 图床资源多线路：主域名（IMGBED_URL）+ 线路2（IMGBED_MIRROR_URL）+ 线路3（IMGBED_LINE3_URL），
//! 三条线路指向同一个 R2 桶，仅域名不同。
//!
//! 数据库与前端展示里的 URL 一律保持原始域名（不迁移存量数据），
//! 在消费点（下载/上传/删除/前端图片渲染）运行时改写 host。
//! 启动时后台测速决定 auto 模式的走向；用户可在设置页手动强制某条线路。

use serde::Serialize;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

/// 线路身份：Primary = 主域名，Line2/Line3 = 备用域名（同一桶的其它自定义域）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Line {
    Primary,
    Line2,
    Line3,
}

impl Line {
    fn as_str(self) -> &'static str {
        match self {
            Line::Primary => "primary",
            Line::Line2 => "line2",
            Line::Line3 => "line3",
        }
    }

    /// 该线路的基址；未配置返回 None
    fn url(self) -> Option<String> {
        let raw = match self {
            Line::Primary => option_env!("IMGBED_URL")
                .map(|s| s.to_string())
                .or_else(|| std::env::var("IMGBED_URL").ok()),
            Line::Line2 => option_env!("IMGBED_MIRROR_URL")
                .map(|s| s.to_string())
                .or_else(|| std::env::var("IMGBED_MIRROR_URL").ok()),
            Line::Line3 => option_env!("IMGBED_LINE3_URL")
                .map(|s| s.to_string())
                .or_else(|| std::env::var("IMGBED_LINE3_URL").ok()),
        }?;
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }

    fn host(self) -> Option<String> {
        self.url().as_deref().and_then(host_of)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CdnMode {
    /// 测速更快者（默认）
    Auto,
    /// 强制线路 2
    Line2,
    /// 强制线路 3
    Line3,
    /// 强制主域名
    Primary,
}

impl CdnMode {
    fn as_str(self) -> &'static str {
        match self {
            CdnMode::Auto => "auto",
            CdnMode::Line2 => "line2",
            CdnMode::Line3 => "line3",
            CdnMode::Primary => "primary",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(CdnMode::Auto),
            // 旧版本配置里存的是 "mirror"，等价于线路 2
            "mirror" | "line2" => Some(CdnMode::Line2),
            "line3" => Some(CdnMode::Line3),
            "primary" => Some(CdnMode::Primary),
            _ => None,
        }
    }
}

struct CdnState {
    mode: RwLock<CdnMode>,
    /// 当前生效线路
    active: RwLock<Line>,
    /// 测速结论：最快的已配置线路（与 mode 无关，供 Auto 模式引用）
    probe_best: RwLock<Option<Line>>,
}

static CDN: OnceLock<CdnState> = OnceLock::new();

/// 测速完成信号：cdn_status 命令等待它，保证前端启动初期拿到的是测速后的结论
/// 而不是测速前的默认值（图片首屏渲染早于测速完成会被主域名截住）。
static PROBE_DONE: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

fn state() -> &'static CdnState {
    CDN.get_or_init(|| CdnState {
        mode: RwLock::new(CdnMode::Auto),
        active: RwLock::new(Line::Primary),
        probe_best: RwLock::new(None),
    })
}

fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url).ok()?.host_str().map(|s| s.to_string())
}

pub fn primary_host() -> Option<String> {
    Line::Primary.host()
}

pub fn line2_host() -> Option<String> {
    Line::Line2.host()
}

pub fn line3_host() -> Option<String> {
    Line::Line3.host()
}

fn active() -> Line {
    state().active.read().ok().map(|g| *g).unwrap_or(Line::Primary)
}

fn set_active(line: Line) {
    if let Ok(mut a) = state().active.write() {
        *a = line;
    }
}

pub fn current_mode() -> CdnMode {
    state()
        .mode
        .read()
        .map(|g| *g)
        .unwrap_or(CdnMode::Auto)
}

/// 手动切换线路模式；目标线路未配置时返回 Err（前端回滚 UI）。
pub fn set_mode(mode: CdnMode) -> Result<(), String> {
    if let Ok(mut m) = state().mode.write() {
        *m = mode;
    }
    let line = match mode {
        CdnMode::Auto => probe_best().unwrap_or_else(|| {
            // 未测速（启动早期）：回到有配置的默认线路
            if Line::Line2.url().is_some() {
                Line::Line2
            } else {
                Line::Primary
            }
        }),
        CdnMode::Line2 => {
            if Line::Line2.url().is_none() {
                return Err("未配置线路 2（IMGBED_MIRROR_URL）".into());
            }
            Line::Line2
        }
        CdnMode::Line3 => {
            if Line::Line3.url().is_none() {
                return Err("未配置线路 3（IMGBED_LINE3_URL）".into());
            }
            Line::Line3
        }
        CdnMode::Primary => Line::Primary,
    };
    set_active(line);
    log::info!(
        "[CDN] 线路模式切换为 {}，生效域名: {}",
        mode.as_str(),
        line.host().unwrap_or_default()
    );
    Ok(())
}

fn probe_best() -> Option<Line> {
    state().probe_best.read().ok().and_then(|g| *g)
}

/// 启动测速：HEAD 各线路的 latest.json（小文件且必存在），3 秒超时各 1 轮，
/// 最快者（仅统计成功者）胜出。仅有一条线路时无需测速。
pub async fn probe() {
    let mut candidates: Vec<Line> = [Line::Primary, Line::Line2, Line::Line3]
        .into_iter()
        .filter(|l| l.url().is_some())
        .collect();
    if candidates.len() <= 1 {
        // 单线路：测速无意义，直接放行等待者
        if let Some(only) = candidates.first().copied() {
            set_active(only);
        }
        PROBE_DONE.set(()).ok();
        return;
    }
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[CDN] 测速客户端创建失败: {e}");
            // 必须放行等待者：否则 cdn_status 每次都要空等满 5 秒超时
            PROBE_DONE.set(()).ok();
            return;
        }
    };

    async fn timed_head(client: &reqwest::Client, url: String) -> Option<Duration> {
        let start = Instant::now();
        let ok = client
            .head(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        ok.then_some(start.elapsed())
    }

    let mut timings: Vec<(Line, Option<Duration>)> = Vec::new();
    for line in candidates.drain(..) {
        let url = format!(
            "{}{}",
            line.url().unwrap_or_default().trim_end_matches('/'),
            "/file/sfm/installer/latest.json"
        );
        let t = timed_head(&client, url).await;
        timings.push((line, t));
    }

    let best = timings
        .iter()
        .filter_map(|(line, t)| t.map(|d| (*line, d)))
        .min_by_key(|(_, d)| *d)
        .map(|(line, _)| line);

    log::info!(
        "[CDN] 测速结果: {:?} → {}",
        timings
            .iter()
            .map(|(l, t)| (l.as_str(), t.map(|d| d.as_millis())))
            .collect::<Vec<_>>(),
        match best {
            Some(l) => format!("启用 {}", l.as_str()),
            None => "全部失败，保持主域名".to_string(),
        }
    );

    if let Ok(mut b) = state().probe_best.write() {
        *b = best;
    }

    if current_mode() != CdnMode::Auto {
        PROBE_DONE.set(()).ok();
        return; // 用户手动选了线路，测速结果仅供参考
    }
    // Auto：有成功者就用最快者，全失败保持主域名
    set_active(best.unwrap_or(Line::Primary));
    PROBE_DONE.set(()).ok();
}

/// 通用改写：仅当 URL 是主域名且当前生效为备用线路时替换 host，其余原样返回。
pub fn rewrite_url(url: &str) -> String {
    let active = active();
    if active == Line::Primary {
        return url.to_string();
    }
    let (Some(active_host), Some(primary_host)) = (active.host(), primary_host()) else {
        return url.to_string();
    };
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    if parsed.host_str() != Some(primary_host.as_str()) {
        return url.to_string();
    }
    if parsed.set_host(Some(&active_host)).is_err() {
        return url.to_string();
    }
    parsed.to_string()
}

/// 下载失败回退用：无论当前状态，强制改回主域名（非备用域名的 URL 原样返回）。
pub fn mirror_fallback(url: &str) -> String {
    to_primary(url)
}

/// 上传响应归一化：服务器按请求 host 返回 publicUrl 时统一改回主域名，
/// 保证落库 URL 与存量数据一致（imgbed_file_id_if_ours 的 host 校验依赖这一点）。
pub fn normalize_to_primary(url: &str) -> String {
    to_primary(url)
}

fn to_primary(url: &str) -> String {
    let Some(primary_host) = primary_host() else {
        return url.to_string();
    };
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };
    let is_alt = [Line::Line2, Line::Line3]
        .iter()
        .filter_map(|l| l.host())
        .any(|h| parsed.host_str() == Some(h.as_str()));
    if !is_alt {
        return url.to_string();
    }
    let _ = parsed.set_host(Some(&primary_host));
    parsed.to_string()
}

// ── Tauri 命令 ────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdnStatus {
    pub mode: String,
    pub primary_host: String,
    pub line2_host: Option<String>,
    pub line3_host: Option<String>,
    /// 当前生效线路："primary" | "line2" | "line3"
    pub active: String,
    pub active_host: String,
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cdn_status() -> CdnStatus {
    // 等启动测速收敛（有 5s 超时兜底，正常秒回）；前端据此改写图片域名
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while PROBE_DONE.get().is_none() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    let active = active();
    CdnStatus {
        mode: current_mode().as_str().to_string(),
        primary_host: primary_host().unwrap_or_default(),
        line2_host: line2_host(),
        line3_host: line3_host(),
        active: active.as_str().to_string(),
        active_host: active.host().unwrap_or_default(),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn cdn_set_mode(mode: String) -> Result<(), String> {
    let m = CdnMode::from_str(&mode).ok_or_else(|| format!("无效线路模式: {mode}"))?;
    set_mode(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parse_includes_legacy_mirror() {
        assert_eq!(CdnMode::from_str("mirror"), Some(CdnMode::Line2));
        assert_eq!(CdnMode::from_str("line3"), Some(CdnMode::Line3));
        assert_eq!(CdnMode::from_str("bogus"), None);
    }

    #[test]
    fn rewrite_ignores_foreign_and_unconfigured() {
        // 环境未配置备用线路时（CI/干净克隆），rewrite 必须原样返回
        if Line::Line2.url().is_none() && Line::Line3.url().is_none() {
            let u = "https://example.com/file/sfm/a.zip";
            assert_eq!(rewrite_url(u), u);
        }
    }

    #[test]
    fn mode_roundtrip() {
        for s in ["auto", "line2", "line3", "primary"] {
            assert_eq!(CdnMode::from_str(s).map(|m| m.as_str()), Some(s));
        }
    }
}
