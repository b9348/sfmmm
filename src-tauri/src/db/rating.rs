use mysql::prelude::*;
use mysql::*;

use crate::db::{val_to_i64, with_conn, ApiResponse, DbState};

// ── 幂等 schema 兜底（兼容旧库/服务端未迁移）──────────────────────

/// 幂等确保 mod_ratings 表存在（兼容服务端尚未建表）。
pub(crate) fn ensure_mod_ratings_table<C: Queryable>(conn: &mut C) -> Result<(), String> {
    conn.exec_drop(
        "CREATE TABLE IF NOT EXISTS mod_ratings (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            mod_id BIGINT UNSIGNED NOT NULL,
            user_id BIGINT UNSIGNED NOT NULL,
            rating DECIMAL(2,1) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_mod_user (mod_id, user_id)
        )",
        (),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 幂等确保 mods 含评分冗余列（兼容旧库）。
/// 已存在时忽略 "Duplicate column" 错误；其余错误向上传播。
pub(crate) fn ensure_mod_rating_columns<C: Queryable>(conn: &mut C) -> Result<(), String> {
    for stmt in [
        "ALTER TABLE mods ADD COLUMN rating_avg DECIMAL(3,2) NOT NULL DEFAULT 0.00",
        "ALTER TABLE mods ADD COLUMN rating_count INT NOT NULL DEFAULT 0",
    ] {
        match conn.exec_drop(stmt, ()) {
            Ok(_) => {}
            Err(e) => {
                let msg = e.to_string();
                if msg.to_lowercase().contains("duplicate column") {
                    continue;
                }
                return Err(format!("无法确保 mods 评分列: {}", msg));
            }
        }
    }
    Ok(())
}

/// 幂等确保评分相关 schema 全部就绪（建表 + 冗余列）。
pub(crate) fn ensure_rating_schema<C: Queryable>(conn: &mut C) -> Result<(), String> {
    ensure_mod_ratings_table(conn)?;
    ensure_mod_rating_columns(conn)?;
    Ok(())
}

// ── 评分逻辑 ───────────────────────────────────────────────────

/// 校验评分合法性：0.5 ~ 5.0，0.5 步进，共 10 档。
fn validate_rating(rating: f64) -> Result<f64, String> {
    if !(0.5..=5.0).contains(&rating) {
        return Err("评分必须在 0.5 ~ 5.0 之间".into());
    }
    let rounded = (rating * 2.0).round() / 2.0;
    if (rounded - rating).abs() > 1e-6 {
        return Err("评分必须是 0.5 的倍数".into());
    }
    Ok(rounded)
}

/// 将 mysql Value 解析为 f64（AVG 等返回 DECIMAL，可能以字节串形式出现）。
pub(crate) fn val_to_f64(v: &Value) -> f64 {
    match v {
        Value::Float(f) => *f as f64,
        Value::Double(d) => *d,
        Value::Int(i) => *i as f64,
        Value::UInt(u) => *u as f64,
        Value::Bytes(b) => String::from_utf8_lossy(b).trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// 读取某模组的均分与人数（AVG 对空集返回 NULL）。
fn read_rating_stats(conn: &mut PooledConn, mod_id: u64) -> Result<(f64, i64), String> {
    let row: Option<Row> = conn
        .exec_first(
            "SELECT AVG(rating), COUNT(*) FROM mod_ratings WHERE mod_id = ?",
            (mod_id,),
        )
        .map_err(|e| e.to_string())?;
    match row {
        Some(r) => {
            let vals: Vec<Value> = r.unwrap();
            let avg = if matches!(vals[0], Value::NULL) { 0.0 } else { val_to_f64(&vals[0]) };
            let cnt = val_to_i64(&vals[1]);
            Ok((avg, cnt))
        }
        None => Ok((0.0, 0)),
    }
}

/// 重算某模组评分统计并写回 mods 冗余列（与写操作同一事务内调用）。
fn recalc_rating(conn: &mut PooledConn, mod_id: u64) -> Result<(), String> {
    let (avg, cnt) = read_rating_stats(conn, mod_id)?;
    conn.exec_drop(
        "UPDATE mods SET rating_avg = ?, rating_count = ? WHERE id = ?",
        (avg, cnt, mod_id),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Tauri 命令 ─────────────────────────────────────────────────

/// 评分 / 改评：同一用户对同一模组仅一条记录（UNIQUE(mod_id, user_id)）。
/// 首次评分时通知作者；改评只更新分数不重复通知。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_rate_mod(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    user_id: u64,
    rating: f64,
) -> Result<ApiResponse, String> {
    let rating = validate_rating(rating)?;
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        ensure_rating_schema(conn)?;
        crate::db::ensure_mod_updated_at_semantics(conn)?;

        let mod_exists: Option<(u64,)> = conn
            .exec_first("SELECT id FROM mods WHERE id = ?", (mod_id,))
            .map_err(|e| e.to_string())?;
        if mod_exists.is_none() {
            return Ok(ApiResponse::err("Mod not found"));
        }

        // 是否首次评分（用于决定是否通知作者）
        let existing: Option<(u64,)> = conn
            .exec_first(
                "SELECT id FROM mod_ratings WHERE mod_id = ? AND user_id = ?",
                (mod_id, user_id),
            )
            .map_err(|e| e.to_string())?;

        conn.exec_drop(
            "INSERT INTO mod_ratings (mod_id, user_id, rating) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE rating = VALUES(rating)",
            (mod_id, user_id, rating),
        )
        .map_err(|e| e.to_string())?;
        recalc_rating(conn, mod_id)?;

        let (avg, cnt) = read_rating_stats(conn, mod_id)?;
        Ok(ApiResponse::ok_val(
            serde_json::json!({
                "my_rating": rating,
                "rating_avg": avg,
                "rating_count": cnt,
            }),
            "Rated",
        ))
    })
    .await
}

/// 撤销评分：删除记录并重算均分/人数。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_unrate_mod(
    state: tauri::State<'_, DbState>,
    mod_id: u64,
    user_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        ensure_rating_schema(conn)?;
        crate::db::ensure_mod_updated_at_semantics(conn)?;

        let existing: Option<(u64,)> = conn
            .exec_first(
                "SELECT id FROM mod_ratings WHERE mod_id = ? AND user_id = ?",
                (mod_id, user_id),
            )
            .map_err(|e| e.to_string())?;
        if existing.is_none() {
            return Ok(ApiResponse::err("Not rated yet"));
        }

        conn.exec_drop(
            "DELETE FROM mod_ratings WHERE mod_id = ? AND user_id = ?",
            (mod_id, user_id),
        )
        .map_err(|e| e.to_string())?;
        recalc_rating(conn, mod_id)?;

        let (avg, cnt) = read_rating_stats(conn, mod_id)?;
        Ok(ApiResponse::ok_val(
            serde_json::json!({
                "my_rating": 0.0,
                "rating_avg": avg,
                "rating_count": cnt,
            }),
            "Unrated",
        ))
    })
    .await
}
