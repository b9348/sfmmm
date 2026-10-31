use mysql::prelude::*;
use mysql::*;

use crate::db::{with_conn, ApiResponse, DbState};

#[tauri::command(rename_all = "snake_case")]
pub async fn db_like_mod(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    device_id: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        if device_id.is_empty() {
            return Ok(ApiResponse::err("Device ID is required"));
        }
        crate::db::ensure_mod_updated_at_semantics(conn)?;
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mod_likes WHERE mod_id = ? AND device_id = ?",
            (mod_id, &device_id),
        ).map_err(|e| e.to_string())?;
        if exists.is_some() {
            return Ok(ApiResponse::err("Already liked"));
        }
        conn.exec_drop(
            "INSERT INTO mod_likes (mod_id, device_id) VALUES (?, ?)",
            (mod_id, &device_id),
        ).map_err(|e| e.to_string())?;
        conn.exec_drop(
            "UPDATE mods SET like_count = like_count + 1 WHERE id = ?",
            (mod_id,),
        ).map_err(|e| e.to_string())?;

        let new_count: i64 = conn.exec_first(
            "SELECT like_count FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0);
        Ok(ApiResponse::ok_val(serde_json::json!({ "like_count": new_count, "is_liked": true }), "Liked"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_unlike_mod(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    device_id: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        if device_id.is_empty() {
            return Ok(ApiResponse::err("Device ID is required"));
        }
        crate::db::ensure_mod_updated_at_semantics(conn)?;
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mod_likes WHERE mod_id = ? AND device_id = ?",
            (mod_id, &device_id),
        ).map_err(|e| e.to_string())?;
        if exists.is_none() {
            return Ok(ApiResponse::err("Not liked yet"));
        }
        conn.exec_drop(
            "DELETE FROM mod_likes WHERE mod_id = ? AND device_id = ?",
            (mod_id, &device_id),
        ).map_err(|e| e.to_string())?;
        conn.exec_drop(
            "UPDATE mods SET like_count = GREATEST(like_count - 1, 0) WHERE id = ?",
            (mod_id,),
        ).map_err(|e| e.to_string())?;
        let new_count: i64 = conn.exec_first(
            "SELECT like_count FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0);
        Ok(ApiResponse::ok_val(serde_json::json!({ "like_count": new_count, "is_liked": false }), "Unliked"))
    }).await
}
