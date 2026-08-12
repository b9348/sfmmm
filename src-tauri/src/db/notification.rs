use mysql::prelude::*;
use mysql::*;

use crate::db::{decrypt_str, val_to_i64, val_to_string, with_conn, ApiResponse, DbState};

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_unread_count(
    state: tauri::State<'_, DbState>,
    user_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let pending_apps: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM edit_applications a JOIN mods m ON a.mod_id = m.id WHERE m.author_id = ? AND a.status = 'pending' AND a.is_read = 0",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let unread_notifs: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_notifications WHERE user_id = ? AND is_read = 0",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        Ok(ApiResponse::ok_val(serde_json::json!({
            "applications": pending_apps,
            "notifications": unread_notifs,
            "total": pending_apps + unread_notifs,
        }), "OK"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_my_notifications(
    state: tauri::State<'_, DbState>,
    user_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).min(100);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_notifications WHERE user_id = ?",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let mut rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(
            "SELECT n.id, n.mod_id, m.mod_id as mod_key, n.type, n.comment_id, n.is_read, n.created_at,
                    c.content as comment_content, u.username as comment_author, u.avatar as comment_author_avatar, c.author_id
             FROM mod_notifications n
             JOIN mods m ON n.mod_id = m.id
             LEFT JOIN mod_comments c ON n.comment_id = c.id
             LEFT JOIN users u ON c.author_id = u.id
             WHERE n.user_id = ?
             ORDER BY n.created_at DESC
             LIMIT ? OFFSET ?",
            (user_id, page_size as i64, offset as i64),
            |row: Row| { rows.push(row.unwrap()); }
        ).map_err(|e| e.to_string())?;

        let items: Vec<serde_json::Value> = rows.into_iter().map(|r| {
            serde_json::json!({
                "id": val_to_i64(&r[0]),
                "mod_id": val_to_i64(&r[1]),
                "mod_key": decrypt_str(&val_to_string(r[2].clone())),
                "type": val_to_string(r[3].clone()),
                "comment_id": val_to_i64(&r[4]),
                "is_read": val_to_i64(&r[5]) != 0,
                "created_at": val_to_string(r[6].clone()),
                "content": decrypt_str(&val_to_string(r[7].clone())),
                "author_name": decrypt_str(&val_to_string(r[8].clone())),
                "author_avatar": val_to_string(r[9].clone()),
                "author_id": val_to_i64(&r[10]),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, page_size))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_mark_read(
    state: tauri::State<'_, DbState>,
    user_id: u64,
    target_type: Option<String>,
    ids: Option<Vec<u64>>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        if let Some(ttype) = &target_type {
            match ttype.as_str() {
                "application" => {
                    if let Some(id_list) = &ids {
                        for id in id_list {
                            conn.exec_drop(
                                "UPDATE edit_applications SET is_read = 1 WHERE id = ? AND mod_id IN (SELECT id FROM mods WHERE author_id = ?)",
                                (id, user_id),
                            ).map_err(|e| e.to_string())?;
                        }
                    } else {
                        conn.exec_drop(
                            "UPDATE edit_applications SET is_read = 1 WHERE mod_id IN (SELECT id FROM mods WHERE author_id = ?) AND is_read = 0",
                            (user_id,),
                        ).map_err(|e| e.to_string())?;
                    }
                }
                "notification" => {
                    if let Some(id_list) = &ids {
                        for id in id_list {
                            conn.exec_drop(
                                "UPDATE mod_notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
                                (id, user_id),
                            ).map_err(|e| e.to_string())?;
                        }
                    } else {
                        conn.exec_drop(
                            "UPDATE mod_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
                            (user_id,),
                        ).map_err(|e| e.to_string())?;
                    }
                }
                _ => return Ok(ApiResponse::err("Invalid target type")),
            }
        } else {
            conn.exec_drop(
                "UPDATE edit_applications SET is_read = 1 WHERE mod_id IN (SELECT id FROM mods WHERE author_id = ?) AND is_read = 0",
                (user_id,),
            ).map_err(|e| e.to_string())?;
            conn.exec_drop(
                "UPDATE mod_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
                (user_id,),
            ).map_err(|e| e.to_string())?;
        }

        Ok(ApiResponse::ok_msg("Marked as read"))
    }).await
}
