use mysql::prelude::*;
use mysql::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

// 单个应用实例最多占用 1 个 MySQL 连接，闲置时不保留连接
const DB_POOL_MIN: usize = 0;
const DB_POOL_MAX: usize = 1;

// 语义版本比较：返回 -1, 0, 1
fn semver_cmp(a: &str, b: &str) -> i32 {
    let parse = |s: &str| -> Vec<u32> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| p.parse::<u32>().ok())
            .collect()
    };
    let pa = parse(a);
    let pb = parse(b);
    for i in 0..pa.len().max(pb.len()) {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va < vb { return -1; }
        if va > vb { return 1; }
    }
    0
}

// ── 数据库配置 ─────────────────────────────────────────────
// 优先读 .env 文件或环境变量，找不到则用硬编码默认值
fn db_url() -> String {
    // 生产环境：查找 exe 同目录下的 .env
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let env_path = dir.join(".env");
            if env_path.exists() {
                dotenvy::from_path(&env_path).ok();
            }
        }
    }
    // 开发环境：工作目录下的 .env
    dotenvy::dotenv().ok();
    std::env::var("DB_URL").expect("DB_URL 未设置：请在 exe 同目录或 src-tauri/.env 中配置数据库连接")
}

pub struct DbState {
    pub pool: Pool,
}

impl DbState {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let opts = Opts::from_url(&db_url())?;
        // 限制连接池大小，避免单个客户端占用过多 MySQL 连接
        let pool_opts = opts
            .get_pool_opts()
            .clone()
            .with_constraints(PoolConstraints::new(DB_POOL_MIN, DB_POOL_MAX).unwrap_or_default());
        let opts: Opts = OptsBuilder::from_opts(opts).pool_opts(pool_opts).into();
        let pool = Pool::new(opts)?;
        Ok(Self { pool })
    }
}

// ── 响应结构体 ──────────────────────────────────────────────

#[derive(Serialize)]
pub struct ApiResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mods: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<u64>,
}

impl ApiResponse {
    fn ok_val(data: serde_json::Value, msg: &str) -> Self {
        Self { success: true, message: msg.into(), data: Some(data), mods: None, total: None, page: None, page_size: None }
    }
    fn ok_msg(msg: &str) -> Self {
        Self { success: true, message: msg.into(), data: None, mods: None, total: None, page: None, page_size: None }
    }
    fn err(msg: &str) -> Self {
        Self { success: false, message: msg.into(), data: None, mods: None, total: None, page: None, page_size: None }
    }
    fn ok_list(mods: Vec<serde_json::Value>, total: i64, page: u64, page_size: u64) -> Self {
        Self { success: true, message: "OK".into(), data: None, mods: Some(mods), total: Some(total), page: Some(page), page_size: Some(page_size) }
    }
}

fn hash_password(password: &str) -> String {
    hex::encode(Sha256::digest(password.as_bytes()))
}

/// 将 MySQL Value 转成字符串（用于 TIMESTAMP / DATE 等）
fn val_to_string(v: Value) -> String {
    match v {
        Value::Date(y, m, d, h, mi, s, _) => format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, h, mi, s),
        Value::Bytes(b) => String::from_utf8_lossy(&b).to_string(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(d) => d.to_string(),
        _ => String::new(),
    }
}

/// 从 mysql::Value 提取 i64
fn val_to_i64(v: &Value) -> i64 {
    match v {
        Value::Int(i) => *i,
        Value::UInt(u) => *u as i64,
        Value::Float(f) => *f as i64,
        Value::Double(d) => *d as i64,
        _ => 0,
    }
}

// ── 权限辅助 ──────────────────────────────────────────────

/// 查询用户对某个 mod 的编辑权限
/// 返回 JSON: { is_author, can_edit_mod_info, can_edit_all_langs, editable_langs, can_apply_mod_info, can_apply_lang, applyable_langs, mode }
fn get_user_permissions<C: Queryable>(
    conn: &mut C,
    mod_id: u64,
    user_id: u64,
) -> Result<serde_json::Value, String> {
    let owner: Option<(u64,)> = conn.exec_first(
        "SELECT author_id FROM mods WHERE id = ?", (mod_id,)
    ).map_err(|e| e.to_string())?;
    let (author_id,) = owner.ok_or("Mod not found")?;

    let is_author = author_id == user_id;
    if is_author {
        return Ok(serde_json::json!({
            "is_author": true,
            "can_edit_mod_info": true,
            "can_edit_all_langs": true,
            "editable_langs": null,
            "can_apply_mod_info": false,
            "can_apply_lang": false,
            "applyable_langs": null,
            "mode": "author"
        }));
    }

    // 读取权限设置（不存在则默认仅作者）
    let perm: Option<(String, Option<String>, bool, bool, Option<String>)> = conn.exec_first(
        "SELECT mode, open_langs, allow_mod_info, allow_lang, apply_langs FROM mod_permissions WHERE mod_id = ?",
        (mod_id,)
    ).map_err(|e| e.to_string())?;

    let (mode, open_langs_json, allow_mod_info, allow_lang, apply_langs_json) = match perm {
        Some(p) => p,
        None => return Ok(serde_json::json!({
            "is_author": false,
            "can_edit_mod_info": false,
            "can_edit_all_langs": false,
            "editable_langs": null,
            "can_apply_mod_info": false,
            "can_apply_lang": false,
            "applyable_langs": null,
            "mode": "author_only"
        })),
    };

    // 查询协作者记录
    let mut collab_rows: Vec<Vec<Value>> = Vec::new();
    conn.exec_map(
        "SELECT scope, target_lang FROM mod_collaborators WHERE mod_id = ? AND user_id = ?",
        (mod_id, user_id),
        |row: Row| { collab_rows.push(row.unwrap()); }
    ).map_err(|e| e.to_string())?;

    let mut can_edit_info = false;
    let mut can_edit_all_langs = false;
    let mut editable_langs: Vec<String> = Vec::new();

    for row in &collab_rows {
        let scope = val_to_string(row[0].clone());
        match scope.as_str() {
            "mod_info" => can_edit_info = true,
            "lang_all" => can_edit_all_langs = true,
            "lang_specific" => {
                let lang = val_to_string(row[1].clone());
                if !lang.is_empty() && !editable_langs.contains(&lang) {
                    editable_langs.push(lang);
                }
            }
            _ => {}
        }
    }

    match mode.as_str() {
        "open" => Ok(serde_json::json!({
            "is_author": false, "can_edit_mod_info": true, "can_edit_all_langs": true,
            "editable_langs": null, "can_apply_mod_info": false, "can_apply_lang": false,
            "applyable_langs": null, "mode": "open"
        })),
        "open_lang" => {
            let open_langs: Vec<String> = open_langs_json
                .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
                .unwrap_or_default();
            Ok(serde_json::json!({
                "is_author": false,
                "can_edit_mod_info": can_edit_info,
                "can_edit_all_langs": open_langs.is_empty(),
                "editable_langs": if open_langs.is_empty() { serde_json::Value::Null } else { serde_json::json!(open_langs) },
                "can_apply_mod_info": false, "can_apply_lang": false,
                "applyable_langs": null, "mode": "open_lang"
            }))
        }
        "apply" | _ => {
            let apply_langs: Vec<String> = apply_langs_json
                .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
                .unwrap_or_default();
            Ok(serde_json::json!({
                "is_author": false,
                "can_edit_mod_info": can_edit_info,
                "can_edit_all_langs": can_edit_all_langs,
                "editable_langs": if editable_langs.is_empty() && !can_edit_all_langs {
                    serde_json::Value::Null
                } else if can_edit_all_langs {
                    serde_json::Value::Null
                } else {
                    serde_json::json!(editable_langs)
                },
                "can_apply_mod_info": allow_mod_info && !can_edit_info,
                "can_apply_lang": allow_lang && !can_edit_all_langs,
                "applyable_langs": if apply_langs.is_empty() { serde_json::Value::Null } else { serde_json::json!(apply_langs) },
                "mode": "apply"
            }))
        }
    }
}

// ── Tauri 命令 ──────────────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn db_login(
    state: tauri::State<'_, DbState>,
    username: String,
    password: String,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let pwd_hash = hash_password(&password);

        let row: Option<(u64, String)> = conn.exec_first(
            "SELECT id, username FROM users WHERE username = ? AND password_hash = ?",
            (&username, &pwd_hash),
        ).map_err(|e| e.to_string())?;

        match row {
            Some((id, uname)) => Ok(ApiResponse::ok_val(serde_json::json!({
                "user_id": id, "username": uname
            }), "Login successful")),
            None => Ok(ApiResponse::err("Invalid username or password")),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_register(
    state: tauri::State<'_, DbState>,
    username: String,
    password: String,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let uname = username.trim().to_string();
        if uname.len() < 2 || uname.len() > 32 {
            return Ok(ApiResponse::err("Username must be between 2 and 32 characters"));
        }
        if password.len() < 4 {
            return Ok(ApiResponse::err("Password must be at least 4 characters"));
        }

        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let pwd_hash = hash_password(&password);

        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM users WHERE username = ?", (&uname,)
        ).map_err(|e| e.to_string())?;

        if exists.is_some() {
            return Ok(ApiResponse::err("Username already exists"));
        }

        conn.exec_drop(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (&uname, &pwd_hash),
        ).map_err(|e| e.to_string())?;

        let new_id: u64 = conn.last_insert_id();
        Ok(ApiResponse::ok_val(serde_json::json!({
            "user_id": new_id, "username": uname
        }), "Registration successful"))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_mods(
    state: tauri::State<'_, DbState>,
    lang: Option<String>,
    search: Option<String>,
    page: Option<u64>,
    limit: Option<u64>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());
        let page = page.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(20).min(100);
        let offset = (page - 1) * limit;

        // 构建搜索条件：支持 mod_key、翻译名称、描述、语言代码模糊匹配
        let (where_sql, mut params): (String, Vec<Value>) = if let Some(ref s) = search {
            let p = format!("%{}%", s);
            ("WHERE (m.mod_id LIKE ? OR m.id IN (SELECT mod_id FROM mod_translations WHERE name LIKE ? OR description LIKE ? OR lang_code LIKE ?))".into(),
             vec![p.clone().into(), p.clone().into(), p.clone().into(), p.into()])
        } else {
            (String::new(), vec![])
        };

        // 总数
        let count_sql = format!("SELECT COUNT(DISTINCT m.id) FROM mods m {}", where_sql);
        let total: i64 = conn.exec_first(&count_sql, params.clone()).map_err(|e| e.to_string())?
            .unwrap_or(0i64);

        // 分页查询 — 使用位置索引
        let query_sql = format!(
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version) as version, m.category, m.download_count,
                    m.created_at, m.updated_at, u.username,
                    COALESCE(mt_t.name, mt_en.name, m.mod_id),
                    COALESCE(mt_t.description, mt_en.description, ''),
                    COALESCE(mt_t.instructions, mt_en.instructions, ''),
                    COALESCE(mt_t.instructions_format, mt_en.instructions_format, 'markdown'),
                    COALESCE(mt_t.changelog, mt_en.changelog, ''),
                    CASE WHEN mt_t.name IS NOT NULL THEN ? WHEN mt_en.name IS NOT NULL THEN 'en' ELSE 'default' END
             FROM mods m
             JOIN users u ON m.author_id = u.id
             LEFT JOIN mod_translations mt_t ON m.id = mt_t.mod_id AND mt_t.lang_code = ?
             LEFT JOIN mod_translations mt_en ON m.id = mt_en.mod_id AND mt_en.lang_code = 'en'
             {}
             ORDER BY m.created_at DESC
             LIMIT ? OFFSET ?",
            where_sql
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

        // 收集 mod_id → 文件
        let mod_ids: Vec<u64> = mod_rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let mut files_by_mod: std::collections::HashMap<u64, Vec<serde_json::Value>> = std::collections::HashMap::new();

        if !mod_ids.is_empty() {
            let ph: Vec<String> = mod_ids.iter().map(|_| "?".to_string()).collect();
            let file_sql = format!(
                "SELECT mod_id, lang_code, file_url, file_name, file_size, file_hash, version, created_at, manifest FROM mod_files WHERE mod_id IN ({})",
                ph.join(",")
            );
            let id_params: Vec<Value> = mod_ids.iter().map(|&id| Value::UInt(id)).collect();

            conn.exec_map(&file_sql, id_params, |row: Row| {
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
        }

        // 收集 mod_id → 翻译
        let mut trans_by_mod: std::collections::HashMap<u64, serde_json::Value> = std::collections::HashMap::new();
        if !mod_ids.is_empty() {
            let ph: Vec<String> = mod_ids.iter().map(|_| "?".to_string()).collect();
            let trans_sql = format!(
                "SELECT mod_id, lang_code, name, description, instructions, instructions_format, changelog, version FROM mod_translations WHERE mod_id IN ({})",
                ph.join(",")
            );
            let id_params: Vec<Value> = mod_ids.iter().map(|&id| Value::UInt(id)).collect();
            conn.exec_map(&trans_sql, id_params, |row: Row| {
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
        }

        let items: Vec<serde_json::Value> = mod_rows.into_iter().map(|r| {
            let mid = val_to_i64(&r[0]) as u64;
            serde_json::json!({
                "id": mid,
                "mod_key": val_to_string(r[1].clone()),
                "display_name": val_to_string(r[8].clone()),
                "description": val_to_string(r[9].clone()),
                "instructions": val_to_string(r[10].clone()),
                "instructions_format": val_to_string(r[11].clone()),
                "changelog": val_to_string(r[12].clone()),
                "category": val_to_string(r[3].clone()),
                "author_name": val_to_string(r[7].clone()),
                "download_count": val_to_i64(&r[4]),
                "language": val_to_string(r[13].clone()),
                "files": files_by_mod.remove(&mid).unwrap_or_default(),
                "translations": trans_by_mod.remove(&mid).unwrap_or_default(),
                "created_at": val_to_string(r[5].clone()),
                "updated_at": val_to_string(r[6].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, limit))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_my_mods(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    lang: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    // 复用 list 逻辑，追加 author_id 过滤
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).min(100);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mods WHERE author_id = ?", (author_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let query_sql = format!(
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version) as version, m.category, m.download_count,
                    m.created_at, m.updated_at, u.username,
                    COALESCE(mt_t.name, mt_en.name, m.mod_id),
                    COALESCE(mt_t.description, mt_en.description, ''),
                    COALESCE(mt_t.instructions, mt_en.instructions, ''),
                    COALESCE(mt_t.instructions_format, mt_en.instructions_format, 'markdown'),
                    COALESCE(mt_t.changelog, mt_en.changelog, ''),
                    CASE WHEN mt_t.name IS NOT NULL THEN ? WHEN mt_en.name IS NOT NULL THEN 'en' ELSE 'default' END
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

        // 收集 mod_id → 文件
        let mod_ids: Vec<u64> = mod_rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let mut files_by_mod: std::collections::HashMap<u64, Vec<serde_json::Value>> =
            std::collections::HashMap::new();

        if !mod_ids.is_empty() {
            let ph: Vec<String> = mod_ids.iter().map(|_| "?".to_string()).collect();
            let file_sql = format!(
                "SELECT mod_id, lang_code, file_url, file_name, file_size, file_hash, version, created_at, manifest FROM mod_files WHERE mod_id IN ({})",
                ph.join(",")
            );
            let id_params: Vec<Value> = mod_ids.iter().map(|&id| Value::UInt(id)).collect();

            conn.exec_map(&file_sql, id_params, |row: Row| {
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
        }

        // 收集 mod_id → 翻译
        let mut trans_by_mod: std::collections::HashMap<u64, serde_json::Value> = std::collections::HashMap::new();
        if !mod_ids.is_empty() {
            let ph: Vec<String> = mod_ids.iter().map(|_| "?".to_string()).collect();
            let trans_sql = format!(
                "SELECT mod_id, lang_code, name, description, instructions, instructions_format, changelog, version FROM mod_translations WHERE mod_id IN ({})",
                ph.join(",")
            );
            let id_params: Vec<Value> = mod_ids.iter().map(|&id| Value::UInt(id)).collect();
            conn.exec_map(&trans_sql, id_params, |row: Row| {
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
        }

        let items: Vec<serde_json::Value> = mod_rows.into_iter().map(|r| {
            let mid = val_to_i64(&r[0]) as u64;
            serde_json::json!({
                "id": mid,
                "mod_key": val_to_string(r[1].clone()),
                "display_name": val_to_string(r[8].clone()),
                "description": val_to_string(r[9].clone()),
                "category": val_to_string(r[3].clone()),
                "author_name": val_to_string(r[7].clone()),
                "download_count": val_to_i64(&r[4]),
                "files": files_by_mod.remove(&mid).unwrap_or_default(),
                "translations": trans_by_mod.remove(&mid).unwrap_or_default(),
                "created_at": val_to_string(r[5].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, page_size))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_mod_detail(
    state: tauri::State<'_, DbState>,
    id: u64,
    lang: Option<String>,
    user_id: Option<u64>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());

        let row: Option<Row> = conn.exec_first(
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version) as version, m.category, m.download_count,
                    m.created_at, m.updated_at, u.username,
                    COALESCE(mt_t.name, mt_en.name, m.mod_id),
                    COALESCE(mt_t.description, mt_en.description, ''),
                    COALESCE(mt_t.instructions, mt_en.instructions, ''),
                    COALESCE(mt_t.instructions_format, mt_en.instructions_format, 'markdown'),
                    COALESCE(mt_t.changelog, mt_en.changelog, ''),
                    CASE WHEN mt_t.name IS NOT NULL THEN ? WHEN mt_en.name IS NOT NULL THEN 'en' ELSE 'default' END
             FROM mods m
             JOIN users u ON m.author_id = u.id
             LEFT JOIN mod_translations mt_t ON m.id = mt_t.mod_id AND mt_t.lang_code = ?
             LEFT JOIN mod_translations mt_en ON m.id = mt_en.mod_id AND mt_en.lang_code = 'en'
             WHERE m.id = ?",
            (lang.clone(), lang.clone(), id),
        ).map_err(|e| e.to_string())?;

        match row {
            Some(row_data) => {
                let vals: Vec<Value> = row_data.unwrap();
                // 查文件
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

                let mid = val_to_i64(&vals[0]) as u64;

                // 收集该 mod 的所有翻译
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

                let user_permissions = if let Some(uid) = user_id {
                    get_user_permissions(&mut conn, mid, uid)?
                } else {
                    serde_json::json!({ "is_author": false, "can_edit_mod_info": false, "can_edit_all_langs": false, "editable_langs": null, "can_apply_mod_info": false, "can_apply_lang": false, "applyable_langs": null, "mode": "author_only" })
                };

                Ok(ApiResponse::ok_val(serde_json::json!({
                    "mod": {
                        "id": mid,
                        "mod_key": val_to_string(vals[1].clone()),
                        "display_name": val_to_string(vals[8].clone()),
                        "description": val_to_string(vals[9].clone()),
                        "instructions": val_to_string(vals[10].clone()),
                        "instructions_format": val_to_string(vals[11].clone()),
                        "changelog": val_to_string(vals[12].clone()),
                        "category": val_to_string(vals[3].clone()),
                        "author_name": val_to_string(vals[7].clone()),
                        "download_count": val_to_i64(&vals[4]),
                        "language": val_to_string(vals[13].clone()),
                        "files": files,
                        "created_at": val_to_string(vals[5].clone()),
                        "updated_at": val_to_string(vals[6].clone()),
                        "translations": translations,
                        "user_permissions": user_permissions,
                    }
                }), "OK"))
            }
            None => Ok(ApiResponse::err("Mod not found")),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_mod_for_edit(
    state: tauri::State<'_, DbState>,
    id: u64,
    user_id: u64,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        // 检查 mod 存在
        let mod_row: Option<(u64, String, String)> = conn.exec_first(
            "SELECT author_id, mod_id, category FROM mods WHERE id = ?", (id,)
        ).map_err(|e| e.to_string())?;

        let (author_id, mod_key, cat) = match mod_row {
            Some(r) => r,
            None => return Ok(ApiResponse::err("Mod not found")),
        };

        // 查权限
        let user_permissions = get_user_permissions(&mut conn, id, user_id)?;
        let can_edit = user_permissions["can_edit_mod_info"].as_bool().unwrap_or(false)
            || user_permissions["can_edit_all_langs"].as_bool().unwrap_or(false)
            || user_permissions["editable_langs"].as_array().map(|a| !a.is_empty()).unwrap_or(false);

        if author_id != user_id && !can_edit {
            return Ok(ApiResponse::err("You don't have permission to edit this mod"));
        }

        // 获取权限配置
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

        // 获取所有翻译
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

        // 获取文件
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
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_create_mod(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    mod_key: String,
    translations: Vec<serde_json::Value>,
    category: Option<String>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let cat = category.unwrap_or_else(|| "v1".into());

        // 检查 mod_key 是否已存在
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

        // 插入翻译
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
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_update_mod(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
    category: Option<String>,
    translations: Vec<serde_json::Value>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        // 权限校验
        let perm = get_user_permissions(&mut conn, mod_id, author_id)?;
        let can_edit_mod_info = perm["can_edit_mod_info"].as_bool().unwrap_or(false);
        let can_edit_all_langs = perm["can_edit_all_langs"].as_bool().unwrap_or(false);

        if !can_edit_mod_info && !can_edit_all_langs {
            return Ok(ApiResponse::err("You don't have permission to edit this mod"));
        }

        // 更新 mod 基本信息（仅 author 或 mod_info 协作者）
        if can_edit_mod_info {
            if let Some(cat) = &category {
                conn.exec_drop("UPDATE mods SET category = ? WHERE id = ?", (cat, mod_id))
                    .map_err(|e| e.to_string())?;
            }
        }

        // 更新翻译（检查每种语言是否有权限）
        let editable_langs = perm["editable_langs"].as_array().map(|a| {
            a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>()
        });

        for t in &translations {
            let lc = t.get("lang_code").and_then(|v| v.as_str()).unwrap_or("zh");

            // 如果没有全局语言权限，检查是否可编辑该特定语言
            if !can_edit_all_langs {
                let allowed = editable_langs.as_ref()
                    .map(|langs| langs.contains(&lc.to_string()))
                    .unwrap_or(false);
                if !allowed {
                    continue; // 跳过无权限的语言
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
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_check_mod_key(
    state: tauri::State<'_, DbState>,
    mod_key: String,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE mod_id = ?",
            (&mod_key,),
        ).map_err(|e| e.to_string())?;
        Ok(ApiResponse::ok_val(serde_json::json!({
            "exists": exists.is_some()
        }), "OK"))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_mod(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;

        match owner {
            Some((aid,)) if aid == author_id => {
                conn.exec_drop("DELETE FROM mods WHERE id = ?", (mod_id,))
                    .map_err(|e| e.to_string())?;
                Ok(ApiResponse::ok_msg("Mod deleted"))
            }
            Some(_) => Ok(ApiResponse::err("You can only delete your own mods")),
            None => Ok(ApiResponse::err("Mod not found")),
        }
    }).await.map_err(|e| e.to_string())?
}

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
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let ver = version.unwrap_or_else(|| "1.0.0".into());

        // 权限校验（作者或可编辑该语言的协作者）
        let perm = get_user_permissions(&mut conn, mod_id, author_id)?;
        let is_author = perm["is_author"].as_bool().unwrap_or(false);
        let can_edit_all_langs = perm["can_edit_all_langs"].as_bool().unwrap_or(false);
        let editable_langs = perm["editable_langs"].as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
            .unwrap_or_default();

        let can_edit_lang = is_author || can_edit_all_langs || editable_langs.contains(&lang_code);
        if !can_edit_lang {
            return Ok(ApiResponse::err("You don't have permission to upload files for this language"));
        }

        // UPSERT
        let existing: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mod_files WHERE mod_id = ? AND lang_code = ?",
            (mod_id, &lang_code),
        ).map_err(|e| e.to_string())?;

        if existing.is_some() {
            conn.exec_drop(
                "UPDATE mod_files SET file_url = ?, file_name = ?, file_size = ?, file_hash = ?, version = ?, manifest = ? WHERE mod_id = ? AND lang_code = ?",
                (&file_url, &file_name, file_size, &file_hash, &ver, &manifest, mod_id, &lang_code),
            ).map_err(|e| e.to_string())?;
        } else {
            conn.exec_drop(
                "INSERT INTO mod_files (mod_id, lang_code, file_url, file_name, file_size, file_hash, version, manifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (mod_id, &lang_code, &file_url, &file_name, file_size, &file_hash, &ver, &manifest),
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
        }), "File saved"))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_mod_file(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
    lang_code: String,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        // 权限校验
        let perm = get_user_permissions(&mut conn, mod_id, author_id)?;
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
    }).await.map_err(|e| e.to_string())?
}

// ── 评论系统 ──────────────────────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn db_add_comment(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    author_id: u64,
    content: String,
    parent_id: Option<u64>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let content = content.trim().to_string();

        if content.is_empty() || content.len() > 2000 {
            return Ok(ApiResponse::err("Comment must be between 1 and 2000 characters"));
        }

        // 验证 mod 存在
        let mod_exists: Option<(u64, u64)> = conn.exec_first(
            "SELECT id, author_id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;
        let mod_author_id = match mod_exists {
            Some((_, aid)) => aid,
            None => return Ok(ApiResponse::err("Mod not found")),
        };

        // 如果 parent_id 存在，验证它属于同一个 mod
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

        conn.exec_drop(
            "INSERT INTO mod_comments (mod_id, author_id, parent_id, content) VALUES (?, ?, ?, ?)",
            (mod_id, author_id, parent_id, &content),
        ).map_err(|e| e.to_string())?;

        let new_id = conn.last_insert_id();

        // 触发通知（如果不是给自己的 mod 评论）
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
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_comments(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(10).min(100); // 默认 10 楼
        let offset = (page - 1) * page_size;

        // 一楼总数
        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_comments WHERE mod_id = ? AND parent_id IS NULL", (mod_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        // 查一楼（parent IS NULL）
        let mut top_rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(
            "SELECT c.id, c.content, c.created_at, u.username
             FROM mod_comments c
             JOIN users u ON c.author_id = u.id
             WHERE c.mod_id = ? AND c.parent_id IS NULL
             ORDER BY c.created_at DESC
             LIMIT ? OFFSET ?",
            (mod_id, page_size as i64, offset as i64),
            |row: Row| { top_rows.push(row.unwrap()); },
        ).map_err(|e| e.to_string())?;

        // 对每个一楼：查回复总数 + 取前 2 条
        let items: Result<Vec<serde_json::Value>, String> = top_rows.into_iter().map(|r| {
            let cid = val_to_i64(&r[0]) as u64;

            // 回复总数
            let reply_count: i64 = conn.exec_first(
                "SELECT COUNT(*) FROM mod_comments WHERE parent_id = ?", (cid,)
            ).map_err(|e| e.to_string())?.unwrap_or(0i64);

            // 前 2 条回复
            let mut reply_rows: Vec<Vec<Value>> = Vec::new();
            conn.exec_map(
                "SELECT c.id, c.content, c.created_at, u.username
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
                    "content": val_to_string(rr[1].clone()),
                    "created_at": val_to_string(rr[2].clone()),
                    "author_name": val_to_string(rr[3].clone()),
                })
            }).collect();

            Ok(serde_json::json!({
                "id": cid,
                "content": val_to_string(r[1].clone()),
                "created_at": val_to_string(r[2].clone()),
                "author_name": val_to_string(r[3].clone()),
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
                "page": page,
                "page_size": page_size,
            })),
            mods: None,
            total: None,
            page: None,
            page_size: None,
        })
    }).await.map_err(|e| e.to_string())?
}

/// 加载更多楼中楼回复（分页，默认每页 10 条）
#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_replies(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(10).min(50);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_comments WHERE parent_id = ?", (comment_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        // 跳过前 2 条（因为 db_get_comments 已经返回了前 2 条）
        // 第一页的 offset 应该是 2，后续页正常翻
        let adjusted_offset = if page == 1 { 2u64 } else { 2 + offset };

        let mut rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(
            "SELECT c.id, c.content, c.created_at, u.username
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
                "content": val_to_string(r[1].clone()),
                "created_at": val_to_string(r[2].clone()),
                "author_name": val_to_string(r[3].clone()),
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
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_edit_comment(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    author_id: u64,
    content: String,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let content = content.trim().to_string();

        if content.is_empty() || content.len() > 2000 {
            return Ok(ApiResponse::err("Comment must be between 1 and 2000 characters"));
        }

        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mod_comments WHERE id = ?", (comment_id,)
        ).map_err(|e| e.to_string())?;

        match owner {
            Some((aid,)) if aid == author_id => {
                conn.exec_drop(
                    "UPDATE mod_comments SET content = ? WHERE id = ?",
                    (&content, comment_id),
                ).map_err(|e| e.to_string())?;
                Ok(ApiResponse::ok_val(serde_json::json!({
                    "comment_id": comment_id,
                    "content": content,
                }), "Comment updated"))
            }
            Some(_) => Ok(ApiResponse::err("You can only edit your own comments")),
            None => Ok(ApiResponse::err("Comment not found")),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_comment(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    author_id: u64,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mod_comments WHERE id = ?", (comment_id,)
        ).map_err(|e| e.to_string())?;

        match owner {
            Some((aid,)) if aid == author_id => {
                // 先删楼中楼再删自己
                conn.exec_drop("DELETE FROM mod_comments WHERE parent_id = ?", (comment_id,))
                    .map_err(|e| e.to_string())?;
                conn.exec_drop("DELETE FROM mod_comments WHERE id = ?", (comment_id,))
                    .map_err(|e| e.to_string())?;
                Ok(ApiResponse::ok_msg("Comment deleted"))
            }
            Some(_) => Ok(ApiResponse::err("You can only delete your own comments")),
            None => Ok(ApiResponse::err("Comment not found")),
        }
    }).await.map_err(|e| e.to_string())?
}

/// 检查已安装的工坊模组是否有更新
/// 参数：installed = [{ mod_key: "xxx", installed_version: "1.0.0", lang_code: "zh" }, ...]
#[tauri::command(rename_all = "snake_case")]
pub async fn db_check_updates(
    state: tauri::State<'_, DbState>,
    installed: Vec<serde_json::Value>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let mut results: Vec<serde_json::Value> = Vec::new();

        for item in &installed {
            let mod_key = item.get("mod_key").and_then(|v| v.as_str()).unwrap_or("");
            let installed_ver = item.get("installed_version").and_then(|v| v.as_str()).unwrap_or("0.0.0");
            let lang_code = item.get("lang_code").and_then(|v| v.as_str()).unwrap_or("zh");

            if mod_key.is_empty() { continue; }

            // 从 mod_translations 表获取对应语言的最新版本
            let latest: Option<(String,)> = conn.exec_first(
                "SELECT t.version FROM mod_translations t JOIN mods m ON t.mod_id = m.id WHERE m.mod_id = ? AND t.lang_code = ? ORDER BY t.id DESC LIMIT 1",
                (mod_key, lang_code),
            ).map_err(|e| e.to_string())?;

            let latest_ver = latest.map(|v| v.0).unwrap_or_default();
            let has_update = !latest_ver.is_empty() && semver_cmp(&latest_ver, &installed_ver) > 0;

            if has_update {
                results.push(serde_json::json!({
                    "mod_key": mod_key,
                    "installed_version": installed_ver,
                    "latest_version": latest_ver,
                }));
            }
        }

        Ok(ApiResponse::ok_val(serde_json::json!({
            "updates": results,
        }), "OK"))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_imgbed_config() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "url": "https://img.b9349.dpdns.org",
        "token": "imgbed_07c42496787100e0d269df984f727561fdeb01064a469ad78580c1b651cd571c"
    }))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_version(
    state: tauri::State<'_, DbState>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
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
    }).await.map_err(|e| e.to_string())?
}

/// 下载并静默安装更新
#[tauri::command]
pub async fn db_install_update(url: String) -> Result<String, String> {
    let response = reqwest::get(&url).await.map_err(|e| format!("下载失败: {}", e))?;
    let bytes = response.bytes().await.map_err(|e| format!("读取响应失败: {}", e))?;

    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join("sfmmm_update.exe");

    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("写入临时文件失败: {}", e))?;

    // 静默安装（NSIS /S 参数），安装器会等待安装完成后启动新版本
    std::process::Command::new(&installer_path)
        .arg("/S")
        .spawn()
        .map_err(|e| format!("启动安装程序失败: {}", e))?;

    Ok("安装程序已启动，应用将自动更新".into())
}

// ── 权限设置 ──────────────────────────────────────────────

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
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

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

        // UPSERT
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
    }).await.map_err(|e| e.to_string())?
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
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        // 检查 mod 是否存在
        let mod_exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;
        if mod_exists.is_none() {
            return Ok(ApiResponse::err("Mod not found"));
        }

        // 检查是否已有待处理的申请
        let pending: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM edit_applications WHERE mod_id = ? AND applicant_id = ? AND scope = ? AND (target_lang IS NULL OR target_lang = ?) AND status = 'pending'",
            (mod_id, user_id, &scope, &target_lang),
        ).map_err(|e| e.to_string())?;
        if pending.is_some() {
            return Ok(ApiResponse::err("You already have a pending application for this scope"));
        }

        let reason_str = reason.unwrap_or_default();
        conn.exec_drop(
            "INSERT INTO edit_applications (mod_id, applicant_id, scope, target_lang, reason, status) VALUES (?, ?, ?, ?, ?, 'pending')",
            (mod_id, user_id, &scope, &target_lang, &reason_str),
        ).map_err(|e| e.to_string())?;

        Ok(ApiResponse::ok_msg("Application submitted"))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_applications(
    state: tauri::State<'_, DbState>,
    mod_id: Option<u64>,
    user_id: Option<u64>,
    role: Option<String>,        // "author" | "applicant" | "all"
    status: Option<String>,       // "pending" | "approved" | "denied" | null = all
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).min(100);
        let offset = (page - 1) * page_size;

        let mut where_clauses: Vec<String> = Vec::new();
        let mut params: Vec<mysql::Value> = Vec::new();

        if let Some(mid) = mod_id {
            where_clauses.push(format!("a.mod_id = ?"));
            params.push(mysql::Value::UInt(mid));
        }
        if let Some(uid) = user_id {
            if role.as_deref() == Some("author") {
                // 用户是作者的 mods
                where_clauses.push(format!("m.author_id = ?"));
            } else {
                where_clauses.push(format!("a.applicant_id = ?"));
            }
            params.push(mysql::Value::UInt(uid));
        }
        if let Some(s) = status {
            if !s.is_empty() {
                where_clauses.push(format!("a.status = ?"));
                params.push(mysql::Value::Bytes(s.into_bytes()));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        // 总数
        let count_sql = format!(
            "SELECT COUNT(*) FROM edit_applications a JOIN mods m ON a.mod_id = m.id {}",
            where_sql
        );
        let total: i64 = conn.exec_first(&count_sql, params.clone())
            .map_err(|e| e.to_string())?.unwrap_or(0i64);

        // 查询列表
        let mut rows: Vec<Vec<Value>> = Vec::new();
        let query_sql = format!(
            "SELECT a.id, a.mod_id, m.mod_id as mod_key, a.applicant_id, u.username as applicant_name,
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
                "mod_key": val_to_string(r[2].clone()),
                "applicant_id": val_to_i64(&r[3]),
                "applicant_name": val_to_string(r[4].clone()),
                "scope": val_to_string(r[5].clone()),
                "target_lang": val_to_string(r[6].clone()),
                "reason": val_to_string(r[7].clone()),
                "status": val_to_string(r[8].clone()),
                "created_at": val_to_string(r[9].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, page_size))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_handle_application(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    app_id: u64,
    action: String, // "approve" | "deny"
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        // 获取申请信息
        let app: Option<(u64, u64, String, Option<String>)> = conn.exec_first(
            "SELECT mod_id, applicant_id, scope, target_lang FROM edit_applications WHERE id = ?",
            (app_id,),
        ).map_err(|e| e.to_string())?;

        let (mod_id, applicant_id, scope, target_lang) = match app {
            Some(a) => a,
            None => return Ok(ApiResponse::err("Application not found")),
        };

        // 验证操作者是 mod 作者
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

        // 更新状态
        conn.exec_drop(
            "UPDATE edit_applications SET status = ?, handled_by = ? WHERE id = ?",
            (db_status, author_id, app_id),
        ).map_err(|e| e.to_string())?;

        // 批准时自动创建 collaborator 记录
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
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_unread_count(
    state: tauri::State<'_, DbState>,
    user_id: u64,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        // 待处理的申请数（用户是作者）
        let pending_apps: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM edit_applications a JOIN mods m ON a.mod_id = m.id WHERE m.author_id = ? AND a.status = 'pending' AND a.is_read = 0",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        // 未读的通知数
        let unread_notifs: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM mod_notifications WHERE user_id = ? AND is_read = 0",
            (user_id,),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        Ok(ApiResponse::ok_val(serde_json::json!({
            "applications": pending_apps,
            "notifications": unread_notifs,
            "total": pending_apps + unread_notifs,
        }), "OK"))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_my_notifications(
    state: tauri::State<'_, DbState>,
    user_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
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
                    c.content as comment_content, u.username as comment_author
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
                "mod_key": val_to_string(r[2].clone()),
                "type": val_to_string(r[3].clone()),
                "comment_id": val_to_i64(&r[4]),
                "is_read": val_to_i64(&r[5]) != 0,
                "created_at": val_to_string(r[6].clone()),
                "content": val_to_string(r[7].clone()),
                "author_name": val_to_string(r[8].clone()),
            })
        }).collect();

        Ok(ApiResponse::ok_list(items, total, page, page_size))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_mark_read(
    state: tauri::State<'_, DbState>,
    user_id: u64,
    target_type: Option<String>, // "application" | "notification" | null = all
    ids: Option<Vec<u64>>,       // null = mark all as read
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

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
            // 全部标记已读
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
    }).await.map_err(|e| e.to_string())?
}
