// GitHub Releases 更新源：查询 latest release 并解析 exe 安装包直链。
//
// 背景：默认更新源依赖图床 latest.json，图床故障时无法更新。
// 本模块通过 GitHub 公开 API `repos/{owner}/{repo}/releases/latest`
// 拉取最新发布（无需 Token，公开仓库匿名可读），从 assets 中挑选
// NSIS 安装包（*.exe），返回版本号与 browser_download_url 直链。
//
// 代理：完全交给 reqwest 默认行为（system-proxy 特性默认启用，自动检测
// Windows 系统代理与环境变量），无需额外处理——用户开启系统代理即生效。
use crate::db::ApiResponse;

/// 构建 HTTP 客户端（安装包下载与 API 查询共用同一策略）。
/// UA 使用官方推荐格式 AppName/version (contact)：GitHub API 强制要求有效 UA，
/// 真实标识比伪装浏览器更规范，且不影响匿名限流配额（60次/小时/IP）。
/// 代理遵循 reqwest 默认系统代理检测，不做额外干预。
pub(crate) fn build_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .user_agent(concat!(
            "sfmmm/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/b9348/sfmmm)"
        ))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))
}

/// 从 release assets 中挑选安装包资产：
/// 优先含 "setup" 的 .exe（NSIS 安装包），其次任意 .exe，最后回退第一个资产。
fn pick_installer_asset(assets: &[serde_json::Value]) -> Option<(String, String, u64)> {
    let mut fallback_exe: Option<(String, String, u64)> = None;
    for a in assets {
        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let url = a.get("browser_download_url").and_then(|v| v.as_str()).unwrap_or("");
        let size = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        if name.is_empty() || url.is_empty() {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".exe") {
            if lower.contains("setup") || lower.contains("installer") {
                return Some((name.to_string(), url.to_string(), size));
            }
            if fallback_exe.is_none() {
                fallback_exe = Some((name.to_string(), url.to_string(), size));
            }
        }
    }
    fallback_exe
}

/// 查询 GitHub 仓库 latest release，返回版本号与 exe 安装包直链。
/// 图床更新源不可用时，前端可切换到本更新源继续更新。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_gh_latest_release(
    owner: String,
    repo: String,
) -> Result<ApiResponse, String> {
    let api_url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let client = build_client(30)?;
    let resp = client
        .get(&api_url)
        .header("Accept", "application/vnd.github+json")
        // GitHub REST API 官方版本标识（https://docs.github.com/rest/overview/versions），
        // 2022-11-28 为当前稳定版本，非自定义日期
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("请求 GitHub API 失败: {e}"))?;

    let status = resp.status().as_u16();
    if status == 404 {
        return Err("GitHub 仓库没有已发布的 Release，请先在 Actions 中完成一次发布".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub API 返回 HTTP {status}"));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("解析 GitHub API 响应失败: {e}"))?;

    let tag_name = data.get("tag_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let published_at = data.get("published_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let assets = data.get("assets").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let version = tag_name.trim_start_matches('v').to_string();
    let (asset_name, update_url, size) = pick_installer_asset(&assets)
        .ok_or_else(|| "GitHub Release 中未找到安装包资产（*.exe），请检查发布产物".to_string())?;

    Ok(ApiResponse::ok_val(
        serde_json::json!({
            "version": version,
            "tag_name": tag_name,
            "update_url": update_url,
            "asset_name": asset_name,
            "size": size,
            "published_at": published_at,
        }),
        "OK",
    ))
}
