use mysql::prelude::*;
use mysql::*;

use crate::db::{decrypt_str, encrypt_str, val_to_i64, val_to_string, with_conn, ApiResponse, DbState};

#[tauri::command(rename_all = "snake_case")]
pub async fn db_set_mod_permissions(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    mod_id: u64,
    mode: String,
    open_langs: Option<Vec<String>>,
    allow_mod_info: Option<bool>,
    allow_lang: Option<bool>,
    apply_langs: Option<Vec<String>>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;
        match owner {
            Some((aid,)) if aid != author_id => return Ok(ApiResponse::err("Only the author can set permissions")),
            None => return Ok(ApiResponse::err("Mod not found")),
            _ => {}
        }

        let open_langs_json = open_langs.map(|v| serde_json::json!(v).to_string());
        let apply_langs_json = apply_langs.map(|v| serde_json::json!(v).to_string());
        let allow_mod = allow_mod_info.unwrap_or(true);
        let allow_l = allow_lang.unwrap_or(true);

        let existing: Option<(u64,)> = conn.exec_first(
            "SELECT mod_id FROM mod_permissions WHERE mod_id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;

        if existing.is_some() {
            conn.exec_drop(
                "UPDATE mod_permissions SET mode = ?, open_langs = ?, allow_mod_info = ?, allow_lang = ?, apply_langs = ? WHERE mod_id = ?",
                (&mode, &open_langs_json, allow_mod, allow_l, &apply_langs_json, mod_id),
            ).map_err(|e| e.to_string())?;
        } else {
            conn.exec_drop(
                "INSERT INTO mod_permissions (mod_id, mode, open_langs, allow_mod_info, allow_lang, apply_langs) VALUES (?, ?, ?, ?, ?, ?)",
                (mod_id, &mode, &open_langs_json, allow_mod, allow_l, &apply_langs_json),
            ).map_err(|e| e.to_string())?;
        }

        Ok(ApiResponse::ok_msg("Permissions updated"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_submit_application(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    user_id: u64,
    scope: String,
    target_lang: Option<String>,
    reason: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let mod_exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;
        if mod_exists.is_none() {
            return Ok(ApiResponse::err("Mod not found"));
        }

        let pending: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM edit_applications WHERE mod_id = ? AND applicant_id = ? AND scope = ? AND (target_lang IS NULL OR target_lang = ?) AND status = 'pending'",
            (mod_id, user_id, &scope, &target_lang),
        ).map_err(|e| e.to_string())?;
        if pending.is_some() {
            return Ok(ApiResponse::err("You already have a pending application for this scope"));
        }

        let reason_str = encrypt_str(&reason.unwrap_or_default())?;
        conn.exec_drop(
            "INSERT INTO edit_applications (mod_id, applicant_id, scope, target_lang, reason, status) VALUES (?, ?, ?, ?, ?, 'pending')",
            (mod_id, user_id, &scope, &target_lang, &reason_str),
        ).map_err(|e| e.to_string())?;

        Ok(ApiResponse::ok_msg("Application submitted"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_applications(
    state: tauri::State<'_, DbState>,
    mod_id: Option<u64>,
    user_id: Option<u64>,
    role: Option<String>,
    status: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).min(100);
        let offset = (page - 1) * page_size;

        let mut where_clauses: Vec<String> = Vec::new();
        let mut params: Vec<mysql::Value> = Vec::new();

        if let Some(mid) = mod_id {
            where_clauses.push("a.mod_id = ?".into());
            params.push(mysql::Value::UInt(mid));
        }
        if let Some(uid) = user_id {
            if role.as_deref() == Some("author") {
                where_clauses.push("m.author_id = ?".into());
            } else {
                where_clauses.push("a.applicant_id = ?".into());
            }
            params.push(mysql::Value::UInt(uid));
        }
        if let Some(s) = status {
            if !s.is_empty() {
                where_clauses.push("a.status = ?".into());
                params.push(mysql::Value::Bytes(s.into_bytes()));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let count_sql = format!(
            "SELECT COUNT(*) FROM edit_applications a JOIN mods m ON a.mod_id = m.id {}",
            where_sql
        );
        let total: i64 = conn.exec_first(&count_sql, params.clone())
            .map_err(|e| e.to_string())?.unwrap_or(0i64);

        let mut rows: Vec<Vec<Value>> = Vec::new();
        let query_sql = format!(
            "SELECT a.id, a.mod_id, m.mod_id as mod_key, a.applicant_id, u.username as applicant_name, u.avatar as applicant_avatar,
                    a.scope, a.target_lang, a.reason, a.status, a.created_at
             FROM edit_applications a
             JOIN mods m ON a.mod_id = m.id
             JOIN users u ON a.applicant_id = u.id
             {} ORDER BY a.created_at DESC LIMIT ? OFFSET ?",
            where_sql
        );
        let mut query_params = params.clone();
        query_params.push(mysql::Value::UInt(page_size));
        query_params.push(mysql::Value::UInt(offset));

        conn.exec_map(&query_sql, query_params, |row: Row| {
            rows.push(row.unwrap());
        }).map_err(|e| e.to_string())?;

        let items: Vec<serde_json::Value> = rows.into_iter().map(|r| {
            serde_json::json!({
                "id": val_to_i64(&r[0]),
                "mod_id": val_to_i64(&r[1]),
                "mod_key": decrypt_str(&val_to_string(r[2].clone())),
                "applicant_id": val_to_i64(&r[3]),
                "applicant_name": decrypt_str(&val_to_string(r[4].clone())),
                "applicant_avatar": val_to_string(r[5].clone()),
                "scope": val_to_string(r[6].clone()),
                "target_lang": val_to_string(r[7].clone()),
                "reason": decrypt_str(&val_to_string(r[8].clone())),
                "status": val_to_string(r[9].clone()),
                "created_at": val_to_string(r[10].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, page_size))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_handle_application(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    app_id: u64,
    action: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let app: Option<(u64, u64, String, Option<String>)> = conn.exec_first(
            "SELECT mod_id, applicant_id, scope, target_lang FROM edit_applications WHERE id = ?",
            (app_id,),
        ).map_err(|e| e.to_string())?;

        let (mod_id, applicant_id, scope, target_lang) = match app {
            Some(a) => a,
            None => return Ok(ApiResponse::err("Application not found")),
        };

        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;
        match owner {
            Some((aid,)) if aid == author_id => {}
            _ => return Ok(ApiResponse::err("Only the mod author can handle applications")),
        }

        let db_status = match action.as_str() {
            "approve" => "approved",
            "deny" => "denied",
            _ => return Ok(ApiResponse::err("Invalid action, must be 'approve' or 'deny'")),
        };

        conn.exec_drop(
            "UPDATE edit_applications SET status = ?, handled_by = ? WHERE id = ?",
            (db_status, author_id, app_id),
        ).map_err(|e| e.to_string())?;

        if action == "approve" {
            let existing: Option<(u64,)> = conn.exec_first(
                "SELECT id FROM mod_collaborators WHERE mod_id = ? AND user_id = ? AND scope = ? AND (target_lang IS NULL OR target_lang = ?)",
                (mod_id, applicant_id, &scope, &target_lang),
            ).map_err(|e| e.to_string())?;

            if existing.is_none() {
                conn.exec_drop(
                    "INSERT INTO mod_collaborators (mod_id, user_id, scope, target_lang) VALUES (?, ?, ?, ?)",
                    (mod_id, applicant_id, &scope, &target_lang),
                ).map_err(|e| e.to_string())?;
            }
        }

        Ok(ApiResponse::ok_msg(if action == "approve" { "Application approved" } else { "Application denied" }))
    }).await
}
