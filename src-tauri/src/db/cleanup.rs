//! 图床图片引用检查与批量清理。
//!
//! 编辑/删除内容后，前端只把「从正文里移除的图片 URL」交给后端；后端先解密扫描
//! 全库文本与 `mod_files`，确认没有其它帖子/语言/评论/包记录还引用它，才真正删除
//! 图床文件。这样跨帖共享的图片不会因为某一个帖子移除而失效。
//!
//! 安全约束：
//! - 只接受本图床、`sfm/` 或 `sfmmm/` 下的**图片**扩展名（绝不误删包/安装包/json）。
//! - 引用语料构建时使用严格解密：任何一行密文解不开都中止清理，避免把密文当明文
//!   导致引用集为空、进而全量误删。

use std::collections::HashSet;
use std::sync::OnceLock;

use mysql::prelude::*;
use mysql::*;
use regex::Regex;
use serde_json::json;

use super::image::{delete_imgbed_file_inner, imgbed_file_id_if_ours, is_imgbed_image_id};
use super::{
    decrypt_str, try_decrypt_str, val_to_string, with_conn, with_conn_pool, ApiResponse, DbState,
    ManagedPool,
};

/// 单次批量清理的 URL 上限：防止异常调用方一次塞进大量待删链接
const MAX_CLEANUP_URLS: usize = 100;

// ────────────────────────────── URL 提取与校验 ──────────────────────────────

fn url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"https?://[^\s"'<>()\[\]]+/file/(?:sfm|sfmmm)/[^\s"'<>()\[\]]+"#)
            .expect("图床 URL 正则编译失败")
    })
}

/// 从任意文本中提取图床文件 URL（不校验归属，供单测与后续过滤使用）。
/// 去掉尾随标点、HTML 实体与 query/hash，避免拼出删不掉的 key。
fn extract_file_urls(text: &str) -> Vec<String> {
    url_re()
        .find_iter(text)
        .map(|m| {
            m.as_str()
                .trim_end_matches(|c: char| {
                    matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"')
                })
                .replace("&amp;", "&")
        })
        .map(|s| s.split(['?', '#']).next().unwrap_or_default().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn extract_imgbed_image_urls(text: &str) -> Vec<String> {
    extract_file_urls(text)
        .into_iter()
        .filter(|u| {
            imgbed_file_id_if_ours(u)
                .map(|id| is_imgbed_image_id(&id))
                .unwrap_or(false)
        })
        .collect()
}

fn extract_and_dedupe<I: IntoIterator<Item = String>>(texts: I) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for text in texts {
        for url in extract_imgbed_image_urls(&text) {
            if seen.insert(url.clone()) {
                out.push(url);
            }
        }
    }
    out
}

/// 校验前端传入的候选 URL：只保留本图床 `sfm/`、`sfmmm/` 下的图片，去重并限长。
fn normalize_candidates(file_urls: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut overflow = 0usize;
    for raw in file_urls {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let Ok(id) = imgbed_file_id_if_ours(raw) else {
            continue;
        };
        if !is_imgbed_image_id(&id) {
            continue;
        }
        if !seen.insert(raw.to_string()) {
            continue;
        }
        if out.len() >= MAX_CLEANUP_URLS {
            overflow += 1;
            continue;
        }
        out.push(raw.to_string());
    }
    if overflow > 0 {
        log::warn!(
            "[imgbed-cleanup] 候选超过上限 {MAX_CLEANUP_URLS}，{overflow} 个本次未处理（调用方应分批）"
        );
    }
    out
}

// ────────────────────────────── 引用语料 ──────────────────────────────

fn query_cols(conn: &mut PooledConn, sql: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    conn.exec_map(sql, (), |row: Row| {
        let vals: Vec<Value> = row.unwrap();
        rows.push(vals.into_iter().map(val_to_string).collect());
    })
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn query_cols_by_id(
    conn: &mut PooledConn,
    sql: &str,
    id: u64,
) -> Result<Vec<Vec<String>>, String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    conn.exec_map(sql, (id,), |row: Row| {
        let vals: Vec<Value> = row.unwrap();
        rows.push(vals.into_iter().map(val_to_string).collect());
    })
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn push_decrypted(corpus: &mut Vec<String>, rows: Vec<Vec<String>>) -> Result<(), String> {
    for row in rows {
        for v in row {
            corpus.push(try_decrypt_str(&v)?);
        }
    }
    Ok(())
}

/// 收集「仍被引用」的明文语料。只包含有效内容：
/// 讨论区软删除帖及其评论/boost/投票选项已被排除，因此被删内容的图片会进入候选。
fn build_reference_corpus(conn: &mut PooledConn) -> Result<Vec<String>, String> {
    let mut corpus = Vec::new();

    push_decrypted(
        &mut corpus,
        query_cols(
            conn,
            "SELECT name, description, instructions, changelog FROM mod_translations",
        )?,
    )?;
    push_decrypted(&mut corpus, query_cols(conn, "SELECT content FROM mod_comments")?)?;
    push_decrypted(
        &mut corpus,
        query_cols(
            conn,
            "SELECT title, content FROM discussions WHERE status = 'active'",
        )?,
    )?;
    push_decrypted(
        &mut corpus,
        query_cols(
            conn,
            "SELECT c.content FROM discussion_comments c
             JOIN discussions d ON d.id = c.discussion_id
             WHERE d.status = 'active'",
        )?,
    )?;
    push_decrypted(
        &mut corpus,
        query_cols(
            conn,
            "SELECT b.content FROM discussion_boosts b
             JOIN discussions d ON d.id = b.discussion_id
             WHERE d.status = 'active'",
        )?,
    )?;
    push_decrypted(
        &mut corpus,
        query_cols(
            conn,
            "SELECT o.label FROM discussion_poll_options o
             JOIN discussion_polls p ON p.id = o.poll_id
             JOIN discussions d ON d.id = p.discussion_id
             WHERE d.status = 'active'",
        )?,
    )?;
    push_decrypted(
        &mut corpus,
        query_cols(
            conn,
            "SELECT avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''",
        )?,
    )?;
    push_decrypted(
        &mut corpus,
        query_cols(conn, "SELECT reason FROM edit_applications")?,
    )?;

    // 包文件 URL 是明文，且可能被用户贴进正文/评论：必须算作引用，
    // 否则删评论时会把正在被下载的包一起删掉。
    for row in query_cols(conn, "SELECT file_url FROM mod_files")? {
        for v in row {
            if !v.is_empty() {
                corpus.push(v);
            }
        }
    }

    Ok(corpus)
}

fn split_referenced(
    conn: &mut PooledConn,
    candidates: Vec<String>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let corpus = build_reference_corpus(conn)?;
    let mut kept = Vec::new();
    let mut to_delete = Vec::new();
    for url in candidates {
        if corpus.iter().any(|text| text.contains(&url)) {
            kept.push(url);
        } else {
            to_delete.push(url);
        }
    }
    Ok((kept, to_delete))
}

// ────────────────────────────── 命令与后台清理 ──────────────────────────────

/// 批量清理图片：只删「没有任何有效内容再引用」的 URL。
/// 部分删除失败不视为命令失败，逐条放在 `failed` 里返回。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_cleanup_imgbed_images(
    state: tauri::State<'_, DbState>,
    file_urls: Vec<String>,
) -> Result<ApiResponse, String> {
    let candidates = normalize_candidates(file_urls);
    if candidates.is_empty() {
        return Ok(ApiResponse::ok_val(
            json!({ "deleted": [], "kept": [], "failed": [] }),
            "OK",
        ));
    }

    let (kept, to_delete) =
        with_conn(state.inner(), move |conn| split_referenced(conn, candidates)).await?;

    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for url in to_delete {
        match delete_imgbed_file_inner(&url).await {
            Ok((file_id, existed)) => {
                deleted.push(json!({ "file_id": file_id, "existed": existed, "url": url }))
            }
            Err(e) => failed.push(json!({ "url": url, "error": e })),
        }
    }

    Ok(ApiResponse::ok_val(
        json!({ "deleted": deleted, "kept": kept, "failed": failed }),
        "OK",
    ))
}

/// 后台清理：引用检查在 DB 锁内，HTTP 删除在锁外；失败只记日志。
pub(crate) async fn cleanup_images_with_pool(pool: ManagedPool, urls: Vec<String>) {
    let candidates = normalize_candidates(urls);
    if candidates.is_empty() {
        return;
    }
    let (kept, to_delete) = match with_conn_pool(&pool, move |conn| {
        split_referenced(conn, candidates)
    })
    .await
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[imgbed-cleanup] 引用检查失败，跳过本次清理: {e}");
            return;
        }
    };
    log::info!(
        "[imgbed-cleanup] 待删除 {} 个，保留（仍被引用）{} 个",
        to_delete.len(),
        kept.len()
    );
    for url in to_delete {
        if let Err(e) = delete_imgbed_file_inner(&url).await {
            log::warn!("[imgbed-cleanup] 删除失败 {url}: {e}");
        }
    }
}

/// 删除类命令成功后调用：不等待清理完成，避免拖慢删除本身。
pub(crate) fn spawn_cleanup(pool: ManagedPool, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    tokio::spawn(async move {
        cleanup_images_with_pool(pool, urls).await;
    });
}

// ────────────────────────────── 按实体收集待清理 URL ──────────────────────────────

/// 讨论帖（软删后调用）：正文 + 该帖全部评论 + boost + 投票选项。
fn collect_discussion_image_urls(
    conn: &mut PooledConn,
    discussion_id: u64,
) -> Result<Vec<String>, String> {
    let mut texts = Vec::new();

    let row: Option<(String, String)> = conn
        .exec_first(
            "SELECT title, content FROM discussions WHERE id = ?",
            (discussion_id,),
        )
        .map_err(|e| e.to_string())?;
    if let Some((title, content)) = row {
        texts.push(decrypt_str(&title));
        texts.push(decrypt_str(&content));
    }

    for row in query_cols_by_id(
        conn,
        "SELECT content FROM discussion_comments WHERE discussion_id = ?",
        discussion_id,
    )? {
        for v in row {
            texts.push(decrypt_str(&v));
        }
    }
    for row in query_cols_by_id(
        conn,
        "SELECT content FROM discussion_boosts WHERE discussion_id = ?",
        discussion_id,
    )? {
        for v in row {
            texts.push(decrypt_str(&v));
        }
    }
    for row in query_cols_by_id(
        conn,
        "SELECT o.label FROM discussion_poll_options o
         JOIN discussion_polls p ON p.id = o.poll_id
         WHERE p.discussion_id = ?",
        discussion_id,
    )? {
        for v in row {
            texts.push(decrypt_str(&v));
        }
    }

    Ok(extract_and_dedupe(texts))
}

pub(crate) fn spawn_discussion_cleanup(pool: ManagedPool, discussion_id: u64) {
    tokio::spawn(async move {
        let urls = match with_conn_pool(&pool, move |conn| {
            collect_discussion_image_urls(conn, discussion_id)
        })
        .await
        {
            Ok(u) => u,
            Err(e) => {
                log::warn!("[imgbed-cleanup] 讨论帖图片收集失败: {e}");
                return;
            }
        };
        cleanup_images_with_pool(pool, urls).await;
    });
}

/// 评论楼层（硬删前调用）：评论自身 + 其楼中楼。
pub(crate) fn collect_thread_image_urls(
    conn: &mut PooledConn,
    table: &str,
    comment_id: u64,
) -> Result<Vec<String>, String> {
    let sql = if table == "mod_comments" {
        "SELECT content FROM mod_comments WHERE id = ? OR parent_id = ?"
    } else {
        "SELECT content FROM discussion_comments WHERE id = ? OR parent_id = ?"
    };
    let mut texts = Vec::new();
    conn.exec_map(sql, (comment_id, comment_id), |row: Row| {
        let vals: Vec<Value> = row.unwrap();
        texts.push(val_to_string(vals[0].clone()));
    })
    .map_err(|e| e.to_string())?;

    Ok(extract_and_dedupe(texts.into_iter().map(|t| decrypt_str(&t))))
}

/// mod 删除前调用：所有语言的说明/描述/changelog + 该 mod 下评论与楼中楼
/// + 该 mod 的编辑申请理由（会被级联删除）。
pub(crate) fn collect_mod_image_urls(
    conn: &mut PooledConn,
    mod_id: u64,
) -> Result<Vec<String>, String> {
    let mut texts = Vec::new();
    for row in query_cols_by_id(
        conn,
        "SELECT name, description, instructions, changelog FROM mod_translations WHERE mod_id = ?",
        mod_id,
    )? {
        for v in row {
            texts.push(decrypt_str(&v));
        }
    }
    for row in query_cols_by_id(
        conn,
        "SELECT content FROM mod_comments WHERE mod_id = ?",
        mod_id,
    )? {
        for v in row {
            texts.push(decrypt_str(&v));
        }
    }
    for row in query_cols_by_id(
        conn,
        "SELECT reason FROM edit_applications WHERE mod_id = ?",
        mod_id,
    )? {
        for v in row {
            texts.push(decrypt_str(&v));
        }
    }
    Ok(extract_and_dedupe(texts))
}

#[cfg(test)]
mod tests {
    use super::extract_file_urls;
    use crate::db::image::is_imgbed_image_id;

    #[test]
    fn extracts_markdown_and_html_urls() {
        let text = "![a](https://h/file/sfm/1/images/zh/a.png) \
                    <img src=\"https://h/file/sfmmm/discourse/2/b.JPG\">";
        assert_eq!(
            extract_file_urls(text),
            vec![
                "https://h/file/sfm/1/images/zh/a.png".to_string(),
                "https://h/file/sfmmm/discourse/2/b.JPG".to_string(),
            ]
        );
    }

    #[test]
    fn trims_trailing_punctuation_and_query() {
        let text = "看这个 https://h/file/sfm/1/comments/9/a.png). 还有 \
                    https://h/file/sfm/1/comments/9/b.png?raw=1&x=2";
        assert_eq!(
            extract_file_urls(text),
            vec![
                "https://h/file/sfm/1/comments/9/a.png".to_string(),
                "https://h/file/sfm/1/comments/9/b.png".to_string(),
            ]
        );
    }

    #[test]
    fn unescapes_html_ampersand() {
        let text = "https://h/file/sfm/1/comments/9/a.png?a=1&amp;b=2";
        // &amp; 还原后 query 仍会被裁掉，只关心还原本身
        assert_eq!(
            extract_file_urls(text),
            vec!["https://h/file/sfm/1/comments/9/a.png".to_string()]
        );
        let text = "https://h/file/sfm/1/comments/9/a.png&amp;x";
        assert_eq!(
            extract_file_urls(text),
            vec!["https://h/file/sfm/1/comments/9/a.png&x".to_string()]
        );
    }

    #[test]
    fn only_image_extensions_are_cleanable() {
        assert!(is_imgbed_image_id("sfm/1/images/zh/a.PNG"));
        assert!(is_imgbed_image_id("sfmmm/discourse/2/comments/3/a.webp"));
        assert!(!is_imgbed_image_id("sfm/1/zh/1.0.0/a.zip"));
        assert!(!is_imgbed_image_id("sfm/installer/latest.json"));
        assert!(!is_imgbed_image_id("sfm/installer/v1/x-setup.exe"));
        assert!(!is_imgbed_image_id("sfm/1/a"));
    }
}
