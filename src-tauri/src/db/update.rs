use mysql::prelude::*;
use mysql::*;

use crate::db::{semver_cmp, val_to_string, with_conn, ApiResponse, DbState};

#[tauri::command(rename_all = "snake_case")]
pub async fn db_check_updates(
    state: tauri::State<'_, DbState>,
    installed: Vec<serde_json::Value>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let mut results: Vec<serde_json::Value> = Vec::new();

        for item in &installed {
            let mod_key = item.get("mod_key").and_then(|v| v.as_str()).unwrap_or("");
            let installed_ver = item.get("installed_version").and_then(|v| v.as_str()).unwrap_or("0.0.0");
            let lang_code = item.get("lang_code").and_then(|v| v.as_str()).unwrap_or("zh");

            if mod_key.is_empty() { continue; }

            let row: Option<Row> = conn.exec_first(
                "SELECT t.version, t.name, f.file_hash
                 FROM mods m
                 LEFT JOIN mod_translations t ON t.mod_id = m.id AND t.lang_code = ?
                 LEFT JOIN mod_files f ON f.mod_id = m.id AND f.lang_code = ?
                 WHERE m.mod_id = ?
                 ORDER BY t.id DESC LIMIT 1",
                (lang_code, lang_code, mod_key),
            ).map_err(|e| e.to_string())?;

            let (latest_ver, display_name, latest_file_hash) = match row {
                Some(r) => {
                    let vals: Vec<Value> = r.unwrap();
                    (
                        val_to_string(vals[0].clone()),
                        val_to_string(vals[1].clone()),
                        val_to_string(vals[2].clone()),
                    )
                }
                None => (String::new(), String::new(), String::new()),
            };
            let has_update = !latest_ver.is_empty() && semver_cmp(&latest_ver, &installed_ver) > 0;

            results.push(serde_json::json!({
                "mod_key": mod_key,
                "installed_version": installed_ver,
                "latest_version": latest_ver,
                "display_name": display_name,
                "latest_file_hash": latest_file_hash,
                "has_update": has_update,
            }));
        }

        Ok(ApiResponse::ok_val(serde_json::json!({
            "updates": results,
        }), "OK"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_version(
    state: tauri::State<'_, DbState>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let config: Option<(String, String)> = conn.exec_first(
            "SELECT version, update_url FROM version_config ORDER BY id DESC LIMIT 1",
            (),
        ).map_err(|e| e.to_string())?;

        match config {
            Some((ver, url)) => Ok(ApiResponse::ok_val(serde_json::json!({
                "version": ver,
                "update_url": url,
            }), "OK")),
            None => Ok(ApiResponse::ok_val(serde_json::json!({
                "version": "0.1.0",
                "update_url": "",
            }), "OK")),
        }
    }).await
}
