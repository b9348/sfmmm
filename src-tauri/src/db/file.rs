use mysql::prelude::*;
use mysql::*;

use crate::db::{encrypt_str, get_user_permissions, hash, with_conn, ApiResponse, DbState};

#[tauri::command(rename_all = "snake_case")]
pub async fn db_save_mod_file(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
    lang_code: String,
    file_url: String,
    file_name: String,
    file_size: i64,
    file_hash: String,
    version: Option<String>,
    manifest: Option<String>,
    file_hashes: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let ver = version.unwrap_or_else(|| "1.0.0".into());

        let perm = get_user_permissions(conn, mod_id, author_id)?;
        let is_author = perm["is_author"].as_bool().unwrap_or(false);
        let can_edit_all_langs = perm["can_edit_all_langs"].as_bool().unwrap_or(false);
        let editable_langs = perm["editable_langs"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
            .unwrap_or_default();

        let can_edit_lang = is_author || can_edit_all_langs || editable_langs.contains(&lang_code);
        if !can_edit_lang {
            return Ok(ApiResponse::err("You don't have permission to upload files for this language"));
        }

        hash::ensure_mod_files_file_hashes_column(conn)?;

        let existing: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mod_files WHERE mod_id = ? AND lang_code = ?",
            (mod_id, &lang_code),
        ).map_err(|e| e.to_string())?;

        // 明文长度上限：确保密文能容纳于目标列宽（file_name≤200，manifest≤30000 字符）
        if file_name.chars().count() > 200 {
            return Ok(ApiResponse::err("文件名过长（≤200 字符）"));
        }
        if let Some(m) = &manifest {
            if m.chars().count() > 30000 {
                return Ok(ApiResponse::err("manifest 过长（≤30000 字符）"));
            }
        }
        let enc_name = encrypt_str(&file_name)?;
        let enc_manifest = match &manifest {
            Some(m) => Some(encrypt_str(m)?),
            None => None,
        };

        if existing.is_some() {
            conn.exec_drop(
                "UPDATE mod_files SET file_url = ?, file_name = ?, file_size = ?, file_hash = ?, version = ?, manifest = ?, file_hashes = ? WHERE mod_id = ? AND lang_code = ?",
                (&file_url, &enc_name, file_size, &file_hash, &ver, &enc_manifest, &file_hashes, mod_id, &lang_code),
            ).map_err(|e| e.to_string())?;
        } else {
            conn.exec_drop(
                "INSERT INTO mod_files (mod_id, lang_code, file_url, file_name, file_size, file_hash, version, manifest, file_hashes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (mod_id, &lang_code, &file_url, &enc_name, file_size, &file_hash, &ver, &enc_manifest, &file_hashes),
            ).map_err(|e| e.to_string())?;
        }

        Ok(ApiResponse::ok_val(serde_json::json!({
            "lang_code": lang_code,
            "file_url": file_url,
            "file_name": file_name,
            "file_size": file_size,
            "file_hash": file_hash,
            "version": ver,
            "manifest": manifest,
            "file_hashes": file_hashes,
        }), "File saved"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_mod_file(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
    lang_code: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let perm = get_user_permissions(conn, mod_id, author_id)?;
        let is_author = perm["is_author"].as_bool().unwrap_or(false);
        let can_edit_all_langs = perm["can_edit_all_langs"].as_bool().unwrap_or(false);
        let editable_langs = perm["editable_langs"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
            .unwrap_or_default();

        let can_edit_lang = is_author || can_edit_all_langs || editable_langs.contains(&lang_code);
        if !can_edit_lang {
            return Ok(ApiResponse::err("You don't have permission to delete files for this language"));
        }

        conn.exec_drop(
            "DELETE FROM mod_files WHERE mod_id = ? AND lang_code = ?",
            (mod_id, &lang_code),
        ).map_err(|e| e.to_string())?;

        Ok(ApiResponse::ok_msg("File deleted"))
    }).await
}
