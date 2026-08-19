use mysql::prelude::*;
use mysql::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;

pub mod hash;
pub mod installer;
pub mod subscribe;
pub mod bepinex;
pub mod lanzou;
pub mod gh;
pub mod crypto;
pub mod download;

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
mod discussion;

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
pub use crypto::*;
pub use discussion::*;

const DB_POOL_MIN: usize = 0;
const DB_POOL_MAX: usize = 1;
const IDLE_TIMEOUT_SECS: i64 = 60;
const IDLE_CHECK_INTERVAL_SECS: u64 = 10;
// 连接/读写超时：TCP+MySQL 握手慢归 CONNECT_TIMEOUT 管；查一页数据正常 <1s，
// read/write 15s 只为兜底偶发慢查询与半开（黑洞）连接，不再给病态场景留 60s 余量
const CONNECT_TIMEOUT_SECS: u64 = 10;
const IO_TIMEOUT_SECS: u64 = 15;
// 单次 db_* 调用总软超时（含串行锁排队时间）。超时后丢弃整个连接池强制重建：
// 旧 spawn_blocking 任务不可取消、仍占着旧连接，但旧连接随旧池作废，
// 后续查询拿新池新连接，互不卡死；旧任务由 IO 超时兜底自行结束。
// 需大于最坏合法路径（握手 10s + ping 探活/重试两轮 IO 15s×2 = 40s），取 45s
const CALL_SOFT_TIMEOUT_SECS: u64 = 45;

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
    /// 查询串行锁：单连接（DB_POOL_MAX=1）下，所有 db_* 调用通过此锁排队，
    /// 排队在 async 层发生，不占用 tokio blocking 线程，也不被 mysql crate 内部
    /// 不可观测的 wait queue 阻塞。拿到锁后才 spawn_blocking 执行 get_conn + 查询。
    serial: AsyncMutex<()>,
}

impl ManagedPoolInner {
    /// 丢弃整个池（置 None，下次取连接时重建）。旧 Pool 句柄若仍被进行中的
    /// spawn_blocking 任务持有，会随任务结束自然释放，不影响新池。
    fn reset_pool(&self, reason: &str) {
        let mut guard = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            println!("[ManagedPool] {}, dropping MySQL pool", reason);
            *guard = None;
            self.last_activity.store(0, Ordering::Relaxed);
        }
    }

    /// 取当前池实例（无则按超时参数建新池），并刷新活跃时间戳。
    /// 返回 Pool 的克隆（内部 Arc），与池槽位解耦：之后即使槽位被 reset_pool
    /// 换成新池，本克隆对应的旧池仍独立存活，直到其所有引用结束。
    fn current_pool(&self) -> Result<Pool, String> {
        let mut guard = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let opts = Opts::from_url(&self.db_url).map_err(|e| e.to_string())?;
            let pool_opts = opts
                .get_pool_opts()
                .clone()
                .with_constraints(PoolConstraints::new(DB_POOL_MIN, DB_POOL_MAX).unwrap_or_default());
            let opts: Opts = OptsBuilder::from_opts(opts)
                .pool_opts(pool_opts)
                .tcp_connect_timeout(Some(Duration::from_secs(CONNECT_TIMEOUT_SECS)))
                .read_timeout(Some(Duration::from_secs(IO_TIMEOUT_SECS)))
                .write_timeout(Some(Duration::from_secs(IO_TIMEOUT_SECS)))
                .into();
            *guard = Some(Pool::new(opts).map_err(|e| e.to_string())?);
        }
        let pool = guard.as_ref().unwrap().clone();
        self.last_activity.store(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64,
            Ordering::Relaxed,
        );
        Ok(pool)
    }
}

impl ManagedPool {
    fn new(db_url: String) -> Self {
        Self {
            inner: Arc::new(ManagedPoolInner {
                pool: Mutex::new(None),
                db_url,
                last_activity: AtomicI64::new(0),
                checker_started: AtomicBool::new(false),
                serial: AsyncMutex::new(()),
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
                    inner.reset_pool(&format!("idle over {}s", IDLE_TIMEOUT_SECS));
                }
            }
        });
    }

    /// 取连接并 ping 探活：免费库按 wait_timeout 掐断的僵尸连接，ping 会毫秒级失败，
    /// 不必等 read_timeout 才发现。ping 失败 → 弃池重建 → 从新池重试一次。
    /// （半开黑洞连接 ping 仍可能吃满 IO 超时，由 read_timeout=15s 兜底。）
    pub fn get_conn(&self) -> Result<PooledConn, String> {
        let inner = &*self.inner;
        let pool = inner.current_pool()?;
        let mut conn = pool.get_conn().map_err(|e| e.to_string())?;
        if conn.as_mut().ping().is_ok() {
            return Ok(conn);
        }
        drop(conn);
        inner.reset_pool("stale connection (ping failed)");
        let pool = inner.current_pool()?;
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

/// 查询串行化执行 + 软超时兜底：
/// 1. 单连接（DB_POOL_MAX=1）下，所有 db_* 调用通过 async Mutex 排队，
///    排队在 async 层发生，不占用 tokio blocking 线程；拿到锁后才 spawn_blocking
///    执行 get_conn + 查询。
/// 2. 软超时包住「排队 + 执行」整段。超时后 spawn_blocking 不可取消、仍占着
///    旧连接，但 reset_pool 会丢弃整个池——旧连接随旧池作废，后续查询拿新池
///    新连接，互不卡死；旧任务由 IO 超时（IO_TIMEOUT_SECS）兜底自行结束。
async fn run_serial<F, R>(pool: ManagedPool, f: F) -> Result<R, String>
where
    F: FnOnce(&mut PooledConn) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    let fut = async {
        let _guard = pool.inner.serial.lock().await;
        let pool_for_blocking = pool.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = pool_for_blocking.get_conn()?;
            f(&mut conn)
        })
        .await
        .map_err(|e| format!("数据库任务失败: {}", e))?
    };
    match tokio::time::timeout(Duration::from_secs(CALL_SOFT_TIMEOUT_SECS), fut).await {
        Ok(r) => r,
        Err(_) => {
            pool.inner.reset_pool("call soft timeout");
            Err(format!(
                "数据库请求超时（超过 {} 秒），连接已重置，请稍后重试",
                CALL_SOFT_TIMEOUT_SECS
            ))
        }
    }
}

pub(crate) async fn with_conn<F, R>(state: &DbState, f: F) -> Result<R, String>
where
    F: FnOnce(&mut PooledConn) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    run_serial(state.pool.clone(), f).await
}

pub(crate) async fn with_conn_pool<F, R>(pool: &ManagedPool, f: F) -> Result<R, String>
where
    F: FnOnce(&mut PooledConn) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    run_serial(pool.clone(), f).await
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
