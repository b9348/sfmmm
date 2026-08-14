use mysql::prelude::*;
use mysql::*;

use crate::db::{decrypt_str, encrypt_str, val_to_i64, val_to_string, with_conn, ApiResponse, DbState};

#[tauri::command(rename_all = "snake_case")]
pub async fn db_add_comment(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
    content: String,
    parent_id: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let content = content.trim().to_string();

        if content.is_empty() || content.len() > 2000 {
            return Ok(ApiResponse::err("Comment must be between 1 and 2000 characters"));
        }

        let mod_exists: Option<(u64, u64)> = conn.exec_first(
            "SELECT id, author_id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;
        let mod_author_id = match mod_exists {
            Some((_, aid)) => aid,
            None => return Ok(ApiResponse::err("Mod not found")),
        };

        if let Some(pid) = parent_id {
            let parent: Option<(u64, u64)> = conn.exec_first(
                "SELECT id, mod_id FROM mod_comments WHERE id = ?", (pid,)
            ).map_err(|e| e.to_string())?;
            match parent {
                Some((_, mid)) if mid == mod_id => {}
                Some(_) => return Ok(ApiResponse::err("Parent comment does not belong to this mod")),
                None => return Ok(ApiResponse::err("Parent comment not found")),
            }
        }

        let enc_content = encrypt_str(&content)?;
        conn.exec_drop(
            "INSERT INTO mod_comments (mod_id, author_id, parent_id, content) VALUES (?, ?, ?, ?)",
            (mod_id, author_id, parent_id, &enc_content),
        ).map_err(|e| e.to_string())?;

        let new_id = conn.last_insert_id();

        if mod_author_id != author_id {
            let notif_type = if parent_id.is_some() { "new_reply" } else { "new_comment" };
            conn.exec_drop(
                "INSERT INTO mod_notifications (user_id, mod_id, type, comment_id) VALUES (?, ?, ?, ?)",
                (mod_author_id, mod_id, notif_type, new_id),
            ).map_err(|e| e.to_string())?;
        }

        Ok(ApiResponse::ok_val(serde_json::json!({
            "comment_id": new_id,
            "author_id": author_id,
            "content": content,
        }), "Comment added"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_comments(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(10).min(100);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_comments WHERE mod_id = ? AND parent_id IS NULL", (mod_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let total_including_replies: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_comments WHERE mod_id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let mut top_rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(
            "SELECT c.id, c.content, c.created_at, u.username, u.avatar, c.author_id
             FROM mod_comments c
             JOIN users u ON c.author_id = u.id
             WHERE c.mod_id = ? AND c.parent_id IS NULL
             ORDER BY c.created_at DESC
             LIMIT ? OFFSET ?",
            (mod_id, page_size as i64, offset as i64),
            |row: Row| { top_rows.push(row.unwrap()); },
        ).map_err(|e| e.to_string())?;

        let items: Result<Vec<serde_json::Value>, String> = top_rows.into_iter().map(|r| {
            let cid = val_to_i64(&r[0]) as u64;

            let reply_count: i64 = conn.exec_first(
                "SELECT COUNT(*) FROM mod_comments WHERE parent_id = ?", (cid,)
            ).map_err(|e| e.to_string())?.unwrap_or(0i64);

            let mut reply_rows: Vec<Vec<Value>> = Vec::new();
            conn.exec_map(
                "SELECT c.id, c.content, c.created_at, u.username, u.avatar, c.author_id
                 FROM mod_comments c
                 JOIN users u ON c.author_id = u.id
                 WHERE c.parent_id = ?
                 ORDER BY c.created_at ASC
                 LIMIT 2",
                (cid,),
                |row: Row| { reply_rows.push(row.unwrap()); },
            ).map_err(|e| e.to_string())?;

            let replies: Vec<serde_json::Value> = reply_rows.into_iter().map(|rr| {
                serde_json::json!({
                    "id": val_to_i64(&rr[0]),
                    "content": decrypt_str(&val_to_string(rr[1].clone())),
                    "created_at": val_to_string(rr[2].clone()),
                    "author_name": decrypt_str(&val_to_string(rr[3].clone())),
                    "author_avatar": val_to_string(rr[4].clone()),
                    "author_id": val_to_i64(&rr[5]),
                })
            }).collect();

            Ok(serde_json::json!({
                "id": cid,
                "content": decrypt_str(&val_to_string(r[1].clone())),
                "created_at": val_to_string(r[2].clone()),
                "author_name": decrypt_str(&val_to_string(r[3].clone())),
                "author_avatar": val_to_string(r[4].clone()),
                "author_id": val_to_i64(&r[5]),
                "replies": replies,
                "reply_count": reply_count,
                "has_more": reply_count > 2,
            }))
        }).collect();

        let items = items?;

        Ok(ApiResponse {
            success: true,
            message: "OK".into(),
            data: Some(serde_json::json!({
                "comments": items,
                "total": total,
                "total_including_replies": total_including_replies,
                "page": page,
                "page_size": page_size,
            })),
            mods: None,
            total: None,
            page: None,
            page_size: None,
        })
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_replies(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(10).min(50);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_comments WHERE parent_id = ?", (comment_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let adjusted_offset = if page == 1 { 2u64 } else { 2 + offset };

        let mut rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(
            "SELECT c.id, c.content, c.created_at, u.username, u.avatar, c.author_id
             FROM mod_comments c
             JOIN users u ON c.author_id = u.id
             WHERE c.parent_id = ?
             ORDER BY c.created_at ASC
             LIMIT ? OFFSET ?",
            (comment_id, page_size as i64, adjusted_offset as i64),
            |row: Row| { rows.push(row.unwrap()); },
        ).map_err(|e| e.to_string())?;

        let replies: Vec<serde_json::Value> = rows.into_iter().map(|r| {
            serde_json::json!({
                "id": val_to_i64(&r[0]),
                "content": decrypt_str(&val_to_string(r[1].clone())),
                "created_at": val_to_string(r[2].clone()),
                "author_name": decrypt_str(&val_to_string(r[3].clone())),
                "author_avatar": val_to_string(r[4].clone()),
                "author_id": val_to_i64(&r[5]),
            })
        }).collect();

        Ok(ApiResponse {
            success: true,
            message: "OK".into(),
            data: Some(serde_json::json!({
                "replies": replies,
                "total": total,
                "page": page,
                "page_size": page_size,
            })),
            mods: None,
            total: None,
            page: None,
            page_size: None,
        })
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_edit_comment(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    author_id: u64,
    content: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let content = content.trim().to_string();

        if content.is_empty() || content.len() > 2000 {
            return Ok(ApiResponse::err("Comment must be between 1 and 2000 characters"));
        }

        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mod_comments WHERE id = ?", (comment_id,)
        ).map_err(|e| e.to_string())?;

        match owner {
            Some((aid,)) if aid == author_id => {
                let enc_content = encrypt_str(&content)?;
                conn.exec_drop(
                    "UPDATE mod_comments SET content = ? WHERE id = ?",
                    (&enc_content, comment_id),
                ).map_err(|e| e.to_string())?;
                Ok(ApiResponse::ok_val(serde_json::json!({
                    "comment_id": comment_id,
                    "content": content,
                }), "Comment updated"))
            }
            Some(_) => Ok(ApiResponse::err("You can only edit your own comments")),
            None => Ok(ApiResponse::err("Comment not found")),
        }
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_comment(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    author_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        // 取评论归属信息：作者 / 父评论（楼中楼指向的一楼）/ 所属模组
        let comment: Option<(u64, Option<u64>, u64)> = conn.exec_first(
            "SELECT author_id, parent_id, mod_id FROM mod_comments WHERE id = ?",
            (comment_id,),
        ).map_err(|e| e.to_string())?;

        let Some((comment_author, parent_id, mod_id)) = comment else {
            return Ok(ApiResponse::err("Comment not found"));
        };

        // 权限判定：本人 / 模组楼主（可删自己 mod 下所有评论及楼中楼）/ 楼中楼的层主（可删自己一楼下的回复）
        let mut allowed = comment_author == author_id;
        if !allowed {
            let owner: Option<(u64,)> = conn.exec_first(
                "SELECT author_id FROM mods WHERE id = ?", (mod_id,)
            ).map_err(|e| e.to_string())?;
            allowed = owner.is_some_and(|(oid,)| oid == author_id);
        }
        if !allowed {
            if let Some(pid) = parent_id {
                let floor_owner: Option<(u64,)> = conn.exec_first(
                    "SELECT author_id FROM mod_comments WHERE id = ?", (pid,)
                ).map_err(|e| e.to_string())?;
                allowed = floor_owner.is_some_and(|(fid,)| fid == author_id);
            }
        }

        if !allowed {
            return Ok(ApiResponse::err("You can only delete your own comments"));
        }

        // 删除评论及其楼中楼
        conn.exec_drop("DELETE FROM mod_comments WHERE parent_id = ?", (comment_id,))
            .map_err(|e| e.to_string())?;
        conn.exec_drop("DELETE FROM mod_comments WHERE id = ?", (comment_id,))
            .map_err(|e| e.to_string())?;
        Ok(ApiResponse::ok_msg("Comment deleted"))
    }).await
}
