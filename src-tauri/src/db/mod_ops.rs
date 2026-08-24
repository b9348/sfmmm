use mysql::prelude::*;
use mysql::*;

use crate::db::{decrypt_str, encrypt_det, encrypt_str, get_user_permissions, val_to_i64, val_to_string, with_conn, ApiResponse, DbState};

struct ModBatchData {
    files_by_mod: std::collections::HashMap<u64, Vec<serde_json::Value>>,
    trans_by_mod: std::collections::HashMap<u64, serde_json::Value>,
    likes_by_mod: std::collections::HashMap<u64, (i64, bool)>,
    comment_counts: std::collections::HashMap<u64, i64>,
    ratings_by_mod: std::collections::HashMap<u64, (f64, i64)>,
}

impl ModBatchData {
    fn collect(conn: &mut PooledConn, mod_ids: &[u64], device_id: Option<String>) -> Result<Self, String> {
        let mut files_by_mod: std::collections::HashMap<u64, Vec<serde_json::Value>> = std::collections::HashMap::new();
        let mut trans_by_mod: std::collections::HashMap<u64, serde_json::Value> = std::collections::HashMap::new();
        let mut likes_by_mod: std::collections::HashMap<u64, (i64, bool)> = std::collections::HashMap::new();
        let mut comment_counts: std::collections::HashMap<u64, i64> = std::collections::HashMap::new();
        let mut ratings_by_mod: std::collections::HashMap<u64, (f64, i64)> = std::collections::HashMap::new();

        if mod_ids.is_empty() {
            return Ok(Self { files_by_mod, trans_by_mod, likes_by_mod, comment_counts, ratings_by_mod });
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
                "file_name": decrypt_str(&val_to_string(vals[3].clone())),
                "file_size": val_to_i64(&vals[4]),
                "file_hash": match vals[5].clone() { Value::Bytes(b) if !b.is_empty() => Some(String::from_utf8_lossy(&b).to_string()), _ => None },
                "version": val_to_string(vals[6].clone()),
                "created_at": val_to_string(vals[7].clone()),
                "manifest": decrypt_str(&val_to_string(vals[8].clone())),
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
                    "name": decrypt_str(&val_to_string(vals[2].clone())),
                    "description": decrypt_str(&val_to_string(vals[3].clone())),
                    "instructions": decrypt_str(&val_to_string(vals[4].clone())),
                    "instructions_format": val_to_string(vals[5].clone()),
                    "changelog": decrypt_str(&val_to_string(vals[6].clone())),
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

        // 评分统计（均分 + 人数）。服务端尚未建 mod_ratings 表时容错为 0，避免旧库列表请求失败。
        let rating_sql = format!(
            "SELECT mod_id, AVG(rating), COUNT(*) FROM mod_ratings WHERE mod_id IN ({}) GROUP BY mod_id",
            ph.join(",")
        );
        match conn.exec_map(&rating_sql, &id_params, |row: Row| {
            let vals: Vec<Value> = row.unwrap();
            let mid = val_to_i64(&vals[0]) as u64;
            let avg = if matches!(vals[1], Value::NULL) { 0.0 } else { crate::db::rating::val_to_f64(&vals[1]) };
            let cnt = val_to_i64(&vals[2]);
            ratings_by_mod.insert(mid, (avg, cnt));
        }) {
            Ok(_) => {}
            Err(e) => {
                let msg = e.to_string().to_lowercase();
                if msg.contains("doesn't exist") || msg.contains("unknown table") || msg.contains("er_no_such_table") {
                    // mod_ratings 表尚未创建（服务端未迁移），跳过评分聚合
                } else {
                    return Err(e.to_string());
                }
            }
        }

        Ok(Self { files_by_mod, trans_by_mod, likes_by_mod, comment_counts, ratings_by_mod })
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
    sort_order: Option<String>,
    device_id: Option<String>,
    category: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());
        let page = page.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(20).min(100);
        let offset = (page - 1) * limit;
        let sort_by = sort_by.filter(|s| !s.is_empty()).unwrap_or_else(|| "created_at".into());
        // 时间正/倒序：sort_order = asc（旧→新）| desc（新→旧，默认）；
        // 其余指标排序（likes/rating）始终按数值降序，不受方向参数影响
        let sort_order = sort_order.filter(|s| s == "asc" || s == "desc").unwrap_or_else(|| "desc".into());
        let order_sql = match sort_by.as_str() {
            "likes" => "ORDER BY m.like_count DESC, m.created_at DESC",
            "rating" => "ORDER BY m.rating_avg DESC, m.rating_count DESC, m.created_at DESC",
            // 时间排序以「最近更新」为准（COALESCE 兜底未编辑项用创建时间），
            // 让编辑过的 item 排序靠前，作者无需重新发帖来置顶
            _ if sort_order == "asc" => "ORDER BY COALESCE(m.updated_at, m.created_at) ASC",
            _ => "ORDER BY COALESCE(m.updated_at, m.created_at) DESC",
        };

        let mut conditions: Vec<String> = Vec::new();
        let mut params: Vec<Value> = Vec::new();
        // 名称/描述/mod_key 已加密（enc1:...），无法在 SQL 中 LIKE；
        // 搜索时不加 needle 的 SQL 条件（仅 category 过滤），由下方 Rust 端解密后统一匹配
        let rust_search = search
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_lowercase());
        if let Some(ref c) = category {
            conditions.push("m.category = ?".into());
            params.push(c.clone().into());
        }
        let where_sql = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let search_mode = rust_search.is_some();
        let total: i64 = if search_mode {
            // 搜索时名称/描述为密文，总数需在 Rust 解密过滤后统计
            0
        } else {
            let count_sql = format!("SELECT COUNT(DISTINCT m.id) FROM mods m {}", where_sql);
            conn.exec_first(&count_sql, params.clone()).map_err(|e| e.to_string())?
                .unwrap_or(0i64)
        };

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
             {} {}",
            where_sql, order_sql,
            if search_mode { "" } else { "LIMIT ? OFFSET ?" }
        );

        let mut all_params: Vec<Value> = vec![lang.clone().into(), lang.clone().into()];
        all_params.append(&mut params);
        if !search_mode {
            all_params.push((limit as i64).into());
            all_params.push((offset as i64).into());
        }

        let mut mod_rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(&query_sql, all_params, |row: Row| {
            let vals: Vec<Value> = row.unwrap();
            mod_rows.push(vals);
        }).map_err(|e| e.to_string())?;

        // 搜索时名称/描述/mod_key 为密文，解密后在 Rust 端过滤（大小写不敏感，近似原 LIKE 语义），再分页。
        // 注：候选集为全部模组（当前规模数百级），全量解密可接受；数据量增长后可改为分批解密+ID 分页。
        if let Some(ref needle) = rust_search {
            mod_rows.retain(|r| {
                let key = decrypt_str(&val_to_string(r[1].clone())).to_lowercase();
                let name = decrypt_str(&val_to_string(r[9].clone())).to_lowercase();
                let desc = decrypt_str(&val_to_string(r[10].clone())).to_lowercase();
                key.contains(needle.as_str()) || name.contains(needle.as_str()) || desc.contains(needle.as_str())
            });
        }
        let total: i64 = if search_mode {
            mod_rows.len() as i64
        } else {
            total
        };
        let page_rows: Vec<Vec<Value>> = if search_mode {
            mod_rows.into_iter().skip(offset as usize).take(limit as usize).collect()
        } else {
            mod_rows
        };

        let mod_ids: Vec<u64> = page_rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let mut batch = ModBatchData::collect(conn, &mod_ids, device_id)?;

        let items: Vec<serde_json::Value> = page_rows.into_iter().map(|r| {
            let mid = val_to_i64(&r[0]) as u64;
            let (like_count, is_liked) = batch.likes_by_mod.get(&mid).copied().unwrap_or((0, false));
            let (rating_avg, rating_count) = batch.ratings_by_mod.get(&mid).copied().unwrap_or((0.0, 0));
            serde_json::json!({
                "id": mid,
                "mod_key": decrypt_str(&val_to_string(r[1].clone())),
                "display_name": decrypt_str(&val_to_string(r[9].clone())),
                "description": decrypt_str(&val_to_string(r[10].clone())),
                "instructions": decrypt_str(&val_to_string(r[11].clone())),
                "instructions_format": val_to_string(r[12].clone()),
                "changelog": decrypt_str(&val_to_string(r[13].clone())),
                "category": val_to_string(r[3].clone()),
                "author_name": decrypt_str(&val_to_string(r[8].clone())),
                "author_avatar": val_to_string(r[15].clone()),
                "author_id": val_to_i64(&r[16]),
                "download_count": val_to_i64(&r[4]),
                "like_count": like_count,
                "is_liked": is_liked,
                "comment_count": batch.comment_counts.get(&mid).copied().unwrap_or(0),
                "rating_avg": rating_avg,
                "rating_count": rating_count,
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
            let (rating_avg, rating_count) = batch.ratings_by_mod.get(&mid).copied().unwrap_or((0.0, 0));
            serde_json::json!({
                "id": mid,
                "mod_key": decrypt_str(&val_to_string(r[1].clone())),
                "display_name": decrypt_str(&val_to_string(r[9].clone())),
                "description": decrypt_str(&val_to_string(r[10].clone())),
                "category": val_to_string(r[3].clone()),
                "author_name": decrypt_str(&val_to_string(r[8].clone())),
                "author_avatar": val_to_string(r[15].clone()),
                "author_id": val_to_i64(&r[16]),
                "download_count": val_to_i64(&r[4]),
                "like_count": like_count,
                "is_liked": is_liked,
                "comment_count": batch.comment_counts.get(&mid).copied().unwrap_or(0),
                "rating_avg": rating_avg,
                "rating_count": rating_count,
                "files": batch.files_by_mod.remove(&mid).unwrap_or_default(),
                "translations": batch.trans_by_mod.remove(&mid).unwrap_or_default(),
                "created_at": val_to_string(r[5].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, page_size))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_liked_mods(
    state: tauri::State<'_, DbState>,
    device_id: Option<String>,
    lang: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let device_id = device_id.filter(|s| !s.is_empty()).unwrap_or_default();
        if device_id.is_empty() {
            return Ok(ApiResponse::err("Device ID is required"));
        }
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 100);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_likes WHERE device_id = ?", (&device_id,)
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
             FROM mod_likes ml
             JOIN mods m ON m.id = ml.mod_id
             JOIN users u ON m.author_id = u.id
             LEFT JOIN mod_translations mt_t ON m.id = mt_t.mod_id AND mt_t.lang_code = ?
             LEFT JOIN mod_translations mt_en ON m.id = mt_en.mod_id AND mt_en.lang_code = 'en'
             WHERE ml.device_id = ?
             ORDER BY ml.id DESC
             LIMIT ? OFFSET ?"
        );

        let mut mod_rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(&query_sql, vec![
            lang.clone().into(), lang.clone().into(),
            device_id.clone().into(),
            (page_size as i64).into(), (offset as i64).into(),
        ] as Vec<Value>, |row: Row| {
            mod_rows.push(row.unwrap());
        }).map_err(|e| e.to_string())?;

        let mod_ids: Vec<u64> = mod_rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let mut batch = ModBatchData::collect(conn, &mod_ids, Some(device_id))?;

        let items: Vec<serde_json::Value> = mod_rows.into_iter().map(|r| {
            let mid = val_to_i64(&r[0]) as u64;
            let (like_count, is_liked) = batch.likes_by_mod.get(&mid).copied().unwrap_or((0, false));
            let (rating_avg, rating_count) = batch.ratings_by_mod.get(&mid).copied().unwrap_or((0.0, 0));
            serde_json::json!({
                "id": mid,
                "mod_key": decrypt_str(&val_to_string(r[1].clone())),
                "display_name": decrypt_str(&val_to_string(r[9].clone())),
                "description": decrypt_str(&val_to_string(r[10].clone())),
                "instructions": decrypt_str(&val_to_string(r[11].clone())),
                "instructions_format": val_to_string(r[12].clone()),
                "changelog": decrypt_str(&val_to_string(r[13].clone())),
                "category": val_to_string(r[3].clone()),
                "author_name": decrypt_str(&val_to_string(r[8].clone())),
                "author_avatar": val_to_string(r[15].clone()),
                "author_id": val_to_i64(&r[16]),
                "download_count": val_to_i64(&r[4]),
                "like_count": like_count,
                "is_liked": is_liked,
                "comment_count": batch.comment_counts.get(&mid).copied().unwrap_or(0),
                "rating_avg": rating_avg,
                "rating_count": rating_count,
                "language": val_to_string(r[14].clone()),
                "files": batch.files_by_mod.remove(&mid).unwrap_or_default(),
                "translations": batch.trans_by_mod.remove(&mid).unwrap_or_default(),
                "created_at": val_to_string(r[6].clone()),
                "updated_at": val_to_string(r[7].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, page_size))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_rated_mods(
    state: tauri::State<'_, DbState>,
    user_id: u64,
    lang: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        // 幂等确保 mod_ratings 表存在，兼容服务端尚未迁移的旧库
        crate::db::rating::ensure_rating_schema(conn)?;

        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).clamp(1, 100);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_ratings WHERE user_id = ?", (user_id,)
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
                    u.avatar, u.id, mr.rating
             FROM mod_ratings mr
             JOIN mods m ON m.id = mr.mod_id
             JOIN users u ON m.author_id = u.id
             LEFT JOIN mod_translations mt_t ON m.id = mt_t.mod_id AND mt_t.lang_code = ?
             LEFT JOIN mod_translations mt_en ON m.id = mt_en.mod_id AND mt_en.lang_code = 'en'
             WHERE mr.user_id = ?
             ORDER BY mr.id DESC
             LIMIT ? OFFSET ?"
        );

        let mut mod_rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(&query_sql, vec![
            lang.clone().into(), lang.clone().into(),
            user_id.into(),
            (page_size as i64).into(), (offset as i64).into(),
        ] as Vec<Value>, |row: Row| {
            mod_rows.push(row.unwrap());
        }).map_err(|e| e.to_string())?;

        let mod_ids: Vec<u64> = mod_rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let mut batch = ModBatchData::collect(conn, &mod_ids, None)?;

        let items: Vec<serde_json::Value> = mod_rows.into_iter().map(|r| {
            let mid = val_to_i64(&r[0]) as u64;
            let (like_count, is_liked) = batch.likes_by_mod.get(&mid).copied().unwrap_or((0, false));
            let (rating_avg, rating_count) = batch.ratings_by_mod.get(&mid).copied().unwrap_or((0.0, 0));
            let my_rating = crate::db::rating::val_to_f64(&r[17]);
            serde_json::json!({
                "id": mid,
                "mod_key": decrypt_str(&val_to_string(r[1].clone())),
                "display_name": decrypt_str(&val_to_string(r[9].clone())),
                "description": decrypt_str(&val_to_string(r[10].clone())),
                "instructions": decrypt_str(&val_to_string(r[11].clone())),
                "instructions_format": val_to_string(r[12].clone()),
                "changelog": decrypt_str(&val_to_string(r[13].clone())),
                "category": val_to_string(r[3].clone()),
                "author_name": decrypt_str(&val_to_string(r[8].clone())),
                "author_avatar": val_to_string(r[15].clone()),
                "author_id": val_to_i64(&r[16]),
                "download_count": val_to_i64(&r[4]),
                "like_count": like_count,
                "is_liked": is_liked,
                "comment_count": batch.comment_counts.get(&mid).copied().unwrap_or(0),
                "rating_avg": rating_avg,
                "rating_count": rating_count,
                "my_rating": my_rating,
                "language": val_to_string(r[14].clone()),
                "files": batch.files_by_mod.remove(&mid).unwrap_or_default(),
                "translations": batch.trans_by_mod.remove(&mid).unwrap_or_default(),
                "created_at": val_to_string(r[6].clone()),
                "updated_at": val_to_string(r[7].clone()),
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
            (lang.clone(), lang.clone(), id, match &mod_key {
                Some(k) => encrypt_det(k)?,
                None => String::new(),
            }),
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
                            "file_name": decrypt_str(&val_to_string(r[2].clone())),
                            "file_size": val_to_i64(&r[3]),
                            "file_hash": match r[4].clone() { Value::Bytes(b) if !b.is_empty() => Some(String::from_utf8_lossy(&b).to_string()), _ => None },
                            "version": val_to_string(r[5].clone()),
                            "created_at": val_to_string(r[6].clone()),
                            "manifest": decrypt_str(&val_to_string(r[7].clone())),
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
                                "name": decrypt_str(&val_to_string(r[1].clone())),
                                "description": decrypt_str(&val_to_string(r[2].clone())),
                                "instructions": decrypt_str(&val_to_string(r[3].clone())),
                                "instructions_format": val_to_string(r[4].clone()),
                                "changelog": decrypt_str(&val_to_string(r[5].clone())),
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

                // 评分统计 + 我的评分（服务端未建 mod_ratings 表时容错为 0）
                let mut rating_avg: f64 = 0.0;
                let mut rating_count: i64 = 0;
                let mut my_rating: f64 = 0.0;
                if let Ok(Some(row)) = conn.exec_first::<Row, _, _>(
                    "SELECT AVG(rating), COUNT(*) FROM mod_ratings WHERE mod_id = ?",
                    (mid,),
                ) {
                    let vals: Vec<Value> = row.unwrap();
                    rating_avg = if matches!(vals[0], Value::NULL) { 0.0 } else { crate::db::rating::val_to_f64(&vals[0]) };
                    rating_count = val_to_i64(&vals[1]);
                }
                if let Some(uid) = user_id {
                    if let Ok(Some(row)) = conn.exec_first::<Row, _, _>(
                        "SELECT rating FROM mod_ratings WHERE mod_id = ? AND user_id = ?",
                        (mid, uid),
                    ) {
                        let vals: Vec<Value> = row.unwrap();
                        my_rating = crate::db::rating::val_to_f64(&vals[0]);
                    }
                }

                Ok(ApiResponse::ok_val(serde_json::json!({
                    "mod": {
                        "id": mid,
                        "mod_key": decrypt_str(&val_to_string(vals[1].clone())),
                        "display_name": decrypt_str(&val_to_string(vals[9].clone())),
                        "description": decrypt_str(&val_to_string(vals[10].clone())),
                        "instructions": decrypt_str(&val_to_string(vals[11].clone())),
                        "instructions_format": val_to_string(vals[12].clone()),
                        "changelog": decrypt_str(&val_to_string(vals[13].clone())),
                        "category": val_to_string(vals[3].clone()),
                        "author_name": decrypt_str(&val_to_string(vals[8].clone())),
                        "author_avatar": val_to_string(vals[15].clone()),
                        "author_id": val_to_i64(&vals[16]),
                        "download_count": val_to_i64(&vals[4]),
                        "like_count": like_count,
                        "is_liked": is_liked,
                        "rating_avg": rating_avg,
                        "rating_count": rating_count,
                        "my_rating": my_rating,
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
            Some((aid, mk, c)) => (aid, decrypt_str(&mk), c),
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
                    "name": decrypt_str(&val_to_string(r[1].clone())),
                    "description": decrypt_str(&val_to_string(r[2].clone())),
                    "instructions": decrypt_str(&val_to_string(r[3].clone())),
                    "instructions_format": val_to_string(r[4].clone()),
                    "changelog": decrypt_str(&val_to_string(r[5].clone())),
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
                    "file_name": decrypt_str(&val_to_string(r[2].clone())),
                    "file_size": val_to_i64(&r[3]),
                    "file_hash": match r[4].clone() { Value::Bytes(b) if !b.is_empty() => Some(String::from_utf8_lossy(&b).to_string()), _ => None },
                    "version": val_to_string(r[5].clone()),
                    "created_at": val_to_string(r[6].clone()),
                    "manifest": decrypt_str(&val_to_string(r[7].clone())),
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

        // mods.mod_id 列为 varchar(64)（按字符计），超长时 MySQL 会报 ERROR 1406，
        // 这里提前校验并返回友好错误；用 chars().count() 而非 len()，避免误杀多字节字符。
        if mod_key.chars().count() > 64 {
            return Ok(ApiResponse::err("mod_key 长度不能超过 64 个字符"));
        }

        let enc_mod_key = encrypt_det(&mod_key)?;
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE mod_id = ?", (&enc_mod_key,)
        ).map_err(|e| e.to_string())?;
        if exists.is_some() {
            return Ok(ApiResponse::err("Mod key already exists"));
        }

        // mod_key 原样加密（保真，与本地文件夹/安装记录一致）；大小写变体重名由
        // DB 的 utf8mb4_unicode_ci 唯一索引兜底，捕获 1062 转为友好错误；
        // 迁移前列宽不足（1406 data too long）同样转为友好提示
        if let Err(e) = conn.exec_drop(
            "INSERT INTO mods (author_id, mod_id, category) VALUES (?, ?, ?)",
            (author_id, &enc_mod_key, &cat),
        ) {
            let msg = e.to_string();
            let lower = msg.to_lowercase();
            if lower.contains("1062") || lower.contains("duplicate") {
                return Ok(ApiResponse::err("Mod key already exists"));
            }
            if lower.contains("1406") || lower.contains("data too long") {
                return Ok(ApiResponse::err("mod_key 密文超出列宽，请先执行加密迁移（cargo run --example migrate_encrypt）"));
            }
            return Err(msg);
        }

        let new_id = conn.last_insert_id();

        for t in &translations {
            let lc = t.get("lang_code").and_then(|v| v.as_str()).unwrap_or("zh");
            let raw_name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let raw_desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let raw_instr = t.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
            let raw_changelog = t.get("changelog").and_then(|v| v.as_str()).unwrap_or("");
            // 明文长度上限：确保密文能容纳于目标列宽（name≤255，文本类≤12000 字符）
            if raw_name.chars().count() > 255
                || raw_desc.chars().count() > 12000
                || raw_instr.chars().count() > 12000
                || raw_changelog.chars().count() > 12000
            {
                return Ok(ApiResponse::err("模组文本过长（name≤255 / 描述、说明、更新日志≤12000 字符）"));
            }
            let name = encrypt_str(raw_name)?;
            let desc = encrypt_str(raw_desc)?;
            let instr = encrypt_str(raw_instr)?;
            let instr_fmt = t.get("instructions_format").and_then(|v| v.as_str()).unwrap_or("markdown");
            let changelog = encrypt_str(raw_changelog)?;
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

        // 标记是否有实际编辑动作，用于最后刷新 updated_at（时间排序依此让编辑过的 item 靠前）
        let mut edited = false;

        if can_edit_mod_info {
            if let Some(cat) = &category {
                conn.exec_drop("UPDATE mods SET category = ? WHERE id = ?", (cat, mod_id))
                    .map_err(|e| e.to_string())?;
                edited = true;
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

            edited = true;

            let raw_name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let raw_desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
            let raw_instr = t.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
            let raw_changelog = t.get("changelog").and_then(|v| v.as_str()).unwrap_or("");
            // 明文长度上限：确保密文能容纳于目标列宽（name≤255，文本类≤12000 字符）
            if raw_name.chars().count() > 255
                || raw_desc.chars().count() > 12000
                || raw_instr.chars().count() > 12000
                || raw_changelog.chars().count() > 12000
            {
                return Ok(ApiResponse::err("模组文本过长（name≤255 / 描述、说明、更新日志≤12000 字符）"));
            }
            let name = encrypt_str(raw_name)?;
            let desc = encrypt_str(raw_desc)?;
            let instr = encrypt_str(raw_instr)?;
            let instr_fmt = t.get("instructions_format").and_then(|v| v.as_str()).unwrap_or("markdown");
            let changelog = encrypt_str(raw_changelog)?;
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

        // 编辑过即刷新 mods.updated_at，驱动「云」列表按最近更新排序（编辑项靠前）
        if edited {
            conn.exec_drop("UPDATE mods SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (mod_id,))
                .map_err(|e| e.to_string())?;
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
        let enc_mod_key = encrypt_det(&mod_key)?;
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE mod_id = ?",
            (&enc_mod_key,),
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
                tx.exec_drop("DELETE FROM mod_ratings WHERE mod_id = ?", (mod_id,))
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
