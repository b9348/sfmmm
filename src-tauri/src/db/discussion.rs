// 讨论区后端命令（MySQL）：帖子 / 投票 / Boost / 评论 / 我的历史
// 与 mod 体系完全独立：discussions / discussion_polls / discussion_poll_options /
// discussion_poll_votes / discussion_boosts / discussion_likes / discussion_comments
//
// 语义对齐：
// - Boost：每人对每帖 ≤1 条、内容 ≤16 字符，不提升排序（不触碰 updated_at）
// - 投票：一人一票，重投覆盖；results_visibility='on_vote' 时未投票者不返回结果
// - 内容加密存储（encrypt_str），读取时解密；标题/正文密文无法 SQL LIKE，列表搜索在 Rust 端解密过滤
// - updated_at 仅内容编辑时显式更新，互动（赞/boost/评论/投票）不刷新

use mysql::prelude::*;
use mysql::*;

use crate::db::{decrypt_str, encrypt_str, val_to_i64, val_to_string, with_conn, ApiResponse, DbState};

const MAX_BOOST_LEN: usize = 16;
const MAX_COMMENT_LEN: usize = 3000;
const MAX_TITLE_LEN: usize = 200;

// ────────────────────────────── 帖子 ──────────────────────────────

fn discussion_base_columns() -> &'static str {
    "d.id, d.title, d.content, d.content_format, d.type, d.status,
     d.like_count, d.boost_count, d.comment_count, d.created_at, d.updated_at,
     u.username, u.avatar, u.id"
}

fn build_discussion_json(
    vals: &[Value],
    is_liked: bool,
    is_boosted: bool,
    my_boost: Option<String>,
    poll: Option<serde_json::Value>,
) -> serde_json::Value {
    serde_json::json!({
        "id": val_to_i64(&vals[0]),
        "title": decrypt_str(&val_to_string(vals[1].clone())),
        "content": decrypt_str(&val_to_string(vals[2].clone())),
        "content_format": val_to_string(vals[3].clone()),
        "type": val_to_string(vals[4].clone()),
        "status": val_to_string(vals[5].clone()),
        "like_count": val_to_i64(&vals[6]),
        "boost_count": val_to_i64(&vals[7]),
        "comment_count": val_to_i64(&vals[8]),
        "created_at": val_to_string(vals[9].clone()),
        "updated_at": val_to_string(vals[10].clone()),
        "author_name": decrypt_str(&val_to_string(vals[11].clone())),
        "author_avatar": val_to_string(vals[12].clone()),
        "author_id": val_to_i64(&vals[13]),
        "is_liked": is_liked,
        "is_boosted": is_boosted,
        "my_boost": my_boost,
        "poll": poll,
    })
}

// 批量读取投票配置（列表页 N+1 防护）：返回 discussion_id -> poll 摘要
fn collect_polls_for_discussions(
    conn: &mut PooledConn,
    discussion_ids: &[u64],
) -> Result<std::collections::HashMap<u64, serde_json::Value>, String> {
    let mut map = std::collections::HashMap::new();
    if discussion_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = vec!["?"; discussion_ids.len()].join(",");
    let id_params: Vec<Value> = discussion_ids.iter().map(|&id| Value::UInt(id)).collect();

    // poll 配置
    let mut poll_rows: Vec<Vec<Value>> = Vec::new();
    conn.exec_map(
        &format!(
            "SELECT discussion_id, id, poll_type, min, max, step, results_visibility
             FROM discussion_polls WHERE discussion_id IN ({})",
            placeholders
        ),
        &id_params,
        |row: Row| { poll_rows.push(row.unwrap()); },
    ).map_err(|e| e.to_string())?;

    // 选项
    let mut opt_rows: Vec<Vec<Value>> = Vec::new();
    conn.exec_map(
        &format!(
            "SELECT o.poll_id, o.id, o.label
             FROM discussion_poll_options o
             JOIN discussion_polls p ON o.poll_id = p.id
             WHERE p.discussion_id IN ({})
             ORDER BY o.position ASC, o.id ASC",
            placeholders
        ),
        &id_params,
        |row: Row| { opt_rows.push(row.unwrap()); },
    ).map_err(|e| e.to_string())?;

    // 投票数
    let mut vote_rows: Vec<Vec<Value>> = Vec::new();
    conn.exec_map(
        &format!(
            "SELECT poll_id, COUNT(*) FROM discussion_poll_votes
             WHERE discussion_id IN ({}) GROUP BY poll_id",
            placeholders
        ),
        &id_params,
        |row: Row| { vote_rows.push(row.unwrap()); },
    ).map_err(|e| e.to_string())?;

    let mut votes_by_poll: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for v in vote_rows {
        votes_by_poll.insert(val_to_i64(&v[0]), val_to_i64(&v[1]));
    }

    let mut opts_by_poll: std::collections::HashMap<i64, Vec<serde_json::Value>> = std::collections::HashMap::new();
    for o in opt_rows {
        let pid = val_to_i64(&o[0]);
        opts_by_poll.entry(pid).or_default().push(serde_json::json!({
            "id": val_to_i64(&o[1]),
            "label": decrypt_str(&val_to_string(o[2].clone())),
        }));
    }

    for p in poll_rows {
        let discussion_id = val_to_i64(&p[0]);
        let poll_id = val_to_i64(&p[1]);
        map.insert(
            discussion_id as u64,
            serde_json::json!({
                "id": poll_id,
                "poll_type": val_to_string(p[2].clone()),
                "min": val_to_i64(&p[3]),
                "max": val_to_i64(&p[4]),
                "step": val_to_i64(&p[5]),
                "results_visibility": val_to_string(p[6].clone()),
                "options": opts_by_poll.get(&poll_id).cloned().unwrap_or_default(),
                "total_votes": votes_by_poll.get(&poll_id).copied().unwrap_or(0),
            }),
        );
    }
    Ok(map)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_discussions(
    state: tauri::State<'_, DbState>,
    page: Option<u64>,
    limit: Option<u64>,
    search: Option<String>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    d_type: Option<String>,
    user_id: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(20).min(100);
        let offset = (page - 1) * limit;
        let sort_by = sort_by.filter(|s| !s.is_empty()).unwrap_or_else(|| "created_at".into());
        // 时间正/倒序：sort_order = asc（旧→新）| desc（新→旧，默认）；
        // 其余指标排序（likes/boosts）始终按数值降序，不受方向参数影响
        let sort_order = sort_order.filter(|s| s == "asc" || s == "desc").unwrap_or_else(|| "desc".into());
        let order_sql = match sort_by.as_str() {
            "likes" => "ORDER BY d.like_count DESC, d.created_at DESC",
            "boosts" => "ORDER BY d.boost_count DESC, d.created_at DESC",
            // 按发布时间排序（纯 created_at，不受编辑刷新影响）
            "published_at" if sort_order == "asc" => "ORDER BY d.created_at ASC",
            "published_at" => "ORDER BY d.created_at DESC",
            // 默认/created_at：时间排序以「最近更新」为准（COALESCE 兜底未编辑项用创建时间），
            // 让编辑过的帖排序靠前，作者无需重新发帖来置顶
            _ if sort_order == "asc" => "ORDER BY COALESCE(d.updated_at, d.created_at) ASC",
            _ => "ORDER BY COALESCE(d.updated_at, d.created_at) DESC",
        };

        let mut conditions: Vec<String> = vec!["d.status = 'active'".into()];
        let mut params: Vec<Value> = Vec::new();
        if let Some(t) = d_type.filter(|s| s == "poll" || s == "regular") {
            conditions.push("d.type = ?".into());
            params.push(t.into());
        }

        let rust_search = search
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_lowercase());

        let where_sql = format!("WHERE {}", conditions.join(" AND "));

        // 标题为密文，无法 SQL LIKE；候选集解密后 Rust 端过滤（规模数百级可接受，与 mod_ops 同模式）
        let query_sql = format!(
            "SELECT {} FROM discussions d JOIN users u ON d.author_id = u.id {} {}",
            discussion_base_columns(),
            where_sql,
            if rust_search.is_some() { String::new() } else { format!("{} LIMIT ? OFFSET ?", order_sql) }
        );

        let mut all_params = params.clone();
        if rust_search.is_none() {
            all_params.push((limit as i64).into());
            all_params.push((offset as i64).into());
        }

        let mut rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(&query_sql, all_params, |row: Row| { rows.push(row.unwrap()); })
            .map_err(|e| e.to_string())?;

        if let Some(ref needle) = rust_search {
            rows.retain(|r| {
                decrypt_str(&val_to_string(r[1].clone())).to_lowercase().contains(needle.as_str())
                    || decrypt_str(&val_to_string(r[2].clone())).to_lowercase().contains(needle.as_str())
            });
        }
        let total = if rust_search.is_some() { rows.len() as i64 } else {
            let count_sql = format!("SELECT COUNT(*) FROM discussions d {}", where_sql);
            conn.exec_first(&count_sql, params.clone()).map_err(|e| e.to_string())?.unwrap_or(0i64)
        };
        let page_rows: Vec<Vec<Value>> = if rust_search.is_some() {
            rows.into_iter().skip(offset as usize).take(limit as usize).collect()
        } else {
            rows
        };

        let ids: Vec<u64> = page_rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let polls = collect_polls_for_discussions(conn, &ids)?;

        // 当前用户互动状态（点赞/boost 均按登录用户）
        let mut liked: std::collections::HashSet<u64> = std::collections::HashSet::new();
        let mut boosted: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
        if let Some(uid) = user_id {
            if !ids.is_empty() {
                let ph = vec!["?"; ids.len()].join(",");
                let mut like_params: Vec<Value> = vec![Value::UInt(uid)];
                like_params.extend(ids.iter().map(|&id| Value::UInt(id)));
                let mut lr: Vec<Vec<Value>> = Vec::new();
                conn.exec_map(
                    &format!("SELECT discussion_id FROM discussion_likes WHERE user_id = ? AND discussion_id IN ({})", ph),
                    like_params,
                    |row: Row| { lr.push(row.unwrap()); },
                ).map_err(|e| e.to_string())?;
                for r in lr { liked.insert(val_to_i64(&r[0]) as u64); }

                let mut boost_params: Vec<Value> = vec![Value::UInt(uid)];
                boost_params.extend(ids.iter().map(|&id| Value::UInt(id)));
                let mut br: Vec<Vec<Value>> = Vec::new();
                conn.exec_map(
                    &format!("SELECT discussion_id, content FROM discussion_boosts WHERE user_id = ? AND discussion_id IN ({})", ph),
                    boost_params,
                    |row: Row| { br.push(row.unwrap()); },
                ).map_err(|e| e.to_string())?;
                for r in br {
                    boosted.insert(val_to_i64(&r[0]) as u64, decrypt_str(&val_to_string(r[1].clone())));
                }
            }
        }

        let items: Vec<serde_json::Value> = page_rows.iter().map(|r| {
            let did = val_to_i64(&r[0]) as u64;
            let poll = polls.get(&did).cloned();
            build_discussion_json(
                r,
                liked.contains(&did),
                boosted.contains_key(&did),
                boosted.get(&did).cloned(),
                poll,
            )
        }).collect();

        Ok(ApiResponse {
            success: true,
            message: "OK".into(),
            data: Some(serde_json::json!({ "discussions": items, "total": total, "page": page, "page_size": limit })),
            mods: None,
            total: None,
            page: None,
            page_size: None,
        })
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_discussion_detail(
    state: tauri::State<'_, DbState>,
    id: u64,
    user_id: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let row: Option<Row> = conn.exec_first(
            &format!(
                "SELECT {} FROM discussions d JOIN users u ON d.author_id = u.id WHERE d.id = ? AND d.status = 'active'",
                discussion_base_columns()
            ),
            (id,),
        ).map_err(|e| e.to_string())?;

        let vals: Vec<Value> = match row {
            Some(r) => r.unwrap(),
            None => return Ok(ApiResponse::err("Discussion not found")),
        };
        let did = val_to_i64(&vals[0]) as u64;

        // 点赞 / boost 状态
        let is_liked: bool = if let Some(uid) = user_id {
            let exists: Option<(u64,)> = conn.exec_first(
                "SELECT id FROM discussion_likes WHERE discussion_id = ? AND user_id = ?", (did, uid),
            ).map_err(|e| e.to_string())?;
            exists.is_some()
        } else { false };

        let (is_boosted, my_boost) = if let Some(uid) = user_id {
            let b: Option<(String,)> = conn.exec_first(
                "SELECT content FROM discussion_boosts WHERE discussion_id = ? AND user_id = ?", (did, uid),
            ).map_err(|e| e.to_string())?;
            match b {
                Some((c,)) => (true, Some(decrypt_str(&c))),
                None => (false, None),
            }
        } else { (false, None) };

        // 投票配置 + 我的投票 + 结果（on_vote 且未投票时不返回结果）
        let poll: Option<serde_json::Value> = {
            let p: Option<(u64, String, Option<i64>, Option<i64>, Option<i64>, String)> = conn.exec_first(
                "SELECT id, poll_type, min, max, step, results_visibility FROM discussion_polls WHERE discussion_id = ?", (did,)
            ).map_err(|e| e.to_string())?;
            match p {
                Some((poll_id, poll_type, min, max, step, vis)) => {
                    let mut opts: Vec<serde_json::Value> = Vec::new();
                    conn.exec_map(
                        "SELECT id, label FROM discussion_poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC",
                        (poll_id,),
                        |row: Row| {
                            let r: Vec<Value> = row.unwrap();
                            opts.push(serde_json::json!({
                                "id": val_to_i64(&r[0]),
                                "label": decrypt_str(&val_to_string(r[1].clone())),
                            }));
                        },
                    ).map_err(|e| e.to_string())?;

                    // 我的投票
                    let my_vote: Option<serde_json::Value> = if let Some(uid) = user_id {
                        let v: Option<(Option<String>, Option<i64>)> = conn.exec_first(
                            "SELECT option_ids, value FROM discussion_poll_votes WHERE poll_id = ? AND user_id = ?",
                            (poll_id, uid),
                        ).map_err(|e| e.to_string())?;
                        v.map(|(oid, val)| serde_json::json!({
                            "option_ids": oid.and_then(|s| serde_json::from_str::<Vec<i64>>(&s).ok()).unwrap_or_default(),
                            "value": val,
                        }))
                    } else { None };

                    let has_voted = my_vote.is_some();
                    let results_visible = vis == "always" || has_voted;
                    let results = if results_visible {
                        collect_poll_results(conn, poll_id, &poll_type, &opts)?
                    } else { None };

                    Some(serde_json::json!({
                        "id": poll_id,
                        "poll_type": poll_type,
                        "min": min,
                        "max": max,
                        "step": step,
                        "results_visibility": vis,
                        "options": opts,
                        "my_vote": my_vote,
                        "has_voted": has_voted,
                        "results": results,
                        "results_hidden": !results_visible,
                    }))
                }
                None => None,
            }
        };

        // boost 列表
        let mut boosts: Vec<serde_json::Value> = Vec::new();
        conn.exec_map(
            "SELECT b.content, b.created_at, u.username, u.avatar, u.id
             FROM discussion_boosts b JOIN users u ON b.user_id = u.id
             WHERE b.discussion_id = ? ORDER BY b.created_at DESC LIMIT 50",
            (did,),
            |row: Row| {
                let r: Vec<Value> = row.unwrap();
                boosts.push(serde_json::json!({
                    "content": decrypt_str(&val_to_string(r[0].clone())),
                    "created_at": val_to_string(r[1].clone()),
                    "author_name": decrypt_str(&val_to_string(r[2].clone())),
                    "author_avatar": val_to_string(r[3].clone()),
                    "author_id": val_to_i64(&r[4]),
                }));
            },
        ).map_err(|e| e.to_string())?;

        let mut detail = build_discussion_json(&vals, is_liked, is_boosted, my_boost, poll);
        detail["boosts"] = serde_json::json!(boosts);

        Ok(ApiResponse::ok_val(serde_json::json!({ "discussion": detail }), "OK"))
    }).await
}

// 计算投票结果（single/multiple: 各选项票数+占比；number: 均值+分布）
fn collect_poll_results(
    conn: &mut PooledConn,
    poll_id: u64,
    poll_type: &str,
    options: &[serde_json::Value],
) -> Result<Option<serde_json::Value>, String> {
    let total: i64 = conn.exec_first(
        "SELECT COUNT(*) FROM discussion_poll_votes WHERE poll_id = ?", (poll_id,)
    ).map_err(|e| e.to_string())?.unwrap_or(0i64);

    if poll_type == "number" {
        let agg: Option<(Option<f64>, Option<i64>, Option<i64>)> = conn.exec_first(
            "SELECT AVG(value), MIN(value), MAX(value) FROM discussion_poll_votes WHERE poll_id = ? AND value IS NOT NULL",
            (poll_id,),
        ).map_err(|e| e.to_string())?;
        let (avg, min_v, max_v) = match agg { Some(a) => a, None => (None, None, None) };

        // 每个数字的投票数分布
        let mut dist: Vec<serde_json::Value> = Vec::new();
        conn.exec_map(
            "SELECT value, COUNT(*) FROM discussion_poll_votes WHERE poll_id = ? AND value IS NOT NULL GROUP BY value ORDER BY value ASC",
            (poll_id,),
            |row: Row| {
                let r: Vec<Value> = row.unwrap();
                dist.push(serde_json::json!({ "value": val_to_i64(&r[0]), "count": val_to_i64(&r[1]) }));
            },
        ).map_err(|e| e.to_string())?;

        return Ok(Some(serde_json::json!({
            "total_votes": total,
            "avg": avg,
            "min": min_v,
            "max": max_v,
            "distribution": dist,
            "options": [],
        })));
    }

    // 拉取全部投票的 option_ids（JSON 数组），Rust 端展开统计：
    // single 每票 1 个选项；multiple 每票可含多个选项，各计一次。
    // 不用 SQL JSON_EXTRACT 是因为它只取 $[0]，multiple 会漏计。
    let mut vote_rows: Vec<Vec<Value>> = Vec::new();
    conn.exec_map(
        "SELECT option_ids FROM discussion_poll_votes WHERE poll_id = ?",
        (poll_id,),
        |row: Row| { vote_rows.push(row.unwrap()); },
    ).map_err(|e| e.to_string())?;

    let mut count_map: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for r in &vote_rows {
        let json_str = val_to_string(r[0].clone());
        if let Ok(ids) = serde_json::from_str::<Vec<i64>>(&json_str) {
            for id in ids {
                *count_map.entry(id).or_insert(0) += 1;
            }
        }
    }

    let option_results: Vec<serde_json::Value> = options.iter().map(|o| {
        let oid = o["id"].as_i64().unwrap_or(0);
        let count = count_map.get(&oid).copied().unwrap_or(0);
        let percent = if total > 0 { (count as f64 * 100.0 / total as f64).round() } else { 0.0 };
        serde_json::json!({
            "id": oid,
            "label": o["label"],
            "count": count,
            "percent": percent,
        })
    }).collect();

    Ok(Some(serde_json::json!({
        "total_votes": total,
        "options": option_results,
        "avg": serde_json::Value::Null,
        "min": serde_json::Value::Null,
        "max": serde_json::Value::Null,
        "distribution": [],
    })))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_create_discussion(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    title: String,
    content: String,
    content_format: Option<String>,
    d_type: Option<String>,
    poll: Option<serde_json::Value>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let title = title.trim().to_string();
        let content = content.trim().to_string();
        if title.is_empty() || title.chars().count() > MAX_TITLE_LEN {
            return Ok(ApiResponse::err(&format!("Title must be 1-{} characters", MAX_TITLE_LEN)));
        }
        if content.is_empty() {
            return Ok(ApiResponse::err("Content is required"));
        }
        let d_type = d_type.filter(|s| s == "poll").unwrap_or_else(|| "regular".into());
        let content_format = content_format.filter(|s| s == "richtext").unwrap_or_else(|| "markdown".into());

        let enc_title = encrypt_str(&title)?;
        let enc_content = encrypt_str(&content)?;
        conn.exec_drop(
            "INSERT INTO discussions (author_id, title, content, content_format, type) VALUES (?, ?, ?, ?, ?)",
            (author_id, &enc_title, &enc_content, &content_format, &d_type),
        ).map_err(|e| e.to_string())?;
        let discussion_id = conn.last_insert_id();

        if d_type == "poll" {
            let cfg = poll.ok_or("Poll config is required for poll discussions")?;
            let poll_type = cfg.get("poll_type").and_then(|v| v.as_str()).unwrap_or("single").to_string();
            if !["single", "multiple", "number"].contains(&poll_type.as_str()) {
                return Ok(ApiResponse::err("Invalid poll_type, must be single/multiple/number"));
            }
            let min = cfg.get("min").and_then(|v| v.as_i64());
            let max = cfg.get("max").and_then(|v| v.as_i64());
            let step = cfg.get("step").and_then(|v| v.as_i64());
            let vis = cfg.get("results_visibility").and_then(|v| v.as_str()).unwrap_or("always").to_string();
            let vis = if vis == "on_vote" { "on_vote" } else { "always" };

            conn.exec_drop(
                "INSERT INTO discussion_polls (discussion_id, poll_type, min, max, step, results_visibility) VALUES (?, ?, ?, ?, ?, ?)",
                (discussion_id, &poll_type, min, max, step, vis),
            ).map_err(|e| e.to_string())?;
            let poll_id = conn.last_insert_id();

            if poll_type != "number" {
                let options: Vec<String> = cfg.get("options")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|o| o.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect())
                    .unwrap_or_default();
                if options.len() < 2 {
                    return Ok(ApiResponse::err("Poll needs at least 2 options"));
                }
                for (idx, label) in options.iter().enumerate() {
                    let enc_label = encrypt_str(label)?;
                    conn.exec_drop(
                        "INSERT INTO discussion_poll_options (poll_id, label, position) VALUES (?, ?, ?)",
                        (poll_id, &enc_label, idx as i64),
                    ).map_err(|e| e.to_string())?;
                }
            } else {
                // number 投票必须有 min/max
                if min.is_none() || max.is_none() || min.unwrap_or(0) >= max.unwrap_or(0) {
                    return Ok(ApiResponse::err("Number poll needs valid min < max"));
                }
            }
        }

        Ok(ApiResponse::ok_val(serde_json::json!({ "discussion_id": discussion_id }), "Discussion created"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_update_discussion(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    discussion_id: u64,
    title: Option<String>,
    content: Option<String>,
    content_format: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM discussions WHERE id = ? AND status = 'active'", (discussion_id,)
        ).map_err(|e| e.to_string())?;
        match owner {
            Some((aid,)) if aid == author_id => {
                let title = title.map(|t| t.trim().to_string());
                let content = content.map(|c| c.trim().to_string());
                if let Some(ref t) = title {
                    if t.is_empty() || t.chars().count() > MAX_TITLE_LEN {
                        return Ok(ApiResponse::err(&format!("Title must be 1-{} characters", MAX_TITLE_LEN)));
                    }
                }
                if let Some(ref c) = content {
                    if c.is_empty() {
                        return Ok(ApiResponse::err("Content cannot be empty"));
                    }
                }
                let enc_title = title.as_ref().map(|t| encrypt_str(t)).transpose()?;
                let enc_content = content.as_ref().map(|c| encrypt_str(c)).transpose()?;
                let fmt = content_format.filter(|s| s == "richtext").unwrap_or_else(|| "markdown".into());
                conn.exec_drop(
                    "UPDATE discussions SET
                        title = COALESCE(?, title),
                        content = COALESCE(?, content),
                        content_format = ?,
                        updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?",
                    (enc_title, enc_content, fmt, discussion_id),
                ).map_err(|e| e.to_string())?;
                Ok(ApiResponse::ok_msg("Discussion updated"))
            }
            Some(_) => Ok(ApiResponse::err("You can only edit your own discussions")),
            None => Ok(ApiResponse::err("Discussion not found")),
        }
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_discussion(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    discussion_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM discussions WHERE id = ? AND status = 'active'", (discussion_id,)
        ).map_err(|e| e.to_string())?;
        match owner {
            Some((aid,)) if aid == author_id => {
                conn.exec_drop("UPDATE discussions SET status = 'deleted' WHERE id = ?", (discussion_id,))
                    .map_err(|e| e.to_string())?;
                Ok(ApiResponse::ok_msg("Discussion deleted"))
            }
            Some(_) => Ok(ApiResponse::err("You can only delete your own discussions")),
            None => Ok(ApiResponse::err("Discussion not found")),
        }
    }).await
}

// ────────────────────────────── 点赞 ──────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn db_like_discussion(
    state: tauri::State<'_, DbState>,
    discussion_id: u64,
    user_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM discussion_likes WHERE discussion_id = ? AND user_id = ?", (discussion_id, user_id)
        ).map_err(|e| e.to_string())?;
        if exists.is_some() {
            return Ok(ApiResponse::err("Already liked"));
        }
        conn.exec_drop(
            "INSERT INTO discussion_likes (discussion_id, user_id) VALUES (?, ?)",
            (discussion_id, user_id),
        ).map_err(|e| e.to_string())?;
        conn.exec_drop(
            "UPDATE discussions SET like_count = like_count + 1 WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?;
        let count: i64 = conn.exec_first(
            "SELECT like_count FROM discussions WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0);
        Ok(ApiResponse::ok_val(serde_json::json!({ "like_count": count, "is_liked": true }), "Liked"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_unlike_discussion(
    state: tauri::State<'_, DbState>,
    discussion_id: u64,
    user_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        conn.exec_drop(
            "DELETE FROM discussion_likes WHERE discussion_id = ? AND user_id = ?", (discussion_id, user_id)
        ).map_err(|e| e.to_string())?;
        conn.exec_drop(
            "UPDATE discussions SET like_count = GREATEST(like_count - 1, 0) WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?;
        let count: i64 = conn.exec_first(
            "SELECT like_count FROM discussions WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0);
        Ok(ApiResponse::ok_val(serde_json::json!({ "like_count": count, "is_liked": false }), "Unliked"))
    }).await
}

// ────────────────────────────── Boost ──────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn db_boost_discussion(
    state: tauri::State<'_, DbState>,
    discussion_id: u64,
    user_id: u64,
    content: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let content = content.trim().to_string();
        if content.is_empty() || content.chars().count() > MAX_BOOST_LEN {
            return Ok(ApiResponse::err(&format!("Boost must be 1-{} characters", MAX_BOOST_LEN)));
        }
        let exists: Option<(u64,)> = conn.exec_first(
            "SELECT id FROM discussion_boosts WHERE discussion_id = ? AND user_id = ?", (discussion_id, user_id)
        ).map_err(|e| e.to_string())?;
        if exists.is_some() {
            return Ok(ApiResponse::err("Already boosted"));
        }
        let enc_content = encrypt_str(&content)?;
        conn.exec_drop(
            "INSERT INTO discussion_boosts (discussion_id, user_id, content) VALUES (?, ?, ?)",
            (discussion_id, user_id, &enc_content),
        ).map_err(|e| e.to_string())?;
        conn.exec_drop(
            "UPDATE discussions SET boost_count = boost_count + 1 WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?;
        let count: i64 = conn.exec_first(
            "SELECT boost_count FROM discussions WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0);
        Ok(ApiResponse::ok_val(serde_json::json!({ "boost_count": count, "is_boosted": true, "content": content }), "Boosted"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_unboost_discussion(
    state: tauri::State<'_, DbState>,
    discussion_id: u64,
    user_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        conn.exec_drop(
            "DELETE FROM discussion_boosts WHERE discussion_id = ? AND user_id = ?", (discussion_id, user_id)
        ).map_err(|e| e.to_string())?;
        conn.exec_drop(
            "UPDATE discussions SET boost_count = GREATEST(boost_count - 1, 0) WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?;
        let count: i64 = conn.exec_first(
            "SELECT boost_count FROM discussions WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0);
        Ok(ApiResponse::ok_val(serde_json::json!({ "boost_count": count, "is_boosted": false }), "Unboosted"))
    }).await
}

// ────────────────────────────── 投票 ──────────────────────────────

// 校验投票合法性并落库（single: 恰好 1 个选项；multiple: 数量在 [min,max]；number: value 在 [min,max] 且符合 step）
#[tauri::command(rename_all = "snake_case")]
pub async fn db_vote_poll(
    state: tauri::State<'_, DbState>,
    poll_id: u64,
    discussion_id: u64,
    user_id: u64,
    option_ids: Option<Vec<u64>>,
    value: Option<i64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let cfg: Option<(String, Option<i64>, Option<i64>, Option<i64>)> = conn.exec_first(
            "SELECT poll_type, min, max, step FROM discussion_polls WHERE id = ? AND discussion_id = ?",
            (poll_id, discussion_id),
        ).map_err(|e| e.to_string())?;
        let (poll_type, min, max, step) = match cfg {
            Some(c) => c,
            None => return Ok(ApiResponse::err("Poll not found")),
        };

        let option_ids = option_ids.unwrap_or_default();
        match poll_type.as_str() {
            "single" => {
                if option_ids.len() != 1 {
                    return Ok(ApiResponse::err("Single poll requires exactly one option"));
                }
            }
            "multiple" => {
                let lo = min.unwrap_or(1) as usize;
                let hi = max.unwrap_or(option_ids.len() as i64) as usize;
                if option_ids.len() < lo || option_ids.len() > hi {
                    return Ok(ApiResponse::err(&format!("Select {} to {} options", lo, hi)));
                }
            }
            "number" => {
                let v = value.ok_or_else(|| "Number poll requires a value".to_string())?;
                let lo = min.unwrap_or(0);
                let hi = max.unwrap_or(10);
                let st = step.unwrap_or(1).max(1);
                if v < lo || v > hi || (v - lo) % st != 0 {
                    return Ok(ApiResponse::err(&format!("Value must be in [{}, {}] with step {}", lo, hi, st)));
                }
            }
            _ => return Ok(ApiResponse::err("Invalid poll type")),
        }

        // 校验选项属于该 poll
        if poll_type != "number" && !option_ids.is_empty() {
            let ph = vec!["?"; option_ids.len()].join(",");
            let sql = format!("SELECT COUNT(*) FROM discussion_poll_options WHERE poll_id = ? AND id IN ({})", ph);
            let mut params: Vec<Value> = vec![poll_id.into()];
            params.extend(option_ids.iter().map(|o| (*o).into()));
            let found: i64 = conn.exec_first(&sql, params).map_err(|e| e.to_string())?.unwrap_or(0);
            if found as usize != option_ids.len() {
                return Ok(ApiResponse::err("Invalid poll option"));
            }
        }

        let option_ids_json = if poll_type == "number" {
            None
        } else {
            Some(serde_json::to_string(&option_ids).map_err(|e| e.to_string())?)
        };

        // upsert：一人一票，重投覆盖
        conn.exec_drop(
            "INSERT INTO discussion_poll_votes (poll_id, discussion_id, user_id, option_ids, value)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE option_ids = VALUES(option_ids), value = VALUES(value), updated_at = CURRENT_TIMESTAMP",
            (poll_id, discussion_id, user_id, option_ids_json, value),
        ).map_err(|e| e.to_string())?;

        Ok(ApiResponse::ok_msg("Vote recorded"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_poll_results(
    state: tauri::State<'_, DbState>,
    poll_id: u64,
    user_id: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let cfg: Option<(String, String)> = conn.exec_first(
            "SELECT poll_type, results_visibility FROM discussion_polls WHERE id = ?", (poll_id,)
        ).map_err(|e| e.to_string())?;
        let (poll_type, vis) = match cfg {
            Some(c) => c,
            None => return Ok(ApiResponse::err("Poll not found")),
        };

        let has_voted: bool = if let Some(uid) = user_id {
            let exists: Option<(u64,)> = conn.exec_first(
                "SELECT id FROM discussion_poll_votes WHERE poll_id = ? AND user_id = ?", (poll_id, uid),
            ).map_err(|e| e.to_string())?;
            exists.is_some()
        } else { false };

        if vis == "on_vote" && !has_voted {
            return Ok(ApiResponse::ok_val(serde_json::json!({ "results_hidden": true, "has_voted": false }), "OK"));
        }

        let mut opts: Vec<serde_json::Value> = Vec::new();
        conn.exec_map(
            "SELECT id, label FROM discussion_poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC",
            (poll_id,),
            |row: Row| {
                let r: Vec<Value> = row.unwrap();
                opts.push(serde_json::json!({ "id": val_to_i64(&r[0]), "label": decrypt_str(&val_to_string(r[1].clone())) }));
            },
        ).map_err(|e| e.to_string())?;

        let results = collect_poll_results(conn, poll_id, &poll_type, &opts)?;

        Ok(ApiResponse::ok_val(serde_json::json!({
            "results_hidden": false,
            "has_voted": has_voted,
            "results": results,
        }), "OK"))
    }).await
}

// ────────────────────────────── 评论（镜像 mod 评论结构） ──────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn db_add_discussion_comment(
    state: tauri::State<'_, DbState>,
    discussion_id: u64,
    author_id: u64,
    content: String,
    parent_id: Option<u64>,
    reply_to_id: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let content = content.trim().to_string();
        if content.is_empty() || content.chars().count() > MAX_COMMENT_LEN {
            return Ok(ApiResponse::err(&format!("Comment must be 1-{} characters", MAX_COMMENT_LEN)));
        }

        let disc: Option<(u64, u64)> = conn.exec_first(
            "SELECT id, author_id FROM discussions WHERE id = ? AND status = 'active'", (discussion_id,)
        ).map_err(|e| e.to_string())?;
        let disc_author_id = match disc {
            Some((_, aid)) => aid,
            None => return Ok(ApiResponse::err("Discussion not found")),
        };

        let mut parent_author: Option<u64> = None;
        if let Some(pid) = parent_id {
            let parent: Option<(u64, u64, u64)> = conn.exec_first(
                "SELECT id, discussion_id, author_id FROM discussion_comments WHERE id = ?", (pid,)
            ).map_err(|e| e.to_string())?;
            match parent {
                Some((_, did, paid)) if did == discussion_id => { parent_author = Some(paid); }
                Some(_) => return Ok(ApiResponse::err("Parent comment does not belong to this discussion")),
                None => return Ok(ApiResponse::err("Parent comment not found")),
            }
        }

        // 被回复的楼中楼消息作者：楼中楼为扁平模型（parent_id 统一为一楼 id），
        // "回复楼中楼中的某条消息"时被回复人由 reply_to_id 单独携带
        let mut reply_to_author: Option<u64> = None;
        if let Some(rtid) = reply_to_id {
            let rt: Option<(u64, u64, u64)> = conn.exec_first(
                "SELECT id, discussion_id, author_id FROM discussion_comments WHERE id = ?", (rtid,)
            ).map_err(|e| e.to_string())?;
            match rt {
                Some((_, did, paid)) if did == discussion_id => { reply_to_author = Some(paid); }
                Some(_) => return Ok(ApiResponse::err("Reply-target comment does not belong to this discussion")),
                None => return Ok(ApiResponse::err("Reply-target comment not found")),
            }
        }

        let enc_content = encrypt_str(&content)?;
        let mut tx = conn.start_transaction(TxOpts::default()).map_err(|e| e.to_string())?;
        tx.exec_drop(
            "INSERT INTO discussion_comments (discussion_id, author_id, parent_id, content) VALUES (?, ?, ?, ?)",
            (discussion_id, author_id, parent_id, &enc_content),
        ).map_err(|e| e.to_string())?;
        let new_id = tx.last_insert_id();
        tx.exec_drop(
            "UPDATE discussions SET comment_count = comment_count + 1 WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?;

        // 通知写入：按所涉群体补全 —— 被回复人（reply_to）、层主（parent）、楼主（帖子作者），
        // 三方去重、排除自己
        let mut recipients: Vec<u64> = Vec::new();
        for cand in [reply_to_author, parent_author] {
            if let Some(uid) = cand {
                if uid != author_id && !recipients.contains(&uid) {
                    recipients.push(uid);
                }
            }
        }
        if disc_author_id != author_id && !recipients.contains(&disc_author_id) {
            recipients.push(disc_author_id);
        }
        let notif_type = if parent_id.is_some() { "new_reply" } else { "new_comment" };
        for uid in recipients {
            tx.exec_drop(
                "INSERT INTO discussion_notifications (user_id, discussion_id, type, comment_id) VALUES (?, ?, ?, ?)",
                (uid, discussion_id, notif_type, new_id),
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;

        Ok(ApiResponse::ok_val(serde_json::json!({
            "comment_id": new_id,
            "author_id": author_id,
            "content": content,
        }), "Comment added"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_get_discussion_comments(
    state: tauri::State<'_, DbState>,
    discussion_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
    sort_order: Option<String>,
    reply_order: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(10).min(100);
        let offset = (page - 1) * page_size;
        // 一楼排序方向：desc（新→旧，默认）| asc（旧→新）
        let sort_order = sort_order.filter(|s| s == "asc" || s == "desc").unwrap_or_else(|| "desc".into());
        // 楼中楼排序方向：asc（旧→新，默认）| desc（新→旧）；与 db_get_discussion_replies 保持一致
        let reply_order = reply_order.filter(|s| s == "asc" || s == "desc").unwrap_or_else(|| "asc".into());
        let top_order = if sort_order == "asc" { "ASC" } else { "DESC" };
        let reply_dir = if reply_order == "asc" { "ASC" } else { "DESC" };

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM discussion_comments WHERE discussion_id = ? AND parent_id IS NULL", (discussion_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let total_including_replies: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM discussion_comments WHERE discussion_id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let mut top_rows: Vec<Vec<Value>> = Vec::new();
        let top_sql = format!(
            "SELECT c.id, c.content, c.created_at, u.username, u.avatar, c.author_id
             FROM discussion_comments c
             JOIN users u ON c.author_id = u.id
             WHERE c.discussion_id = ? AND c.parent_id IS NULL
             ORDER BY c.created_at {}, c.id {}
             LIMIT ? OFFSET ?",
            top_order, top_order
        );
        conn.exec_map(
            &top_sql,
            (discussion_id, page_size as i64, offset as i64),
            |row: Row| { top_rows.push(row.unwrap()); },
        ).map_err(|e| e.to_string())?;

        let items: Result<Vec<serde_json::Value>, String> = top_rows.into_iter().map(|r| {
            let cid = val_to_i64(&r[0]) as u64;
            let reply_count: i64 = conn.exec_first(
                "SELECT COUNT(*) FROM discussion_comments WHERE parent_id = ?", (cid,)
            ).map_err(|e| e.to_string())?.unwrap_or(0i64);

            let mut reply_rows: Vec<Vec<Value>> = Vec::new();
            let reply_sql = format!(
                "SELECT c.id, c.content, c.created_at, u.username, u.avatar, c.author_id
                 FROM discussion_comments c
                 JOIN users u ON c.author_id = u.id
                 WHERE c.parent_id = ?
                 ORDER BY c.created_at {}, c.id {}
                 LIMIT 2",
                reply_dir, reply_dir
            );
            conn.exec_map(
                &reply_sql,
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

        Ok(ApiResponse {
            success: true,
            message: "OK".into(),
            data: Some(serde_json::json!({
                "comments": items?,
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
pub async fn db_get_discussion_replies(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
    sort_order: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(10).min(50);
        let offset = (page - 1) * page_size;
        // 楼中楼排序方向：asc（旧→新，默认）| desc（新→旧）；
        // 与 db_get_discussion_comments 的 reply_order 保持一致（预览前 2 条 + 分页跳过）
        let sort_order = sort_order.filter(|s| s == "asc" || s == "desc").unwrap_or_else(|| "asc".into());
        let dir = if sort_order == "asc" { "ASC" } else { "DESC" };

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM discussion_comments WHERE parent_id = ?", (comment_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let adjusted_offset = if page == 1 { 2u64 } else { 2 + offset };

        let mut rows: Vec<Vec<Value>> = Vec::new();
        let sql = format!(
            "SELECT c.id, c.content, c.created_at, u.username, u.avatar, c.author_id
             FROM discussion_comments c
             JOIN users u ON c.author_id = u.id
             WHERE c.parent_id = ?
             ORDER BY c.created_at {}, c.id {}
             LIMIT ? OFFSET ?",
            dir, dir
        );
        conn.exec_map(
            &sql,
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

/// 定位一条评论在详情页中的位置（通知跳转「查看回复详情」用）：
/// 返回所属一楼 id、一楼所在页码（page_size=10，与前端 fetchComments 一致）、
/// 楼中楼内 1-based 排名（含前 2 条预览口径，与前端预览+分页规则一致）。
/// 排名按 (created_at, id) 双键、与列表排序同向计算，保证页码换算与列表实际顺序一致。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_locate_discussion_comment(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    top_sort_order: Option<String>,
    reply_sort_order: Option<String>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let row: Option<(u64, Option<u64>)> = conn.exec_first(
            "SELECT discussion_id, parent_id FROM discussion_comments WHERE id = ?",
            (comment_id,),
        ).map_err(|e| e.to_string())?;
        let Some((discussion_id, parent_id)) = row else {
            return Ok(ApiResponse::err("Comment not found"));
        };
        let top_id = parent_id.unwrap_or(comment_id);
        let top_order = top_sort_order
            .filter(|s| s == "asc" || s == "desc")
            .unwrap_or_else(|| "desc".into());
        let reply_order = reply_sort_order
            .filter(|s| s == "asc" || s == "desc")
            .unwrap_or_else(|| "asc".into());

        // 一楼排名：统计按当前排序方向排在目标前面的楼数（同秒并列用 id 次序，与列表 ORDER BY 一致）
        let (top_op, top_tie) = if top_order == "asc" { ("<", "<") } else { (">", ">") };
        let top_before: i64 = conn.exec_first(
            &format!(
                "SELECT COUNT(*) FROM discussion_comments c
                 WHERE c.discussion_id = ? AND c.parent_id IS NULL
                   AND (c.created_at {top_op} (SELECT created_at FROM discussion_comments WHERE id = ?)
                     OR (c.created_at = (SELECT created_at FROM discussion_comments WHERE id = ?) AND c.id {top_tie} ?))"
            ),
            (discussion_id, top_id, top_id, top_id),
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);
        // 前端一楼分页：page_size=10；rank = top_before + 1 → page = (rank-1)/10 + 1
        let top_page = (top_before / 10 + 1) as u64;

        // 楼中楼排名：目标自身是回复时才计算（比较对象为目标自身，在其一楼范围内）
        let reply_index: u64 = if parent_id.is_some() {
            let (reply_op, reply_tie) = if reply_order == "asc" { ("<", "<") } else { (">", ">") };
            let reply_before: i64 = conn.exec_first(
                &format!(
                    "SELECT COUNT(*) FROM discussion_comments c
                     WHERE c.parent_id = ?
                       AND (c.created_at {reply_op} (SELECT created_at FROM discussion_comments WHERE id = ?)
                         OR (c.created_at = (SELECT created_at FROM discussion_comments WHERE id = ?) AND c.id {reply_tie} ?))"
                ),
                (top_id, comment_id, comment_id, comment_id),
            ).map_err(|e| e.to_string())?.unwrap_or(0i64);
            (reply_before + 1) as u64
        } else {
            0
        };

        Ok(ApiResponse::ok_val(serde_json::json!({
            "discussion_id": discussion_id,
            "parent_id": parent_id,
            "top_id": top_id,
            "top_page": top_page,
            "reply_index": reply_index,
        }), "OK"))
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_edit_discussion_comment(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    author_id: u64,
    content: String,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let content = content.trim().to_string();
        if content.is_empty() || content.chars().count() > MAX_COMMENT_LEN {
            return Ok(ApiResponse::err(&format!("Comment must be 1-{} characters", MAX_COMMENT_LEN)));
        }
        let owner: Option<(u64,)> = conn.exec_first(
            "SELECT author_id FROM discussion_comments WHERE id = ?", (comment_id,)
        ).map_err(|e| e.to_string())?;
        match owner {
            Some((aid,)) if aid == author_id => {
                let enc_content = encrypt_str(&content)?;
                conn.exec_drop(
                    "UPDATE discussion_comments SET content = ? WHERE id = ?", (&enc_content, comment_id)
                ).map_err(|e| e.to_string())?;
                Ok(ApiResponse::ok_val(serde_json::json!({ "comment_id": comment_id, "content": content }), "Comment updated"))
            }
            Some(_) => Ok(ApiResponse::err("You can only edit your own comments")),
            None => Ok(ApiResponse::err("Comment not found")),
        }
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_delete_discussion_comment(
    state: tauri::State<'_, DbState>,
    comment_id: u64,
    author_id: u64,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        // 取评论归属信息：作者 / 父评论（楼中楼指向的一楼）/ 所属帖子
        let comment: Option<(u64, Option<u64>, u64)> = conn.exec_first(
            "SELECT author_id, parent_id, discussion_id FROM discussion_comments WHERE id = ?",
            (comment_id,),
        ).map_err(|e| e.to_string())?;

        let Some((comment_author, parent_id, discussion_id)) = comment else {
            return Ok(ApiResponse::err("Comment not found"));
        };

        // 权限判定：本人 / 帖子楼主（可删帖下所有评论及楼中楼）/ 楼中楼的层主（可删自己一楼下的回复）
        let mut allowed = comment_author == author_id;
        if !allowed {
            let owner: Option<(u64,)> = conn.exec_first(
                "SELECT author_id FROM discussions WHERE id = ?", (discussion_id,)
            ).map_err(|e| e.to_string())?;
            allowed = owner.is_some_and(|(oid,)| oid == author_id);
        }
        if !allowed {
            if let Some(pid) = parent_id {
                let floor_owner: Option<(u64,)> = conn.exec_first(
                    "SELECT author_id FROM discussion_comments WHERE id = ?", (pid,)
                ).map_err(|e| e.to_string())?;
                allowed = floor_owner.is_some_and(|(fid,)| fid == author_id);
            }
        }

        if !allowed {
            return Ok(ApiResponse::err("You can only delete your own comments"));
        }

        // 收集待删除的评论 id（评论自身 + 其楼中楼），先清除对应的通知行，
        // 否则删除评论后通知列表会残留 content/作者为 NULL 的"幽灵"卡片（重复显示且缺作者信息）
        let mut pending_ids: Vec<u64> = vec![comment_id];
        conn.exec_map(
            "SELECT id FROM discussion_comments WHERE parent_id = ?",
            (comment_id,),
            |row: Row| {
                let r: Vec<Value> = row.unwrap();
                pending_ids.push(val_to_i64(&r[0]) as u64);
            },
        ).map_err(|e| e.to_string())?;
        for id in pending_ids {
            conn.exec_drop(
                "DELETE FROM discussion_notifications WHERE comment_id = ?",
                (id,),
            ).map_err(|e| e.to_string())?;
        }

        // 删除评论及其楼中楼，并回写 comment_count
        conn.exec_drop("DELETE FROM discussion_comments WHERE parent_id = ?", (comment_id,))
            .map_err(|e| e.to_string())?;
        conn.exec_drop("DELETE FROM discussion_comments WHERE id = ?", (comment_id,))
            .map_err(|e| e.to_string())?;
        conn.exec_drop(
            "UPDATE discussions SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = ?", (discussion_id,)
        ).map_err(|e| e.to_string())?;
        Ok(ApiResponse::ok_msg("Comment deleted"))
    }).await
}

// ────────────────────────────── 我的历史 ──────────────────────────────

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_my_discussions(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
    user_id: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).min(100);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM discussions WHERE author_id = ? AND status = 'active'", (author_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let mut rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(
            &format!(
                "SELECT {} FROM discussions d JOIN users u ON d.author_id = u.id
                 WHERE d.author_id = ? AND d.status = 'active' ORDER BY d.created_at DESC LIMIT ? OFFSET ?",
                discussion_base_columns()
            ),
            (author_id, page_size as i64, offset as i64),
            |row: Row| { rows.push(row.unwrap()); },
        ).map_err(|e| e.to_string())?;

        let ids: Vec<u64> = rows.iter().map(|r| val_to_i64(&r[0]) as u64).collect();
        let polls = collect_polls_for_discussions(conn, &ids)?;

        let mut liked: std::collections::HashSet<u64> = std::collections::HashSet::new();
        if let Some(uid) = user_id {
            if !ids.is_empty() {
                let ph = vec!["?"; ids.len()].join(",");
                let mut like_params: Vec<Value> = vec![Value::UInt(uid)];
                like_params.extend(ids.iter().map(|&id| Value::UInt(id)));
                let mut lr: Vec<Vec<Value>> = Vec::new();
                conn.exec_map(
                    &format!("SELECT discussion_id FROM discussion_likes WHERE user_id = ? AND discussion_id IN ({})", ph),
                    like_params,
                    |row: Row| { lr.push(row.unwrap()); },
                ).map_err(|e| e.to_string())?;
                for r in lr { liked.insert(val_to_i64(&r[0]) as u64); }
            }
        }

        let items: Vec<serde_json::Value> = rows.iter().map(|r| {
            let did = val_to_i64(&r[0]) as u64;
            build_discussion_json(r, liked.contains(&did), false, None, polls.get(&did).cloned())
        }).collect();

        Ok(ApiResponse {
            success: true,
            message: "OK".into(),
            data: Some(serde_json::json!({ "discussions": items, "total": total, "page": page, "page_size": page_size })),
            mods: None,
            total: None,
            page: None,
            page_size: None,
        })
    }).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn db_list_my_discussion_comments(
    state: tauri::State<'_, DbState>,
    author_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
) -> Result<ApiResponse, String> {
    with_conn(state.inner(), move |conn: &mut PooledConn| {
        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(20).min(100);
        let offset = (page - 1) * page_size;

        let total: i64 = conn.exec_first(
            "SELECT COUNT(*) FROM discussion_comments WHERE author_id = ?", (author_id,)
        ).map_err(|e| e.to_string())?.unwrap_or(0i64);

        let mut rows: Vec<Vec<Value>> = Vec::new();
        conn.exec_map(
            "SELECT c.id, c.content, c.created_at, c.parent_id, c.discussion_id, d.title, d.status
             FROM discussion_comments c
             JOIN discussions d ON c.discussion_id = d.id
             WHERE c.author_id = ?
             ORDER BY c.created_at DESC
             LIMIT ? OFFSET ?",
            (author_id, page_size as i64, offset as i64),
            |row: Row| { rows.push(row.unwrap()); },
        ).map_err(|e| e.to_string())?;

        let items: Vec<serde_json::Value> = rows.into_iter().map(|r| {
            serde_json::json!({
                "comment_id": val_to_i64(&r[0]),
                "content": decrypt_str(&val_to_string(r[1].clone())),
                "created_at": val_to_string(r[2].clone()),
                "is_reply": val_to_i64(&r[3]) != 0,
                "discussion_id": val_to_i64(&r[4]),
                "discussion_title": decrypt_str(&val_to_string(r[5].clone())),
                "discussion_status": val_to_string(r[6].clone()),
            })
        }).collect();

        Ok(ApiResponse {
            success: true,
            message: "OK".into(),
            data: Some(serde_json::json!({ "comments": items, "total": total, "page": page, "page_size": page_size })),
            mods: None,
            total: None,
            page: None,
            page_size: None,
        })
    }).await
}
