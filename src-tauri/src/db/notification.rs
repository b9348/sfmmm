use mysql::prelude::*;
use mysql::*;

use crate::db::{decrypt_str, val_to_i64, val_to_string, with_conn, ApiResponse, DbState};

/// 历史数据补录（一次性，幂等）：为楼中楼回复中被 @ 的用户补发漏掉的通知。
///
/// 背景：扁平楼中楼模型下 parent_id 统一为一楼 id，旧版通知只发层主与楼主，
/// "回复楼中楼中的某条消息"时被回复人未入库。前端在内容前加 `@用户名 ` 前缀，
/// 据此解密匹配被回复人；已有同 (user_id, comment_id) 通知的跳过（含层主/楼主
/// 已收到的情况），补录为未读，created_at 以该评论的发送时间为准，从最新开始插入。
/// 由 `cargo run --example backfill_reply_notifications` 触发执行。
pub async fn backfill_reply_notifications(state: &DbState) -> Result<String, String> {
    use std::collections::HashMap;

    with_conn(state, move |conn: &mut PooledConn| {
        // 用户名 → id 映射（username 确定性加密，逐行解密建立全量映射）
        let mut name_to_id: HashMap<String, u64> = HashMap::new();
        {
            let mut rows: Vec<Vec<Value>> = Vec::new();
            conn.exec_map("SELECT id, username FROM users", (), |row: Row| {
                rows.push(row.unwrap());
            }).map_err(|e| e.to_string())?;
            for r in rows {
                name_to_id.insert(
                    decrypt_str(&val_to_string(r[1].clone())),
                    val_to_i64(&r[0]) as u64,
                );
            }
        }

        // 提取 "@用户名 " 前缀指向的被回复人（用户名为字母数字，不含空格）
        let mentioned = |content: &str| -> Option<u64> {
            let rest = content.strip_prefix('@')?;
            let name = rest.split(' ').next()?;
            name_to_id.get(name).copied()
        };

        let mut inserted_mod: usize = 0;
        let mut inserted_disc: usize = 0;
        let mut skipped: usize = 0;

        // mod 评论楼中楼（ORDER BY created_at DESC：从最新处开始插入）
        {
            let mut rows: Vec<Vec<Value>> = Vec::new();
            conn.exec_map(
                "SELECT id, mod_id, author_id, content, created_at FROM mod_comments
                 WHERE parent_id IS NOT NULL ORDER BY created_at DESC",
                (),
                |row: Row| rows.push(row.unwrap()),
            ).map_err(|e| e.to_string())?;
            for r in rows {
                let cid = val_to_i64(&r[0]) as u64;
                let mod_id = val_to_i64(&r[1]) as u64;
                let author = val_to_i64(&r[2]) as u64;
                let content = decrypt_str(&val_to_string(r[3].clone()));
                let created = val_to_string(r[4].clone());
                let Some(target) = mentioned(&content) else { skipped += 1; continue };
                if target == author { skipped += 1; continue; }
                let exists: Option<(i64,)> = conn.exec_first(
                    "SELECT 1 FROM mod_notifications WHERE user_id = ? AND comment_id = ? LIMIT 1",
                    (target, cid),
                ).map_err(|e| e.to_string())?;
                if exists.is_some() { skipped += 1; continue; }
                conn.exec_drop(
                    "INSERT INTO mod_notifications (user_id, mod_id, type, comment_id, is_read, created_at)
                     VALUES (?, ?, 'new_reply', ?, 0, ?)",
                    (target, mod_id, cid, created),
                ).map_err(|e| e.to_string())?;
                inserted_mod += 1;
            }
        }

        // 讨论区评论楼中楼（同上）
        {
            let mut rows: Vec<Vec<Value>> = Vec::new();
            conn.exec_map(
                "SELECT id, discussion_id, author_id, content, created_at FROM discussion_comments
                 WHERE parent_id IS NOT NULL ORDER BY created_at DESC",
                (),
                |row: Row| rows.push(row.unwrap()),
            ).map_err(|e| e.to_string())?;
            for r in rows {
                let cid = val_to_i64(&r[0]) as u64;
                let disc_id = val_to_i64(&r[1]) as u64;
                let author = val_to_i64(&r[2]) as u64;
                let content = decrypt_str(&val_to_string(r[3].clone()));
                let created = val_to_string(r[4].clone());
                let Some(target) = mentioned(&content) else { skipped += 1; continue };
                if target == author { skipped += 1; continue; }
                let exists: Option<(i64,)> = conn.exec_first(
                    "SELECT 1 FROM discussion_notifications WHERE user_id = ? AND comment_id = ? LIMIT 1",
                    (target, cid),
                ).map_err(|e| e.to_string())?;
                if exists.is_some() { skipped += 1; continue; }
                conn.exec_drop(
                    "INSERT INTO discussion_notifications (user_id, discussion_id, type, comment_id, is_read, created_at)
                     VALUES (?, ?, 'new_reply', ?, 0, ?)",
                    (target, disc_id, cid, created),
                ).map_err(|e| e.to_string())?;
                inserted_disc += 1;
            }
        }

        Ok(format!(
            "补录完成：mod 通知 +{inserted_mod} 条，讨论区通知 +{inserted_disc} 条，跳过 {skipped} 条（无 @ 前缀 / 回复自己 / 已有通知）"
        ))
    }).await
}

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

        // 点赞/评分无未读概念（前端有独立「点赞/评分」tab），且通知列表只展示带
        // comment_id 的评论/回复类通知；历史遗留的 new_like/new_rating 通知不计入未读。
        let unread_mod: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_notifications WHERE user_id = ? AND is_read = 0 AND type NOT IN ('new_like', 'new_rating')",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let unread_disc: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM discussion_notifications WHERE user_id = ? AND is_read = 0",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let unread_notifs = unread_mod + unread_disc;

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

        // 合并两类通知：mod_notifications（mod 评论/回复）+ discussion_notifications（讨论区评论/回复）。
        // 只统计评论仍存在（未删除）的通知：删除评论后其通知行仍残留，若 LEFT JOIN 会得到 content/作者为 NULL
        // 的"幽灵"卡片（重复显示且缺作者信息），故按评论存在性过滤，并保证 total 与列表项数一致。
        let total_mod: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_notifications n JOIN mod_comments c ON n.comment_id = c.id WHERE n.user_id = ?",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);
        let total_disc: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM discussion_notifications n JOIN discussion_comments c ON n.comment_id = c.id WHERE n.user_id = ?",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);
        let total = total_mod + total_disc;

        let mut rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(
            // mod_notifications 为 utf8mb4_0900_ai_ci，其余表为 utf8mb4_unicode_ci，
            // UNION 合并需显式统一 type 列的 collation，否则报 Illegal mix of collations for operation 'UNION'
            "SELECT n.id, 'mod' as entity, n.mod_id as target_id, m.mod_id as display_key, n.type COLLATE utf8mb4_unicode_ci, n.comment_id, n.is_read, n.created_at,
                    c.content as comment_content, u.username as comment_author, u.avatar as comment_author_avatar, c.author_id
             FROM mod_notifications n
             JOIN mods m ON n.mod_id = m.id
             JOIN mod_comments c ON n.comment_id = c.id
             LEFT JOIN users u ON c.author_id = u.id
             WHERE n.user_id = ?
             UNION ALL
             SELECT n.id, 'discussion' as entity, n.discussion_id as target_id, d.title as display_key, n.type, n.comment_id, n.is_read, n.created_at,
                    c.content as comment_content, u.username as comment_author, u.avatar as comment_author_avatar, c.author_id
             FROM discussion_notifications n
             JOIN discussions d ON n.discussion_id = d.id
             JOIN discussion_comments c ON n.comment_id = c.id
             LEFT JOIN users u ON c.author_id = u.id
             WHERE n.user_id = ?
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?",
            (user_id, user_id, page_size as i64, offset as i64),
            |row: Row| { rows.push(row.unwrap()); }
        ).map_err(|e| e.to_string())?;

        let items: Vec<serde_json::Value> = rows.into_iter().map(|r| {
            serde_json::json!({
                "id": val_to_i64(&r[0]),
                "entity": val_to_string(r[1].clone()),
                "target_id": val_to_i64(&r[2]),
                "display_key": decrypt_str(&val_to_string(r[3].clone())),
                "type": val_to_string(r[4].clone()),
                "comment_id": val_to_i64(&r[5]),
                "is_read": val_to_i64(&r[6]) != 0,
                "created_at": val_to_string(r[7].clone()),
                "content": decrypt_str(&val_to_string(r[8].clone())),
                "author_name": decrypt_str(&val_to_string(r[9].clone())),
                "author_avatar": val_to_string(r[10].clone()),
                "author_id": val_to_i64(&r[11]),
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
    entity: Option<String>,
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
                        // mod_notifications 与 discussion_notifications 各自 AUTO_INCREMENT，
                        // 相同数字 id 可能分属两张表：按 entity 只更新对应表，避免跨表误标已读
                        let is_discussion = entity.as_deref() == Some("discussion");
                        for id in id_list {
                            if is_discussion {
                                conn.exec_drop(
                                    "UPDATE discussion_notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
                                    (id, user_id),
                                ).map_err(|e| e.to_string())?;
                            } else {
                                conn.exec_drop(
                                    "UPDATE mod_notifications SET is_read = 1 WHERE id = ? AND user_id = ?",
                                    (id, user_id),
                                ).map_err(|e| e.to_string())?;
                            }
                        }
                    } else {
                        conn.exec_drop(
                            "UPDATE mod_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
                            (user_id,),
                        ).map_err(|e| e.to_string())?;
                        conn.exec_drop(
                            "UPDATE discussion_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
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
            conn.exec_drop(
                "UPDATE discussion_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0",
                (user_id,),
            ).map_err(|e| e.to_string())?;
        }

        Ok(ApiResponse::ok_msg("Marked as read"))
    }).await
}
