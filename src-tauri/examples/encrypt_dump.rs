//! 批量加密导出（一次性）：从数据库读出现有值 → 本地 AES-256-GCM 加密 →
//! 生成单个 .sql 文件（ALTER 拓宽列 + username_key 列 + 批量 CASE-UPDATE），
//! 交给 mysql CLI 一次性导入，避免逐行网络 UPDATE 触发 90s 软超时。
//!
//! 处理逻辑与 db/crypto.rs 的 migrate_legacy_encrypt 完全一致（det 用于 username/mod_id，
//! str 用于其余文本），已加密（enc1: 前缀）的行先解密回明文再重新加密，幂等。
//!
//! 运行方式（在 src-tauri 目录下）：
//! ```sh
//! cargo run --example encrypt_dump
//! ```
//! 生成 `.sqlbak/encrypt_bulk_<时间戳>.sql`，随后用 mysql CLI 导入。
use app_lib::db::crypto::{decrypt_str, encrypt_det, encrypt_str, is_encrypted};
use mysql::{prelude::*, Conn, Opts, OptsBuilder, SslOpts};
use std::time::Duration;

fn load_env() -> (String, String) {
    if option_env!("DB_URL").is_none() || option_env!("DB_ENC_KEY").is_none() {
        let env_path = format!("{}/.env", env!("CARGO_MANIFEST_DIR"));
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                if let Some((k, v)) = line.split_once('=') {
                    let (key, val) = (k.trim(), v.trim());
                    if std::env::var(key).is_err() && (key == "DB_URL" || key == "DB_ENC_KEY") {
                        std::env::set_var(key, val);
                    }
                }
            }
        }
    }
    (
        std::env::var("DB_URL").expect("DB_URL 未设置"),
        std::env::var("DB_ENC_KEY").expect("DB_ENC_KEY 未设置"),
    )
}

/// TLS 判断：优先显式配置（`DB_TLS` / `DB_TLS1`，与运行时 `DB_TLS1` 语义一致），
/// 未配置时沿用按强制 TLS 域名兜底的老行为，避免工具静默连不上。
fn tls_required(db_url: &str) -> bool {
    for key in ["DB_TLS", "DB_TLS1"] {
        match std::env::var(key).ok().as_deref().map(str::trim) {
            Some("1") | Some("true") | Some("TRUE") => return true,
            Some("0") | Some("false") | Some("FALSE") => return false,
            _ => {}
        }
    }
    db_url.contains("tidbcloud.com")
}

/// SQL 字符串字面量转义（MySQL 反斜杠转义模式）
fn sql_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\0' => out.push_str("\\0"),
            '\u{1a}' => out.push_str("\\Z"),
            _ => out.push(c),
        }
    }
    out
}

/// 一行数据：id + 若干文本列
struct Row {
    id: u64,
    cols: Vec<String>,
}

fn read_table(conn: &mut Conn, table: &str, cols: &[&str]) -> Vec<Row> {
    let sql = format!("SELECT id, {} FROM {}", cols.join(", "), table);
    let n = cols.len();
    conn.query_map(sql, move |mut row: mysql::Row| {
        let id: u64 = row.take(0).expect("id 列缺失");
        let vals: Vec<String> = (1..=n)
            .map(|i| {
                row.take::<Option<String>, _>(i)
                    .unwrap_or(None)
                    .unwrap_or_default()
            })
            .collect();
        Row { id, cols: vals }
    })
    .expect("读取失败")
}

/// 生成 `SET col = CASE id WHEN ? THEN '密文' ... END` 片段
fn case_set(col: &str, pairs: &[(u64, String)]) -> String {
    let whens: Vec<String> = pairs
        .iter()
        .map(|(id, v)| format!("WHEN {} THEN '{}'", id, sql_escape(v)))
        .collect();
    format!("{} = CASE id {} END", col, whens.join(" "))
}

/// 按 100 行一批 / 单语句 ≤ 900KB 切块，生成批量 UPDATE
fn chunk_rows(rows: &[(u64, String)], ncols: usize) -> Vec<Vec<(u64, String)>> {
    let mut batches = Vec::new();
    let mut cur: Vec<(u64, String)> = Vec::new();
    let mut size = 0usize;
    let flush = |cur: &mut Vec<(u64, String)>, size: &mut usize, batches: &mut Vec<Vec<(u64, String)>>| {
        if !cur.is_empty() {
            batches.push(std::mem::take(cur));
            *size = 0;
        }
    };
    for (id, v) in rows {
        // 每行成本按密文长度 × 列数估算，单语句限制 ~900KB
        let cost = v.len() * ncols + 64;
        if cur.len() >= 100 || size + cost > 900_000 {
            flush(&mut cur, &mut size, &mut batches);
        }
        size += cost;
        cur.push((*id, v.clone()));
    }
    flush(&mut cur, &mut size, &mut batches);
    batches
}

/// det 加密列的唯一索引冲突处理：重复值组（明文大小写变体在 unicode_ci 索引下撞车）整组跳过并上报
fn drop_det_conflicts(v: &mut Vec<(u64, String)>, label: &str) {
    let mut count: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for (_, val) in v.iter() {
        if !val.is_empty() { *count.entry(val.as_str()).or_insert(0) += 1; }
    }
    let conflicted: Vec<u64> = v
        .iter()
        .filter(|(_, val)| !val.is_empty() && count[val.as_str()] > 1)
        .map(|(id, _)| *id)
        .collect();
    if !conflicted.is_empty() {
        println!("[冲突] {label} 发现 {} 个重复值行，已跳过加密：{:?}", conflicted.len(), conflicted);
        v.retain(|(id, _)| !conflicted.contains(id));
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (db_url, _enc_key) = load_env();

    // 直连（不经 ManagedPool，无 90s 软超时）；强制 TLS 的线路见 tls_required
    let mut builder = OptsBuilder::from_opts(Opts::from_url(&db_url)?);
    if tls_required(&db_url) {
        builder = builder.ssl_opts(Some(SslOpts::default())).prefer_socket(false);
    }
    let opts: Opts = builder
        .tcp_connect_timeout(Some(Duration::from_secs(30)))
        .read_timeout(Some(Duration::from_secs(600)))
        .write_timeout(Some(Duration::from_secs(600)))
        .into();
    let mut conn = Conn::new(opts)?;
    conn.query_drop("SET SESSION time_zone = '+00:00'")?;

    // 1. 读出全部目标数据
    println!("读取数据...");
    let users = read_table(&mut conn, "users", &["username"]);
    let mods = read_table(&mut conn, "mods", &["mod_id"]);
    let translations = read_table(
        &mut conn,
        "mod_translations",
        &["name", "description", "instructions", "changelog"],
    );
    let comments = read_table(&mut conn, "mod_comments", &["content"]);
    let files = read_table(&mut conn, "mod_files", &["file_name", "manifest"]);
    let apps = read_table(&mut conn, "edit_applications", &["reason"]);
    println!(
        "users={} mods={} translations={} comments={} files={} apps={}",
        users.len(),
        mods.len(),
        translations.len(),
        comments.len(),
        files.len(),
        apps.len()
    );

    // 2. 本地加密（enc1: 先解密回明文再加密，保证幂等；空值跳过与原迁移一致）
    let enc_det = |rows: &[Row], i: usize| -> Vec<(u64, String)> {
        rows.iter()
            .map(|r| {
                let plain = if is_encrypted(&r.cols[i]) { decrypt_str(&r.cols[i]) } else { r.cols[i].clone() };
                let v = if plain.is_empty() { String::new() } else { encrypt_det(&plain).unwrap() };
                (r.id, v)
            })
            .collect()
    };
    let enc_str = |rows: &[Row], i: usize| -> Vec<(u64, String)> {
        rows.iter()
            .map(|r| {
                let plain = if is_encrypted(&r.cols[i]) { decrypt_str(&r.cols[i]) } else { r.cols[i].clone() };
                let v = if plain.is_empty() { String::new() } else { encrypt_str(&plain).unwrap() };
                (r.id, v)
            })
            .collect()
    };
    let users_enc: Vec<(u64, String)> = users.iter()
        .map(|r| {
            let plain = if is_encrypted(&r.cols[0]) { decrypt_str(&r.cols[0]) } else { r.cols[0].clone() };
            let v = if plain.is_empty() { String::new() } else { encrypt_det(&plain).unwrap() };
            (r.id, v)
        })
        .collect();
    let users_key: Vec<(u64, String)> = users.iter()
        .map(|r| {
            let plain = if is_encrypted(&r.cols[0]) { decrypt_str(&r.cols[0]) } else { r.cols[0].clone() };
            let v = if plain.is_empty() { String::new() } else { encrypt_det(&plain.to_lowercase()).unwrap() };
            (r.id, v)
        })
        .collect();
    let (users_enc, users_key) = {
        let mut enc = users_enc;
        let mut key = users_key;
        // username_key 是唯一索引（登录查重键）：冲突组（大小写变体重名）整组跳过加密并上报，
        // 与 decrypt_rollback 的冲突策略一致；username 列唯一索引已在 TiDB 端移除（密文下无意义）
        let mut seen: std::collections::HashMap<&String, u64> = std::collections::HashMap::new();
        let mut conflicted: std::collections::HashSet<u64> = std::collections::HashSet::new();
        for (id, v) in &key {
            if v.is_empty() { continue; }
            match seen.get(v) {
                Some(_) => { conflicted.insert(*id); }
                None => { seen.insert(v, *id); }
            }
        }
        // 第二遍：标记所有重复组成员
        let mut count: std::collections::HashMap<&String, usize> = std::collections::HashMap::new();
        for (_, v) in &key { if !v.is_empty() { *count.entry(v).or_insert(0) += 1; } }
        for (id, v) in &key {
            if !v.is_empty() && count[v] > 1 { conflicted.insert(*id); }
        }
        if !conflicted.is_empty() {
            println!("[冲突] users.username_key 发现 {} 个重名冲突行，已跳过加密（保持原样）：", conflicted.len());
            for r in &users {
                if conflicted.contains(&r.id) {
                    println!("  users.id={} username={:?}", r.id, r.cols[0]);
                }
            }
            enc.retain(|(id, _)| !conflicted.contains(id));
            key.retain(|(id, _)| !conflicted.contains(id));
        }
        (enc, key)
    };
    let mods_enc = {
        let mut v = enc_det(&mods, 0);
        drop_det_conflicts(&mut v, "mods.mod_id");
        v
    };
    let t_name = enc_str(&translations, 0);
    let t_desc = enc_str(&translations, 1);
    let t_instr = enc_str(&translations, 2);
    let t_changelog = enc_str(&translations, 3);
    let f_name = enc_str(&files, 0);
    let f_manifest = enc_str(&files, 1);
    let c_content = enc_str(&comments, 0);
    let a_reason = enc_str(&apps, 0);

    // 3. 生成 .sql（schema 治理 + 批量 CASE-UPDATE）
    let mut sql = String::from(
        "SET NAMES utf8mb4;\n\
         SET SESSION sql_mode = '';\n\
         ALTER TABLE users MODIFY username varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '用户名，字母数字';\n\
         ALTER TABLE mods MODIFY mod_id varchar(400) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Mod唯一标识符';\n\
         ALTER TABLE mod_translations MODIFY name varchar(1500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Mod名称';\n\
         ALTER TABLE mod_files MODIFY file_name varchar(1200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '文件名';\n\
         ALTER TABLE users ADD COLUMN IF NOT EXISTS username_key varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT '登录查找键(小写密文)';\n\
         ALTER TABLE users ADD INDEX IF NOT EXISTS uk_username_key (username_key);\n",
    );

    let mut stmts = 0usize;
    let mut emit = |sql: &mut String, table: &str, sets: Vec<(&str, &Vec<(u64, String)>)>, stmts: &mut usize| {
        // 同一表的多个列合并为按 id 对齐的批量更新：逐列切块后按 id 并集组成语句
        let n = sets.iter().map(|(_, v)| v.len()).max().unwrap_or(0);
        if n == 0 {
            return;
        }
        let idx: std::collections::HashMap<u64, usize> =
            sets[0].1.iter().enumerate().map(|(i, (id, _))| (*id, i)).collect();
        // 主列按块切，其它列按相同 id 顺序对齐（各列行集相同，均来自同一表全量读取）
        let chunks = chunk_rows(sets[0].1, sets.len());
        for chunk in chunks {
            let ids: Vec<u64> = chunk.iter().map(|(id, _)| *id).collect();
            let id_list: Vec<String> = ids.iter().map(|i| i.to_string()).collect();
            let set_sql: Vec<String> = sets
                .iter()
                .map(|(col, vals)| {
                    let map: std::collections::HashMap<u64, &String> =
                        vals.iter().map(|(id, v)| (*id, v)).collect();
                    let pairs: Vec<(u64, String)> = ids
                        .iter()
                        .map(|id| {
                            let v = map.get(id).copied().or_else(|| {
                                vals.iter().find(|(vid, _)| vid == id).map(|(_, v)| v)
                            });
                            (*id, v.cloned().unwrap_or_default())
                        })
                        .collect();
                    case_set(col, &pairs)
                })
                .collect();
            sql.push_str(&format!(
                "UPDATE {} SET {} WHERE id IN ({});\n",
                table,
                set_sql.join(", "),
                id_list.join(",")
            ));
            *stmts += 1;
        }
        let _ = idx;
    };

    emit(&mut sql, "users", vec![("username", &users_enc), ("username_key", &users_key)], &mut stmts);
    emit(&mut sql, "mods", vec![("mod_id", &mods_enc)], &mut stmts);
    emit(&mut sql, "mod_translations", vec![("name", &t_name), ("description", &t_desc), ("instructions", &t_instr), ("changelog", &t_changelog)], &mut stmts);
    emit(&mut sql, "mod_comments", vec![("content", &c_content)], &mut stmts);
    emit(&mut sql, "mod_files", vec![("file_name", &f_name), ("manifest", &f_manifest)], &mut stmts);
    emit(&mut sql, "edit_applications", vec![("reason", &a_reason)], &mut stmts);

    let path = format!(
        "{}/.sqlbak/encrypt_bulk_{}.sql",
        env!("CARGO_MANIFEST_DIR").replace("\\src-tauri", ""),
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    std::fs::write(&path, &sql)?;
    let mb = std::fs::metadata(&path)?.len() as f64 / 1048576.0;
    println!("生成完成: {path}（{mb:.1}MB，{stmts} 条 UPDATE）");
    Ok(())
}
