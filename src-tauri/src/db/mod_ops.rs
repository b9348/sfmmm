use mysql::prelude::*;
use mysql::*;

use crate::db::{get_user_permissions, val_to_i64, val_to_string, with_conn, ApiResponse, DbState};

struct ModBatchData {
    files_by_mod: std::collections::HashMap<u64, Vec<serde_json::Value>>,
    trans_by_mod: std::collections::HashMap<u64, serde_json::Value>,
    likes_by_mod: std::collections::HashMap<u64, (i64, bool)>,
    comment_counts: std::collections::HashMap<u64, i64>,
}

impl ModBatchData {
    fn collect(conn: &mut PooledConn, mod_ids: &[u64], device_id: Option<String>) -> Result<Self, String> {
        let mut files_by_mod: std::collections::HashMap<u64, Vec<serde_json::Value>> = std::collections::HashMap::new();
        let mut trans_by_mod: std::collections::HashMap<u64, serde_json::Value> = std::collections::HashMap::new();
        let mut likes_by_mod: std::collections::HashMap<u64, (i64, bool)> = std::collections::HashMap::new();
        let mut comment_counts: std::collections::HashMap<u64, i64> = std::collections::HashMap::new();

        if mod_ids.is_empty() {
            return Ok(Self { files_by_mod, trans_by_mod, likes_by_mod, comment_counts });
        }

        let ph: Vec<String> = mod_ids.iter().map(|_| "?".to_string()).collect();
        let id_params: Vec<Value> = mod_ids.iter().map(|&id| Value::UInt(id)).collect();

        let file_sql = format!(
            "SELECT mod_id, lang_code, file_url, file_name, file_size, file_hash, version, created_at, manifest FROM mod_files WHERE mod_id IN ({})",
            ph.join(",")
        );
        conn.exec_map(&file_sql, &id_params, |row: Row| {
            let vals: Vec<Value> = row.unwrap();
            let mid = val_to_i64(&vals[0]) as u64;
            let fj = serde_json::json!({
                "lang_code": val_to_string(vals[1].clone()),
                "file_url": val_to_string(vals[2].clone()),
                "file_name": val_to_string(vals[3].clone()),
                "file_size": val_to_i64(&vals[4]),
                "file_hash": match vals[5].clone() { Value::Bytes(b) if !b.is_empty() => Some(String::from_utf8_lossy(&b).to_string()), _ => None },
                "version": val_to_string(vals[6].clone()),
                "created_at": val_to_string(vals[7].clone()),
                "manifest": val_to_string(vals[8].clone()),
            });
            files_by_mod.entry(mid).or_default().push(fj);
        }).map_err(|e| e.to_string())?;

        let trans_sql = format!(
            "SELECT mod_id, lang_code, name, description, instructions, instructions_format, changelog, version FROM mod_translations WHERE mod_id IN ({})",
            ph.join(",")
        );
        conn.exec_map(&trans_sql, &id_params, |row: Row| {
            let vals: Vec<Value> = row.unwrap();
            let mid = val_to_i64(&vals[0]) as u64;
            let entry = trans_by_mod.entry(mid).or_insert_with(|| serde_json::json!({}));
            if let Some(obj) = entry.as_object_mut() {
                obj.insert(val_to_string(vals[1].clone()), serde_json::json!({
                    "name": val_to_string(vals[2].clone()),
                    "description": val_to_string(vals[3].clone()),
                    "instructions": val_to_string(vals[4].clone()),
                    "instructions_format": val_to_string(vals[5].clone()),
                    "changelog": val_to_string(vals[6].clone()),
                    "version": val_to_string(vals[7].clone()),
                }));
            }
        }).map_err(|e| e.to_string())?;

        let like_sql = format!(
            "SELECT mod_id, COUNT(*) as cnt, SUM(CASE WHEN device_id = ? THEN 1 ELSE 0 END) as me FROM mod_likes WHERE mod_id IN ({}) GROUP BY mod_id",
            ph.join(",")
        );
        let mut like_params: Vec<Value> = vec![device_id.unwrap_or_default().into()];
        like_params.extend(id_params.clone());
        conn.exec_map(&like_sql, like_params, |row: Row| {
            let vals: Vec<Value> = row.unwrap();
            let mid = val_to_i64(&vals[0]) as u64;
            let cnt = val_to_i64(&vals[1]);
            let me = val_to_i64(&vals[2]) > 0;
            likes_by_mod.insert(mid, (cnt, me));
        }).map_err(|e| e.to_string())?;

        let comment_sql = format!(
            "SELECT mod_id, COUNT(*) FROM mod_comments WHERE mod_id IN ({}) GROUP BY mod_id",
            ph.join(",")
        );
        conn.exec_map(&comment_sql, &id_params, |row: Row| {
            let vals: Vec<Value> = row.unwrap();
            let mid = val_to_i64(&vals[0]) as u64;
            let cnt = val_to_i64(&vals[1]);
            comment_counts.insert(mid, cnt);
        }).map_err(|e| e.to_string())?;

        Ok(Self { files_by_mod, trans_by_mod, likes_by_mod, comment_counts })
    }
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_mods(
    state: tauri::State<'_, DbState>,
    lang: Option<String>,
    search: Option<String>,
    page: Option<u64>,
    limit: Option<u64>,
    sort_by: Option<String>,
    device_id: Option<String>,
    category: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());
        let page = page.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(20).min(100);
        let offset = (page - 1) * limit;
        let sort_by = sort_by.filter(|s| !s.is_empty()).unwrap_or_else(|| "created_at".into());
        let order_sql = match sort_by.as_str() {
            "likes" => "ORDER BY m.like_count DESC, m.created_at DESC",
            _ => "ORDER BY m.created_at DESC",
        };

        let mut conditions: Vec<String> = Vec::new();
        let mut params: Vec<Value> = Vec::new();
        if let Some(ref s) = search {
            let p = format!("%{}%", s);
            conditions.push("(m.mod_id LIKE ? OR m.id IN (SELECT mod_id FROM mod_translations WHERE name LIKE ? OR description LIKE ? OR lang_code LIKE ?))".into());
            params.extend(vec![p.clone().into(), p.clone().into(), p.clone().into(), p.into()]);
        }
        if let Some(ref c) = category {
            conditions.push("m.category = ?".into());
            params.push(c.clone().into());
        }
        let where_sql = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let count_sql = format!("SELECT COUNT(DISTINCT m.id) FROM mods m {}", where_sql);
        let total: i64 = conn.exec_first(&count_sql, params.clone()).map_err(|e| e.to_string())?
            .unwrap_or(0i64);

        let query_sql = format!(
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version) as version, m.category, m.download_count, m.like_count,
                    m.created_at, m.updated_at, u.username,
                    COALESCE(mt_t.name, mt_en.name, m.mod_id),
                    COALESCE(mt_t.description, mt_en.description, ''),
                    COALESCE(mt_t.instructions, mt_en.instructions, ''),
                    COALESCE(mt_t.instructions_format, mt_en.instructions_format, 'markdown'),
                    COALESCE(mt_t.changelog, mt_en.changelog, ''),
                    CASE WHEN mt_t.name IS NOT NULL THEN ? WHEN mt_en.name IS NOT NULL THEN 'en' ELSE 'default' END,
                    u.avatar, u.id
             FROM mods m
             JOIN users u ON m.author_id = u.id
             LEFT JOIN mod_translations mt_t ON m.id = mt_t.mod_id AND mt_t.lang_code = ?
             LEFT JOIN mod_translations mt_en ON m.id = mt_en.mod_id AND mt_en.lang_code = 'en'
             {}
             {} LIMIT ? OFFSET ?",
            where_sql, order_sql
        );

        let mut all_params: Vec<Value> = vec![lang.clone().into(), lang.clone().into()];
        all_params.append(&mut params);
        all_params.push((limit as i64).into());
        all_params.push((offset as i64).into());

        let mut mod_rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(&query_sql, all_params, |row: Row| {
            let vals: Vec<Value> = row.unwrap();
            mod_rows.push(vals);
        }).map_err(|e| e.to_string())?;

        let mod_ids: Vec<u64> = mod_rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let mut batch = ModBatchData::collect(conn, &mod_ids, device_id)?;

        let items: Vec<serde_json::Value> = mod_rows.into_iter().map(|r| {
            let mid = val_to_i64(&r[0]) as u64;
            let (like_count, is_liked) = batch.likes_by_mod.get(&mid).copied().unwrap_or((0, false));
            serde_json::json!({
                "id": mid,
                "mod_key": val_to_string(r[1].clone()),
                "display_name": val_to_string(r[9].clone()),
                "description": val_to_string(r[10].clone()),
                "instructions": val_to_string(r[11].clone()),
                "instructions_format": val_to_string(r[12].clone()),
                "changelog": val_to_string(r[13].clone()),
                "category": val_to_string(r[3].clone()),
                "author_name": val_to_string(r[8].clone()),
                "author_avatar": val_to_string(r[15].clone()),
                "author_id": val_to_i64(&r[16]),
                "download_count": val_to_i64(&r[4]),
                "like_count": like_count,
                "is_liked": is_liked,
                "comment_count": batch.comment_counts.get(&mid).copied().unwrap_or(0),
                "language": val_to_string(r[14].clone()),
                "files": batch.files_by_mod.remove(&mid).unwrap_or_default(),
                "translations": batch.trans_by_mod.remove(&mid).unwrap_or_default(),
                "created_at": val_to_string(r[5].clone()),
                "updated_at": val_to_string(r[6].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, limit))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_my_mods(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    lang: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
    device_id: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).min(100);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mods WHERE author_id = ?", (author_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let query_sql = format!(
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version) as version, m.category, m.download_count, m.like_count,
                    m.created_at, m.updated_at, u.username,
                    COALESCE(mt_t.name, mt_en.name, m.mod_id),
                    COALESCE(mt_t.description, mt_en.description, ''),
                    COALESCE(mt_t.instructions, mt_en.instructions, ''),
                    COALESCE(mt_t.instructions_format, mt_en.instructions_format, 'markdown'),
                    COALESCE(mt_t.changelog, mt_en.changelog, ''),
                    CASE WHEN mt_t.name IS NOT NULL THEN ? WHEN mt_en.name IS NOT NULL THEN 'en' ELSE 'default' END,
                    u.avatar, u.id
             FROM mods m
             JOIN users u ON m.author_id = u.id
             LEFT JOIN mod_translations mt_t ON m.id = mt_t.mod_id AND mt_t.lang_code = ?
             LEFT JOIN mod_translations mt_en ON m.id = mt_en.mod_id AND mt_en.lang_code = 'en'
             WHERE m.author_id = ?
             ORDER BY m.created_at DESC
             LIMIT ? OFFSET ?"
        );

        let mut mod_rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(&query_sql, vec![
            lang.clone().into(), lang.clone().into(),
            Value::UInt(author_id),
            (page_size as i64).into(), (offset as i64).into(),
        ], |row: Row| {
            mod_rows.push(row.unwrap());
        }).map_err(|e| e.to_string())?;

        let mod_ids: Vec<u64> = mod_rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let mut batch = ModBatchData::collect(conn, &mod_ids, device_id)?;

        let items: Vec<serde_json::Value> = mod_rows.into_iter().map(|r| {
            let mid = val_to_i64(&r[0]) as u64;
            let (like_count, is_liked) = batch.likes_by_mod.get(&mid).copied().unwrap_or((0, false));
            serde_json::json!({
                "id": mid,
                "mod_key": val_to_string(r[1].clone()),
                "display_name": val_to_string(r[9].clone()),
                "description": val_to_string(r[10].clone()),
                "category": val_to_string(r[3].clone()),
                "author_name": val_to_string(r[8].clone()),
                "author_avatar": val_to_string(r[15].clone()),
                "author_id": val_to_i64(&r[16]),
                "download_count": val_to_i64(&r[4]),
                "like_count": like_count,
                "is_liked": is_liked,
                "comment_count": batch.comment_counts.get(&mid).copied().unwrap_or(0),
                "files": batch.files_by_mod.remove(&mid).unwrap_or_default(),
                "translations": batch.trans_by_mod.remove(&mid).unwrap_or_default(),
                "created_at": val_to_string(r[5].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, page_size))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_mod_detail(
    state: tauri::State<'_, DbState>,
    id: u64,
    mod_key: Option<String>,
    lang: Option<String>,
    user_id: Option<u64>,
    device_id: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());

        let row: Option<Row> = conn.exec_first(
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version) as version, m.category, m.download_count, m.like_count,
                    m.created_at, m.updated_at, u.username,
                    COALESCE(mt_t.name, mt_en.name, m.mod_id),
                    COALESCE(mt_t.description, mt_en.description, ''),
                    COALESCE(mt_t.instructions, mt_en.instructions, ''),
                    COALESCE(mt_t.instructions_format, mt_en.instructions_format, 'markdown'),
                    COALESCE(mt_t.changelog, mt_en.changelog, ''),
                    CASE WHEN mt_t.name IS NOT NULL THEN ? WHEN mt_en.name IS NOT NULL THEN 'en' ELSE 'default' END,
                    u.avatar, u.id
             FROM mods m
             JOIN users u ON m.author_id = u.id
             LEFT JOIN mod_translations mt_t ON m.id = mt_t.mod_id AND mt_t.lang_code = ?
             LEFT JOIN mod_translations mt_en ON m.id = mt_en.mod_id AND mt_en.lang_code = 'en'
             WHERE (m.id = ? OR m.mod_id = ?)",
            (lang.clone(), lang.clone(), id, mod_key.clone().unwrap_or_default()),
        ).map_err(|e| e.to_string())?;

        match row {
            Some(row_data) => {
                let vals: Vec<Value> = row_data.unwrap();
                let mid = val_to_i64(&vals[0]) as u64;

                let mut files: Vec<serde_json::Value> = Vec::new();
                conn.exec_map(
                    "SELECT lang_code, file_url, file_name, file_size, file_hash, version, created_at, manifest FROM mod_files WHERE mod_id = ?", (mid,),
                    |row: Row| {
                        let r: Vec<Value> = row.unwrap();
                        files.push(serde_json::json!({
                            "lang_code": val_to_string(r[0].clone()),
                            "file_url": val_to_string(r[1].clone()),
                            "file_name": val_to_string(r[2].clone()),
                            "file_size": val_to_i64(&r[3]),
                            "file_hash": match r[4].clone() { Value::Bytes(b) if !b.is_empty() => Some(String::from_utf8_lossy(&b).to_string()), _ => None },
                            "version": val_to_string(r[5].clone()),
                            "created_at": val_to_string(r[6].clone()),
                            "manifest": val_to_string(r[7].clone()),
                        }));
                    }
                ).map_err(|e| e.to_string())?;

                let mut translations: serde_json::Value = serde_json::json!({});
                conn.exec_map(
                    "SELECT lang_code, name, description, instructions, instructions_format, changelog, version FROM mod_translations WHERE mod_id = ?",
                    (id,),
                    |row: Row| {
                        let r: Vec<Value> = row.unwrap();
                        if let Some(obj) = translations.as_object_mut() {
                            obj.insert(val_to_string(r[0].clone()), serde_json::json!({
                                "name": val_to_string(r[1].clone()),
                                "description": val_to_string(r[2].clone()),
                                "instructions": val_to_string(r[3].clone()),
                                "instructions_format": val_to_string(r[4].clone()),
                                "changelog": val_to_string(r[5].clone()),
                                "version": val_to_string(r[6].clone()),
                            }));
                        }
                    }
                ).map_err(|e| e.to_string())?;

                let did = device_id.unwrap_or_default();
                let like_row: Option<(i64, Option<i64>)> = conn.exec_first(
                    "SELECT COUNT(*), SUM(CASE WHEN device_id = ? THEN 1 ELSE 0 END) FROM mod_likes WHERE mod_id = ?",
                    (did, id),
                ).map_err(|e| e.to_string())?;
                let (like_count, is_liked) = match like_row {
                    Some((cnt, Some(me))) => (cnt, me > 0),
                    Some((cnt, None)) => (cnt, false),
                    None => (0, false),
                };

                let user_permissions = if let Some(uid) = user_id {
                    get_user_permissions(conn, mid, uid)?
                } else {
                    serde_json::json!({ "is_author": false, "can_edit_mod_info": false, "can_edit_all_langs": false, "editable_langs": null, "can_apply_mod_info": false, "can_apply_lang": false, "applyable_langs": null, "mode": "author_only" })
                };

                Ok(ApiResponse::ok_val(serde_json::json!({
                    "mod": {
                        "id": mid,
                        "mod_key": val_to_string(vals[1].clone()),
                        "display_name": val_to_string(vals[9].clone()),
                        "description": val_to_string(vals[10].clone()),
                        "instructions": val_to_string(vals[11].clone()),
                        "instructions_format": val_to_string(vals[12].clone()),
                        "changelog": val_to_string(vals[13].clone()),
                        "category": val_to_string(vals[3].clone()),
                        "author_name": val_to_string(vals[8].clone()),
                        "author_avatar": val_to_string(vals[15].clone()),
                        "author_id": val_to_i64(&vals[16]),
                        "download_count": val_to_i64(&vals[4]),
                        "like_count": like_count,
                        "is_liked": is_liked,
                        "language": val_to_string(vals[14].clone()),
                        "files": files,
                        "created_at": val_to_string(vals[6].clone()),
                        "updated_at": val_to_string(vals[7].clone()),
                        "translations": translations,
                        "user_permissions": user_permissions,
                    }
                }), "OK"))
            }
            None => Ok(ApiResponse::err("Mod not found")),
        }
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_mod_for_edit(
    state: tauri::State<'_, DbState>,
    id: u64,
    user_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let mod_row: Option<(u64, String, String)> = conn.exec_first(
            "SELECT author_id, mod_id, category FROM mods WHERE id = ?", (id,)
        ).map_err(|e| e.to_string())?;

        let (author_id, mod_key, cat) = match mod_row {
            Some(r) => r,
            None => return Ok(ApiResponse::err("Mod not found")),
        };

        let user_permissions = get_user_permissions(conn, id, user_id)?;
        let can_edit = user_permissions["can_edit_mod_info"].as_bool().unwrap_or(false)
            || user_permissions["can_edit_all_langs"].as_bool().unwrap_or(false)
            || user_permissions["editable_langs"].as_array().map(|a| !a.is_empty()).unwrap_or(false);

        if author_id != user_id && !can_edit {
            return Ok(ApiResponse::err("You don't have permission to edit this mod"));
        }

        let perm_config: serde_json::Value = {
            let perm_row: Option<(String, Option<String>, bool, bool, Option<String>)> = conn.exec_first(
                "SELECT mode, open_langs, allow_mod_info, allow_lang, apply_langs FROM mod_permissions WHERE mod_id = ?",
                (id,),
            ).map_err(|e| e.to_string())?;
            match perm_row {
                Some((m, ol, ami, al, al2)) => {
                    let open_langs: Vec<String> = ol.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
                    let apply_langs: Vec<String> = al2.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
                    serde_json::json!({
                        "mode": m, "open_langs": open_langs,
                        "allow_mod_info": ami, "allow_lang": al, "apply_langs": apply_langs,
                    })
                }
                None => serde_json::json!({
                    "mode": "author_only", "open_langs": [],
                    "allow_mod_info": true, "allow_lang": true, "apply_langs": [],
                }),
            }
        };

        let mut translations: Vec<serde_json::Value> = Vec::new();
        conn.exec_map(
            "SELECT lang_code, name, description, instructions, instructions_format, changelog, version FROM mod_translations WHERE mod_id = ?",
            (id,),
            |row: Row| {
                let r: Vec<Value> = row.unwrap();
                translations.push(serde_json::json!({
                    "lang": val_to_string(r[0].clone()),
                    "name": val_to_string(r[1].clone()),
                    "description": val_to_string(r[2].clone()),
                    "instructions": val_to_string(r[3].clone()),
                    "instructions_format": val_to_string(r[4].clone()),
                    "changelog": val_to_string(r[5].clone()),
                    "version": val_to_string(r[6].clone()),
                }));
            }
        ).map_err(|e| e.to_string())?;

        let mut files: Vec<serde_json::Value> = Vec::new();
        conn.exec_map(
            "SELECT lang_code, file_url, file_name, file_size, file_hash, version, created_at, manifest FROM mod_files WHERE mod_id = ?", (id,),
            |row: Row| {
                let r: Vec<Value> = row.unwrap();
                files.push(serde_json::json!({
                    "lang_code": val_to_string(r[0].clone()),
                    "file_url": val_to_string(r[1].clone()),
                    "file_name": val_to_string(r[2].clone()),
                    "file_size": val_to_i64(&r[3]),
                    "file_hash": match r[4].clone() { Value::Bytes(b) if !b.is_empty() => Some(String::from_utf8_lossy(&b).to_string()), _ => None },
                    "version": val_to_string(r[5].clone()),
                    "created_at": val_to_string(r[6].clone()),
                    "manifest": val_to_string(r[7].clone()),
                }));
            }
        ).map_err(|e| e.to_string())?;

        Ok(ApiResponse::ok_val(serde_json::json!({
            "id": id,
            "mod_key": mod_key,
            "category": cat,
            "files": files,
            "translations": translations,
            "user_permissions": user_permissions,
            "perm_config": perm_config,
        }), "OK"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_create_mod(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    mod_key: String,
    translations: Vec<serde_json::Value>,
    category: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let cat = category.unwrap_or_else(|| "v1".into());

        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE mod_id = ?", (&mod_key,)
        ).map_err(|e| e.to_string())?;
        if exists.is_some() {
            return Ok(ApiResponse::err("Mod key already exists"));
        }

        conn.exec_drop(
            "INSERT INTO mods (author_id, mod_id, category) VALUES (?, ?, ?)",
            (author_id, &mod_key, &cat),
        ).map_err(|e| e.to_string())?;

        let new_id = conn.last_insert_id();

        for t in &translations {
            let lc = t.get("lang_code").and_then(|v| v.as_str()).unwrap_or("zh");
            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let instr = t.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
            let instr_fmt = t.get("instructions_format").and_then(|v| v.as_str()).unwrap_or("markdown");
            let changelog = t.get("changelog").and_then(|v| v.as_str()).unwrap_or("");
            let t_ver = t.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0");
            conn.exec_drop(
                "INSERT INTO mod_translations (mod_id, lang_code, name, description, instructions, instructions_format, changelog, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (new_id, lc, name, desc, instr, instr_fmt, changelog, t_ver),
            ).map_err(|e| e.to_string())?;
        }

        Ok(ApiResponse::ok_val(serde_json::json!({"mod_id": new_id}), "Mod created"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_update_mod(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
    category: Option<String>,
    translations: Vec<serde_json::Value>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let perm = get_user_permissions(conn, mod_id, author_id)?;
        let can_edit_mod_info = perm["can_edit_mod_info"].as_bool().unwrap_or(false);
        let can_edit_all_langs = perm["can_edit_all_langs"].as_bool().unwrap_or(false);

        if !can_edit_mod_info && !can_edit_all_langs {
            return Ok(ApiResponse::err("You don't have permission to edit this mod"));
        }

        if can_edit_mod_info {
            if let Some(cat) = &category {
                conn.exec_drop("UPDATE mods SET category = ? WHERE id = ?", (cat, mod_id))
                    .map_err(|e| e.to_string())?;
            }
        }

        let editable_langs = perm["editable_langs"].as_array().map(|a| {
            a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>()
        });

        for t in &translations {
            let lc = t.get("lang_code").and_then(|v| v.as_str()).unwrap_or("zh");

            if !can_edit_all_langs {
                let allowed = editable_langs.as_ref()
                    .map(|langs| langs.contains(&lc.to_string()))
                    .unwrap_or(false);
                if !allowed {
                    continue;
                }
            }

            let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let instr = t.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
            let instr_fmt = t.get("instructions_format").and_then(|v| v.as_str()).unwrap_or("markdown");
            let changelog = t.get("changelog").and_then(|v| v.as_str()).unwrap_or("");
            let t_ver = t.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0");

            let existing: Option<(u64,)> = conn.exec_first(
                "SELECT id FROM mod_translations WHERE mod_id = ? AND lang_code = ?",
                (mod_id, lc),
            ).map_err(|e| e.to_string())?;

            if existing.is_some() {
                conn.exec_drop(
                    "UPDATE mod_translations SET name = ?, description = ?, instructions = ?, instructions_format = ?, changelog = ?, version = ? WHERE mod_id = ? AND lang_code = ?",
                    (name, desc, instr, instr_fmt, changelog, t_ver, mod_id, lc),
                ).map_err(|e| e.to_string())?;
            } else {
                conn.exec_drop(
                    "INSERT INTO mod_translations (mod_id, lang_code, name, description, instructions, instructions_format, changelog, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (mod_id, lc, name, desc, instr, instr_fmt, changelog, t_ver),
                ).map_err(|e| e.to_string())?;
            }

            conn.exec_drop(
                "UPDATE mod_files SET version = ? WHERE mod_id = ? AND lang_code = ?",
                (t_ver, mod_id, lc),
            ).map_err(|e| e.to_string())?;
        }

        Ok(ApiResponse::ok_msg("Mod updated"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_check_mod_key(
    state: tauri::State<'_, DbState>,
    mod_key: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE mod_id = ?",
            (&mod_key,),
        ).map_err(|e| e.to_string())?;
        Ok(ApiResponse::ok_val(serde_json::json!({
            "exists": exists.is_some()
        }), "OK"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_mod(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;

        match owner {
            Some((aid,)) if aid == author_id => {
                let mut tx = conn.start_transaction(TxOpts::default()).map_err(|e| e.to_string())?;

                tx.exec_drop("DELETE FROM mod_notifications WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_comments WHERE mod_id = ? AND parent_id IS NOT NULL", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_comments WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_collaborators WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_permissions WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_files WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_translations WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_likes WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_images WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM download_logs WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM edit_applications WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM user_favorites WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM user_ratings WHERE mod_id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.exec_drop("DELETE FROM mod_dependencies WHERE mod_id = ? OR dependency_mod_id = ?", (mod_id, mod_id))
                    .map_err(|e| e.to_string())?;

                tx.exec_drop("DELETE FROM mods WHERE id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;

                Ok(ApiResponse::ok_msg("Mod deleted"))
            }
            Some(_) => Ok(ApiResponse::err("You can only delete your own mods")),
            None => Ok(ApiResponse::err("Mod not found")),
        }
    }).await
}
