use mysql::prelude::*;
use mysql::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub mod hash;
pub mod installer;
pub mod subscribe;

mod user;
mod mod_ops;
mod file;
mod comment;
mod like;
mod rating;
mod permission;
mod notification;
mod update;
mod image;

pub use user::*;
pub use mod_ops::*;
pub use file::*;
pub use comment::*;
pub use like::*;
pub use rating::*;
pub use permission::*;
pub use notification::*;
pub use update::*;
pub use image::*;

const DB_POOL_MIN: usize = 0;
const DB_POOL_MAX: usize = 1;
const IDLE_TIMEOUT_SECS: i64 = 60;
const IDLE_CHECK_INTERVAL_SECS: u64 = 10;

pub(crate) fn semver_cmp(a: &str, b: &str) -> i32 {
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

fn db_url() -> String {
    option_env!("DB_URL")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("DB_URL").ok())
        .expect("DB_URL 未设置：请在 src-tauri/.env 中配置数据库连接，然后重新构建")
}

#[derive(Clone)]
pub struct ManagedPool {
    inner: Arc<ManagedPoolInner>,
}

struct ManagedPoolInner {
    pool: Mutex<Option<Pool>>,
    db_url: String,
    last_activity: AtomicI64,
    checker_started: AtomicBool,
}

impl ManagedPool {
    fn new(db_url: String) -> Self {
        Self {
            inner: Arc::new(ManagedPoolInner {
                pool: Mutex::new(None),
                db_url,
                last_activity: AtomicI64::new(0),
                checker_started: AtomicBool::new(false),
            }),
        }
    }

    pub(crate) fn start_idle_checker(&self) {
        if self
            .inner
            .checker_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let inner = self.inner.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(IDLE_CHECK_INTERVAL_SECS));
                let last = inner.last_activity.load(Ordering::Relaxed);
                if last == 0 {
                    continue;
                }
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;
                if now - last > IDLE_TIMEOUT_SECS {
                    let mut guard = inner.pool.lock().unwrap_or_else(|e| e.into_inner());
                    if guard.is_some() {
                        println!("[ManagedPool] idle over {}s, dropping MySQL pool", IDLE_TIMEOUT_SECS);
                        *guard = None;
                        inner.last_activity.store(0, Ordering::Relaxed);
                    }
                }
            }
        });
    }

    pub fn get_conn(&self) -> Result<PooledConn, String> {
        let inner = self.inner.clone();

        let pool = {
            let mut guard = inner.pool.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                let opts = Opts::from_url(&inner.db_url).map_err(|e| e.to_string())?;
                let pool_opts = opts
                    .get_pool_opts()
                    .clone()
                    .with_constraints(PoolConstraints::new(DB_POOL_MIN, DB_POOL_MAX).unwrap_or_default());
                let opts: Opts = OptsBuilder::from_opts(opts).pool_opts(pool_opts).into();
                let new_pool = Pool::new(opts).map_err(|e| e.to_string())?;
                *guard = Some(new_pool);
            }
            let pool = guard.as_ref().unwrap().clone();
            inner.last_activity.store(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
                Ordering::Relaxed,
            );
            pool
        };

        pool.get_conn().map_err(|e| e.to_string())
    }
}

pub struct DbState {
    pub pool: ManagedPool,
}

impl DbState {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let pool = ManagedPool::new(db_url());
        Ok(Self { pool })
    }
}

pub(crate) async fn with_conn<F, R>(state: &DbState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut PooledConn) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    let pool = state.pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn()?;
        f(&mut conn)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) async fn with_conn_pool<F, R>(pool: &ManagedPool, f: F) -> Result<R, String>
where
    F: FnOnce(&mut PooledConn) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_conn()?;
        f(&mut conn)
    })
    .await
    .map_err(|e| e.to_string())?
}

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
    pub(crate) fn ok_val(data: serde_json::Value, msg: &str) -> Self {
        Self { success: true, message: msg.into(), data: Some(data), mods: None, total: None, page: None, page_size: None }
    }
    pub(crate) fn ok_msg(msg: &str) -> Self {
        Self { success: true, message: msg.into(), data: None, mods: None, total: None, page: None, page_size: None }
    }
    pub(crate) fn err(msg: &str) -> Self {
        Self { success: false, message: msg.into(), data: None, mods: None, total: None, page: None, page_size: None }
    }
    pub(crate) fn ok_list(mods: Vec<serde_json::Value>, total: i64, page: u64, page_size: u64) -> Self {
        Self { success: true, message: "OK".into(), data: None, mods: Some(mods), total: Some(total), page: Some(page), page_size: Some(page_size) }
    }
}

pub(crate) fn hash_password(password: &str) -> String {
    hex::encode(Sha256::digest(password.as_bytes()))
}

pub(crate) fn val_to_string(v: Value) -> String {
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

pub(crate) fn val_to_i64(v: &Value) -> i64 {
    match v {
        Value::Int(i) => *i,
        Value::UInt(u) => *u as i64,
        Value::Float(f) => *f as i64,
        Value::Double(d) => *d as i64,
        Value::Bytes(b) => {
            let s = String::from_utf8_lossy(b).trim().to_string();
            s.parse::<f64>().unwrap_or(0.0) as i64
        }
        _ => 0,
    }
}

pub(crate) fn get_user_permissions<C: Queryable>(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_cmp_equal() {
        assert_eq!(semver_cmp("1.0.0", "1.0.0"), 0);
        assert_eq!(semver_cmp("v1.2.3", "1.2.3"), 0);
        assert_eq!(semver_cmp("1.0", "1.0.0"), 0);
    }

    #[test]
    fn semver_cmp_less() {
        assert_eq!(semver_cmp("1.0.0", "1.0.1"), -1);
        assert_eq!(semver_cmp("1.2.3", "1.2.10"), -1);
    }

    #[test]
    fn semver_cmp_greater() {
        assert_eq!(semver_cmp("1.0.1", "1.0.0"), 1);
        assert_eq!(semver_cmp("2.0.0", "1.9.9"), 1);
    }

    #[test]
    fn hash_password_known_sha256() {
        assert_eq!(
            hash_password("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_password("abc").len(), 64);
    }

    #[test]
    fn hash_password_deterministic_and_distinct() {
        assert_eq!(hash_password("abc"), hash_password("abc"));
        assert_ne!(hash_password("abc"), hash_password("xyz"));
        assert!(!hash_password("").is_empty());
    }
}
