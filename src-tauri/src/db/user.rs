use mysql::prelude::*;
use mysql::*;

use crate::db::{hash_password, val_to_i64, val_to_string, with_conn, ApiResponse, DbState};

#[tauri::command(rename_all = "snake_case")]
pub async fn db_login(
    state: tauri::State<'_, DbState>,
    username: String,
    password: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let pwd_hash = hash_password(&password);

        let row: Option<(u64, String, bool, Option<String>)> = conn.exec_first(
            "SELECT id, username, r2_enabled, avatar FROM users WHERE username = ? AND password_hash = ?",
            (&username, &pwd_hash),
        ).map_err(|e| e.to_string())?;

        match row {
            Some((id, uname, r2_enabled, avatar)) => Ok(ApiResponse::ok_val(serde_json::json!({
                "user_id": id, "username": uname, "r2_enabled": r2_enabled, "avatar": avatar
            }), "Login successful")),
            None => Ok(ApiResponse::err("Invalid username or password")),
        }
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_register(
    state: tauri::State<'_, DbState>,
    username: String,
    password: String,
    avatar: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let uname = username.trim().to_string();
        if uname.len() < 2 || uname.len() > 32 {
            return Ok(ApiResponse::err("Username must be between 2 and 32 characters"));
        }
        if password.len() < 4 {
            return Ok(ApiResponse::err("Password must be at least 4 characters"));
        }

        let pwd_hash = hash_password(&password);

        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM users WHERE username = ?", (&uname,)
        ).map_err(|e| e.to_string())?;

        if exists.is_some() {
            return Ok(ApiResponse::err("Username already exists"));
        }

        conn.exec_drop(
            "INSERT INTO users (username, password_hash, avatar) VALUES (?, ?, ?)",
            (&uname, &pwd_hash, &avatar),
        ).map_err(|e| e.to_string())?;

        let new_id: u64 = conn.last_insert_id();
        Ok(ApiResponse::ok_val(serde_json::json!({
            "user_id": new_id, "username": uname, "r2_enabled": false, "avatar": avatar
        }), "Registration successful"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_update_profile(
    state: tauri::State<'_, DbState>,
    user_id: u64,
    username: Option<String>,
    avatar: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        if let Some(ref new_name) = username {
            let uname = new_name.trim().to_string();
            if uname.len() < 2 || uname.len() > 32 {
                return Ok(ApiResponse::err("用户名长度必须在 2-32 个字符之间"));
            }
            let exists: Option<(u64,)> = conn.exec_first(
                "SELECT id FROM users WHERE username = ? AND id != ?", (&uname, user_id)
            ).map_err(|e| e.to_string())?;
            if exists.is_some() {
                return Ok(ApiResponse::err("用户名已被使用"));
            }
            conn.exec_drop(
                "UPDATE users SET username = ? WHERE id = ?",
                (&uname, user_id),
            ).map_err(|e| e.to_string())?;
        }

        if let Some(ref av) = avatar {
            let clean_avatar = if av.is_empty() || av.trim().is_empty() {
                None
            } else {
                Some(av.trim().to_string())
            };
            conn.exec_drop(
                "UPDATE users SET avatar = ? WHERE id = ?",
                (clean_avatar, user_id),
            ).map_err(|e| e.to_string())?;
        }

        let row: Option<(u64, String, bool, Option<String>)> = conn.exec_first(
            "SELECT id, username, r2_enabled, avatar FROM users WHERE id = ?", (user_id,)
        ).map_err(|e| e.to_string())?;

        match row {
            Some((id, uname, r2_enabled, av)) => Ok(ApiResponse::ok_val(serde_json::json!({
                "user_id": id, "username": uname, "r2_enabled": r2_enabled, "avatar": av
            }), "Profile updated")),
            None => Ok(ApiResponse::err("User not found")),
        }
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_user_public_profile(
    state: tauri::State<'_, DbState>,
    user_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let row: Option<Row> = conn.exec_first(
            "SELECT id, username, avatar FROM users WHERE id = ?",
            (user_id,),
        ).map_err(|e| e.to_string())?;

        match row {
            Some(row_data) => {
                let vals: Vec<Value> = row_data.unwrap();

                let stat_row: Option<(i64, Option<i64>)> = conn.exec_first(
                    "SELECT COUNT(*), SUM(download_count) FROM mods WHERE author_id = ?",
                    (user_id,),
                ).map_err(|e| e.to_string())?;
                let (mod_count, total_downloads) = match stat_row {
                    Some((cnt, Some(dl))) => (cnt, dl),
                    Some((cnt, None)) => (cnt, 0),
                    None => (0, 0),
                };

                let total_likes: i64 = conn.exec_first(
                    "SELECT COUNT(*) FROM mod_likes WHERE mod_id IN (SELECT id FROM mods WHERE author_id = ?)",
                    (user_id,),
                ).map_err(|e| e.to_string())?.unwrap_or(0i64);

                Ok(ApiResponse::ok_val(serde_json::json!({
                    "user": {
                        "user_id": val_to_i64(&vals[0]),
                        "username": val_to_string(vals[1].clone()),
                        "avatar": val_to_string(vals[2].clone()),
                        "mod_count": mod_count,
                        "total_downloads": total_downloads,
                        "total_likes": total_likes,
                    }
                }), "OK"))
            }
            None => Ok(ApiResponse::err("User not found")),
        }
    }).await
}
