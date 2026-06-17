use mysql::prelude::*;
use mysql::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

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

        // 构建搜索条件
        let (where_sql, mut params): (String, Vec<Value>) = if let Some(ref s) = search {
            let p = format!("%{}%", s);
            ("WHERE (m.mod_id LIKE ? OR m.id IN (SELECT mod_id FROM mod_translations WHERE name LIKE ? OR description LIKE ?))".into(),
             vec![p.clone().into(), p.clone().into(), p.into()])
        } else {
            (String::new(), vec![])
        };

        // 总数
        let count_sql = format!("SELECT COUNT(DISTINCT m.id) FROM mods m {}", where_sql);
        let total: i64 = conn.exec_first(&count_sql, params.clone()).map_err(|e| e.to_string())?
            .unwrap_or(0i64);

        // 分页查询 — 使用位置索引
        let query_sql = format!(
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version, m.version) as version, m.category, m.download_count,
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
                "SELECT mod_id, lang_code, file_url, file_name, file_size, file_hash, version, created_at FROM mod_files WHERE mod_id IN ({})",
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
                });
                files_by_mod.entry(mid).or_default().push(fj);
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
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version, m.version) as version, m.category, m.download_count,
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
                "SELECT mod_id, lang_code, file_url, file_name, file_size, file_hash, version, created_at FROM mod_files WHERE mod_id IN ({})",
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
                });
                files_by_mod.entry(mid).or_default().push(fj);
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
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let lang = lang.filter(|s| !s.is_empty()).unwrap_or_else(|| "en".into());

        let row: Option<Row> = conn.exec_first(
            "SELECT m.id, m.mod_id, COALESCE(mt_t.version, mt_en.version, m.version) as version, m.category, m.download_count,
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
                    "SELECT lang_code, file_url, file_name, file_size, file_hash, version, created_at FROM mod_files WHERE mod_id = ?", (id,),
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
                        }));
                    }
                ).map_err(|e| e.to_string())?;

                let mid = val_to_i64(&vals[0]) as u64;
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
    author_id: u64,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        // 检查作者
        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mods WHERE id = ?", (id,)
        ).map_err(|e| e.to_string())?;

        match owner {
            Some((aid,)) if aid == author_id => {
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

                // 获取 mod 基本信息
                let info: Option<(String, String, String,)> = conn.exec_first(
                    "SELECT mod_id, version, category FROM mods WHERE id = ?", (id,)
                ).map_err(|e| e.to_string())?;

                match info {
                    Some((mk, _ver, cat)) => Ok(ApiResponse::ok_val(serde_json::json!({
                        "id": id,
                        "mod_key": mk,
                        "category": cat,
                        "translations": translations,
                    }), "OK")),
                    None => Ok(ApiResponse::err("Mod not found")),
                }
            }
            Some(_) => Ok(ApiResponse::err("You can only edit your own mods")),
            None => Ok(ApiResponse::err("Mod not found")),
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_create_mod(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    mod_key: String,
    translations: Vec<serde_json::Value>,
    version: Option<String>,
    category: Option<String>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let ver = version.unwrap_or_else(|| "1.0.0".into());
        let cat = category.unwrap_or_else(|| "v1".into());

        // 检查 mod_key 是否已存在
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE mod_id = ?", (&mod_key,)
        ).map_err(|e| e.to_string())?;
        if exists.is_some() {
            return Ok(ApiResponse::err("Mod key already exists"));
        }

        conn.exec_drop(
            "INSERT INTO mods (author_id, mod_id, version, category) VALUES (?, ?, ?, ?)",
            (author_id, &mod_key, &ver, &cat),
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
            let t_ver = t.get("version").and_then(|v| v.as_str()).unwrap_or(&ver);
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
    version: Option<String>,
    category: Option<String>,
    translations: Vec<serde_json::Value>,
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;

        // 验证作者
        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;

        match owner {
            Some((aid,)) if aid == author_id => {
                if let Some(ver) = &version {
                    conn.exec_drop("UPDATE mods SET version = ? WHERE id = ?", (ver, mod_id))
                        .map_err(|e| e.to_string())?;
                }
                if let Some(cat) = &category {
                    conn.exec_drop("UPDATE mods SET category = ? WHERE id = ?", (cat, mod_id))
                        .map_err(|e| e.to_string())?;
                }

                // 更新翻译（UPSERT）
                for t in &translations {
                    let lc = t.get("lang_code").and_then(|v| v.as_str()).unwrap_or("zh");
                    let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let desc = t.get("description").and_then(|v| v.as_str()).unwrap_or("");
                    let instr = t.get("instructions").and_then(|v| v.as_str()).unwrap_or("");
                    let instr_fmt = t.get("instructions_format").and_then(|v| v.as_str()).unwrap_or("markdown");
                    let changelog = t.get("changelog").and_then(|v| v.as_str()).unwrap_or("");
                    let t_ver = t.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0");

                    // 先检查是否存在
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

                    // 同步更新 mod_files 中对应语言文件的版本
                    conn.exec_drop(
                        "UPDATE mod_files SET version = ? WHERE mod_id = ? AND lang_code = ?",
                        (t_ver, mod_id, lc),
                    ).map_err(|e| e.to_string())?;
                }

                Ok(ApiResponse::ok_msg("Mod updated"))
            }
            Some(_) => Ok(ApiResponse::err("You can only edit your own mods")),
            None => Ok(ApiResponse::err("Mod not found")),
        }
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
) -> Result<ApiResponse, String> {
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        let ver = version.unwrap_or_else(|| "1.0.0".into());

        // 验证作者
        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;

        match owner {
            Some((aid,)) if aid == author_id => {
                // UPSERT
                let existing: Option<(u64,)> = conn.exec_first(
                    "SELECT id FROM mod_files WHERE mod_id = ? AND lang_code = ?",
                    (mod_id, &lang_code),
                ).map_err(|e| e.to_string())?;

                if existing.is_some() {
                    conn.exec_drop(
                        "UPDATE mod_files SET file_url = ?, file_name = ?, file_size = ?, file_hash = ?, version = ? WHERE mod_id = ? AND lang_code = ?",
                        (&file_url, &file_name, file_size, &file_hash, &ver, mod_id, &lang_code),
                    ).map_err(|e| e.to_string())?;
                } else {
                    conn.exec_drop(
                        "INSERT INTO mod_files (mod_id, lang_code, file_url, file_name, file_size, file_hash, version) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (mod_id, &lang_code, &file_url, &file_name, file_size, &file_hash, &ver),
                    ).map_err(|e| e.to_string())?;
                }

                Ok(ApiResponse::ok_val(serde_json::json!({
                    "lang_code": lang_code,
                    "file_url": file_url,
                    "file_name": file_name,
                    "file_size": file_size,
                    "file_hash": file_hash,
                    "version": ver,
                }), "File saved"))
            }
            Some(_) => Ok(ApiResponse::err("You can only upload files for your own mods")),
            None => Ok(ApiResponse::err("Mod not found")),
        }
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
        let mod_exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM mods WHERE id = ?", (mod_id,)
        ).map_err(|e| e.to_string())?;
        if mod_exists.is_none() {
            return Ok(ApiResponse::err("Mod not found"));
        }

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
/// 参数：installed = [{ mod_key: "xxx", installed_version: "1.0.0" }, ...]
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

            if mod_key.is_empty() { continue; }

            let latest: Option<(String,)> = conn.exec_first(
                "SELECT version FROM mods WHERE mod_id = ? ORDER BY id DESC LIMIT 1",
                (mod_key,),
            ).map_err(|e| e.to_string())?;

            let latest_ver = latest.map(|v| v.0).unwrap_or_default();
            let has_update = !latest_ver.is_empty() && latest_ver != installed_ver;

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
