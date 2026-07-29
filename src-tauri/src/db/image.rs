use crate::db::ApiResponse;

fn imgbed_url() -> String {
    option_env!("IMGBED_URL")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("IMGBED_URL").ok())
        .expect("IMGBED_URL 未设置：请在 src-tauri/.env 中配置图床地址，然后重新构建")
}

fn imgbed_token() -> String {
    option_env!("IMGBED_TOKEN")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("IMGBED_TOKEN").ok())
        .expect("IMGBED_TOKEN 未设置：请在 src-tauri/.env 中配置图床 Token，然后重新构建")
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_imgbed_config() -> Result<ApiResponse, String> {
    Ok(ApiResponse::ok_val(serde_json::json!({
        "url": imgbed_url(),
        "token": imgbed_token(),
    }), "OK"))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_imgbed_file(file_url: String) -> Result<ApiResponse, String> {
    let config = db_get_imgbed_config().await?.data
        .ok_or("imgbed config missing")?;
    let url = config["url"].as_str().ok_or("imgbed url missing")?;
    let token = config["token"].as_str().ok_or("imgbed token missing")?;

    let path = reqwest::Url::parse(&file_url)
        .map_err(|e| e.to_string())?
        .path()
        .trim_start_matches('/')
        .to_string();

    if path.is_empty() {
        return Ok(ApiResponse::err("Invalid file_url"));
    }

    let base = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    let delete_url = base
        .join(&format!("api/manage/delete/{}", path))
        .map_err(|e| e.to_string())?;

    let client = reqwest::Client::new();
    let res = client
        .get(delete_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();

    let body_ok = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
        .unwrap_or(status.is_success());

    if body_ok {
        Ok(ApiResponse::ok_msg("ImgBed file deleted"))
    } else {
        let err_msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| format!("HTTP {} - {}", status, text));
        Ok(ApiResponse::err(&format!("ImgBed delete failed: {}", err_msg)))
    }
}
