//! 版本清单拉取（图床上托管的 latest.json）。
//!
//! `db_check_updates` / `db_get_version` 已改为服务端 RPC，本文件只保留纯 HTTP 拉取。

use crate::db::ApiResponse;

/// 通过 Rust reqwest 拉取版本清单（绕过 WebView 对图床文件 30 天强缓存的缓存）
#[tauri::command(rename_all = "snake_case")]
pub async fn db_fetch_latest(url: String) -> Result<ApiResponse, String> {
    // 版本清单在图床上：按当前生效线路改写 host（加速/原始）
    let url = crate::db::cdn::rewrite_url(&url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let version = data
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let update_url = data
        .get("update_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(ApiResponse::ok_val(
        serde_json::json!({ "version": version, "update_url": update_url }),
        "OK",
    ))
}
