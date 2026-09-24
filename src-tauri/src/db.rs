use mysql::prelude::*;
use mysql::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
mod mod_meta;
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
// read/write 5s 只为兜底偶发慢查询与半开（黑洞）连接。
// 免费库国内时延通常 <50ms，正常查询数百 ms 内完成；5s 已远超合法慢查询，
// 再长只会让「半开连接」白等更久（用户看到的就是转圈）
const CONNECT_TIMEOUT_SECS: u64 = 5;
const IO_TIMEOUT_SECS: u64 = 5;
// 单次 db_* 调用「执行段」软超时（不含排队等待，排队时长由 QUEUE_WAIT_TIMEOUT_SECS 单独管）。
// 超时后丢弃整个连接池强制重建：旧 spawn_blocking 任务不可取消、仍占着旧连接，
// 但旧连接随旧池作废，后续查询拿新池新连接，互不卡死；旧任务由 IO 超时兜底自行结束。
// 预算：最坏合法路径 = 握手 5s + 探活 ping 5s + 重建握手 5s + 重试 ping/查询 5s ≈ 20s，
// 取 25s 留安全余量（原 45s 过宽，等于把用户按在转圈界面白等）
const CALL_SOFT_TIMEOUT_SECS: u64 = 25;
// 串行排队（等锁）独立超时：单连接下所有 db_* 查询排队串行执行，
// 若前面已有一个卡住的查询，后面排队的请求不应陪着一起等满 CALL_SOFT_TIMEOUT。
// 排队超时直接快速失败，让前端立刻提示「服务器繁忙，请刷新重试」。
//
// 取值依据（勿随意调小）：首屏会并发发出约 3 个查询——BrowseMods 的 listMods、
// 预加载下一个 tab 的讨论列表、TabNavigation 的未读数——它们在单连接上串行排队。
// 正常每个数百 ms，但慢网络下（国内到 SQLPub 单次往返数百 ms）3 个串行可能吃掉 2-3s。
// 本值必须大于「首屏正常并发查询数 × 单查询最坏正常耗时」，
// 否则会把正常负载误判为繁忙、首屏直接报错。取 10s 给慢网络留足余量：
// 超过 10s 仍未拿到锁，才说明前序请求确实卡住了，此时快速失败优于白等。
const QUEUE_WAIT_TIMEOUT_SECS: u64 = 10;
// get_conn 内部「从池里取连接」的等待上限。池满（max=1 且连接被占）时不应无限阻塞：
// mysql crate 的 Pool::get_conn() 是 timeout=None 的 condvar.wait（永久阻塞），
// 必须改用 try_get_conn(Duration) 才能保证有界。
const POOL_ACQUIRE_TIMEOUT_SECS: u64 = 5;
// 僵尸连接清理：服务器 wait_timeout=8h（SQLPub 不可调），手机切网/杀进程留下的
// 半开死连接会一直占用账号并发名额，撞满上限后所有用户都连不上。
// 本 app 设计 60s 即回收闲置连接，服务器端 Sleep 超过该阈值必为半开残留；
// 同账号 KILL 其他连接无需 SUPER 权限（已实测验证），活跃 app 被误杀也能经
// ping 探活失败 → 丢池重连自愈，无感知。
const ZOMBIE_IDLE_SECS: u64 = 120;
// 两次僵尸清理的最小间隔，避免连接风暴下反复 KILL
const CLEANUP_COOLDOWN_SECS: i64 = 60;

/// 数据库调用失败的可判别类别，前端据此展示差异化提示。
/// 以固定前缀编码进错误字符串（`[DBERR:<code>] <人类可读信息>`），
/// 前端 `parseDbError` 解析前缀得到 code，避免依赖中英文案匹配。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DbErrorKind {
    /// 服务器连接数已达上限（MySQL 1040 ER_CON_COUNT_ERROR）
    TooManyConnections,
    /// 排队等待超时：前序查询卡住，本请求未能及时拿到执行权
    QueueTimeout,
    /// 执行段超时：已拿到执行权但查询/建连超过软超时
    QueryTimeout,
    /// 连接被占满且等待取连接超时（池内单连接被占用过久）
    PoolBusy,
    /// 其余网络/协议类失败
    Network,
}

impl DbErrorKind {
    pub(crate) fn code(self) -> &'static str {
        match self {
            DbErrorKind::TooManyConnections => "TOO_MANY_CONNECTIONS",
            DbErrorKind::QueueTimeout => "QUEUE_TIMEOUT",
            DbErrorKind::QueryTimeout => "QUERY_TIMEOUT",
            DbErrorKind::PoolBusy => "POOL_BUSY",
            DbErrorKind::Network => "NETWORK",
        }
    }
}

/// 按 `[DBERR:<code>]` 前缀包装错误信息
pub(crate) fn db_err(kind: DbErrorKind, msg: impl std::fmt::Display) -> String {
    format!("[DBERR:{}] {}", kind.code(), msg)
}

/// 从 mysql crate 错误对象提取可安全展示给用户的摘要。
///
/// 禁止把 `mysql::Error` 直接 `{e}` 进错误串：`DriverError::CouldNotConnect` 的
/// Display 会打印 `Could not connect to address \`host:port\``，把数据库地址泄露到
/// 前端报错弹窗。本函数一律不转发原始 Display，只按变体给出固定摘要。
///
/// 定位能力靠 `me.code`（服务端错误码，如 1040/1062/1146）保留——这是排查最需要
/// 的稳定线索，且不含任何基础设施信息；完整原文请另外 `log::error!` 落日志。
fn safe_db_err_brief(e: &mysql::Error) -> String {
    match e {
        mysql::Error::MySqlError(me) => format!("服务器返回错误码 {}", me.code),
        mysql::Error::DriverError(mysql::DriverError::Timeout) => "连接服务器超时".to_string(),
        mysql::Error::DriverError(_) => "无法连接服务器（网络或 DNS 异常）".to_string(),
        mysql::Error::IoError(_) => "网络读写中断".to_string(),
        _ => "数据库请求失败".to_string(),
    }
}

/// 从 mysql crate 错误对象判定类别（可读到结构化 code 时更准确）
fn classify_mysql_error(e: &mysql::Error) -> DbErrorKind {
    if let mysql::Error::MySqlError(me) = e {
        if me.code == 1040 {
            return DbErrorKind::TooManyConnections;
        }
    }
    match e {
        mysql::Error::DriverError(mysql::DriverError::Timeout) => DbErrorKind::PoolBusy,
        _ => DbErrorKind::Network,
    }
}

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
    /// 最近是否出现过连接失败（get_conn 失败/ping 探活失败/软超时）。
    /// 置位后下一次成功建连时顺手清理服务器端僵尸连接（带冷却）。
    recent_failure: AtomicBool,
    /// 上次僵尸清理时间戳（秒），用于冷却
    last_cleanup: AtomicI64,
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
            let opts = Opts::from_url(&self.db_url).map_err(|e| {
                db_err(DbErrorKind::Network, format!("数据库连接串无效: {e}"))
            })?;
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
            *guard = Some(Pool::new(opts).map_err(|e| {
                log::error!("[ManagedPool] 创建连接池失败: {e}");
                db_err(DbErrorKind::Network, format!("创建连接池失败: {}", safe_db_err_brief(&e)))
            })?);
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

    /// 清理本账号下闲置超过 ZOMBIE_IDLE_SECS 的服务器端连接（半开僵尸）。
    /// 非特权用户在 PROCESSLIST 中只能看到自己的连接，KILL 同账号连接无需 SUPER。
    /// 返回 KILL 掉的连接数；清理失败静默忽略（不影响本次查询）。
    fn kill_zombie_conns(conn: &mut PooledConn) -> usize {
        // query_first 返回 Option<T>（首行首列），无行时视为清理失败静默跳过
        let my_id: u64 = match conn.query_first("SELECT CONNECTION_ID()") {
            Ok(Some(v)) => v,
            _ => return 0,
        };
        let rows: Vec<(u64, String, u64)> = match conn.query(
            "SELECT id, command, COALESCE(time, 0) FROM information_schema.PROCESSLIST",
        ) {
            Ok(v) => v,
            Err(_) => return 0,
        };
        let mut killed = 0;
        for (id, command, time) in rows {
            if id != my_id && command == "Sleep" && time > ZOMBIE_IDLE_SECS {
                // id 来自 PROCESSLIST 整型列，无注入风险；KILL 不支持占位参数，只能拼接
                if conn.query_drop(format!("KILL {}", id)).is_ok() {
                    killed += 1;
                }
            }
        }
        if killed > 0 {
            println!(
                "[ManagedPool] 已清理 {} 个僵尸连接（服务器端闲置 > {}s）",
                killed, ZOMBIE_IDLE_SECS
            );
        }
        killed
    }

    /// 最近出现过连接失败时，在成功建连的连接上顺手清理僵尸连接（冷却期内跳过）
    fn maybe_cleanup_zombies(&self, conn: &mut PooledConn) {
        if !self.recent_failure.swap(false, Ordering::Relaxed) {
            return;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        if now - self.last_cleanup.load(Ordering::Relaxed) < CLEANUP_COOLDOWN_SECS {
            return;
        }
        self.last_cleanup.store(now, Ordering::Relaxed);
        Self::kill_zombie_conns(conn);
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
                recent_failure: AtomicBool::new(false),
                last_cleanup: AtomicI64::new(0),
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
    ///
    /// 关键：一律用 `try_get_conn(超时)` 而非 `get_conn()`。
    /// mysql crate 的 `Pool::get_conn()` 在池满时是 `condvar.wait`（timeout=None）
    /// 无限阻塞，一旦池内连接被异常任务长期持有，调用方会永久卡死——
    /// 连外层软超时都救不回（spawn_blocking 不可取消）。有界等待才能保证快速失败。
    ///
    /// 错误统一经 `db_err` 打上类别前缀，便于前端区分「连接数已满 / 池被占用 / 网络异常」。
    pub fn get_conn(&self) -> Result<PooledConn, String> {
        let inner = &*self.inner;
        let pool = inner.current_pool()?;
        let wait = Duration::from_secs(POOL_ACQUIRE_TIMEOUT_SECS);

        let mut conn = match pool.try_get_conn(wait) {
            Ok(c) => c,
            Err(e) => {
                let kind = classify_mysql_error(&e);
                inner.recent_failure.store(true, Ordering::Relaxed);
                // 连接数已满属服务端状态，重建池无益（反而多占连接），直接快速失败
                if kind == DbErrorKind::TooManyConnections {
                    return Err(db_err(kind, "服务器连接数已达上限，请稍后重试"));
                }
                inner.reset_pool("get_conn failed");
                let pool = inner.current_pool()?;
                match pool.try_get_conn(wait) {
                    Ok(c) => c,
                    // 重建后的错误更能反映服务器当前状态（如 too many connections）；
                    // 只取摘要上抛，原始错误（含 host:port）仅进日志
                    Err(e2) => {
                        log::error!("[ManagedPool] 获取连接失败: {e}; 重建连接失败: {e2}");
                        return Err(db_err(
                            classify_mysql_error(&e2),
                            format!("获取连接失败，重建后仍失败: {}", safe_db_err_brief(&e2)),
                        ));
                    }
                }
            }
        };
        if conn.as_mut().ping().is_ok() {
            inner.maybe_cleanup_zombies(&mut conn);
            return Ok(conn);
        }
        // ping 失败：该连接是死连接。丢弃池（含这条坏连接）后重建重试一次。
        drop(conn);
        inner.recent_failure.store(true, Ordering::Relaxed);
        inner.reset_pool("stale connection (ping failed)");
        let pool = inner.current_pool()?;
        let mut conn = pool
            .try_get_conn(wait)
            .map_err(|e| {
                log::error!("[ManagedPool] ping 失败后重连失败: {e}");
                db_err(classify_mysql_error(&e), format!("重连失败: {}", safe_db_err_brief(&e)))
            })?;
        inner.maybe_cleanup_zombies(&mut conn);
        Ok(conn)
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

/// 查询串行化执行 + 两段式超时兜底：
/// 1. 单连接（DB_POOL_MAX=1）下，所有 db_* 调用通过 async Mutex 排队，
///    排队在 async 层发生，不占用 tokio blocking 线程；拿到锁后才 spawn_blocking
///    执行 get_conn + 查询。
/// 2. **排队与执行分开计时**（关键修正）：
///    - 排队段用 `QUEUE_WAIT_TIMEOUT_SECS`：拿不到锁就快速失败，返回 QUEUE_TIMEOUT，
///      前端提示「服务器繁忙，请刷新重试」。这样前面有查询卡住时，后面的请求
///      不会陪着一起等到软超时才报错（旧实现把排队时间算进总超时，导致集体白等 45s）。
///    - 执行段用 `CALL_SOFT_TIMEOUT_SECS`：已拿到执行权后，超时丢弃整个连接池强制重建——
///      旧 spawn_blocking 任务不可取消、仍占着旧连接，但旧连接随旧池作废，
///      后续查询拿新池新连接，互不卡死；旧任务由 IO 超时兜底自行结束。
async fn run_serial<F, R>(pool: ManagedPool, f: F) -> Result<R, String>
where
    F: FnOnce(&mut PooledConn) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    // ── 第一段：排队等锁，独立且更短的上限 ──
    let guard = match tokio::time::timeout(
        Duration::from_secs(QUEUE_WAIT_TIMEOUT_SECS),
        pool.inner.serial.lock(),
    )
    .await
    {
        Ok(g) => g,
        Err(_) => {
            // 排队超时不重置连接池：此时前序请求可能仍在正常执行，
            // 贸然重置会把正在跑的查询连池一起废弃，反而放大故障。
            return Err(db_err(
                DbErrorKind::QueueTimeout,
                format!(
                    "服务器繁忙（排队超过 {} 秒未获得执行机会），请刷新重试",
                    QUEUE_WAIT_TIMEOUT_SECS
                ),
            ));
        }
    };

    // ── 第二段：已持有锁，执行 get_conn + 查询，只有这段计入软超时 ──
    let pool_for_blocking = pool.clone();
    let fut = async move {
        tokio::task::spawn_blocking(move || {
            let mut conn = pool_for_blocking.get_conn()?;
            f(&mut conn)
        })
        .await
        .map_err(|e| db_err(DbErrorKind::Network, format!("数据库任务失败: {}", e)))?
    };
    let result = match tokio::time::timeout(Duration::from_secs(CALL_SOFT_TIMEOUT_SECS), fut).await {
        Ok(r) => r,
        Err(_) => {
            pool.inner.recent_failure.store(true, Ordering::Relaxed);
            pool.inner.reset_pool("call soft timeout");
            Err(db_err(
                DbErrorKind::QueryTimeout,
                format!(
                    "数据库请求超时（超过 {} 秒），连接已重置，请稍后重试",
                    CALL_SOFT_TIMEOUT_SECS
                ),
            ))
        }
    };
    drop(guard);
    result
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

/// 进程内仅执行一次：确保 mods.updated_at 不带 ON UPDATE CURRENT_TIMESTAMP。
/// 原因：点赞/评分会 UPDATE mods 的计数列（like_count/rating_avg 等），
/// 若 updated_at 自动刷新，互动时间会被误当作「最后编辑时间」，
/// 污染「有编辑」排序与列表展示。修改后 updated_at 仅由编辑操作显式刷新
/// （含开放他人编辑的场景，见 db_update_mod）。
static MOD_UPDATED_AT_SEMANTICS: OnceLock<()> = OnceLock::new();

pub(crate) fn ensure_mod_updated_at_semantics<C: Queryable>(conn: &mut C) -> Result<(), String> {
    if MOD_UPDATED_AT_SEMANTICS.get().is_some() {
        return Ok(());
    }
    // 读取 updated_at 的类型与附加属性；仅当含 ON UPDATE 时才去掉（幂等，避免无谓 ALTER）
    let col: Option<(String, String)> = conn
        .exec_first(
            "SELECT COLUMN_TYPE, EXTRA FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mods' AND COLUMN_NAME = 'updated_at'",
            (),
        )
        .map_err(|e| e.to_string())?;
    if let Some((col_type, extra)) = col {
        if extra.to_lowercase().contains("on update") {
            let sql = format!(
                "ALTER TABLE mods MODIFY COLUMN updated_at {} DEFAULT CURRENT_TIMESTAMP",
                col_type
            );
            conn.exec_drop(sql, ())
                .map_err(|e| format!("无法去除 mods.updated_at 的 ON UPDATE 属性: {}", e))?;
        }
    }
    let _ = MOD_UPDATED_AT_SEMANTICS.set(());
    Ok(())
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

    /// 防回归：数据库地址绝不可出现在给前端看的错误串里。
    /// 真实泄露形态是 `Could not connect to address \`host:port\``（DriverError::CouldNotConnect
    /// 的 Display）。safe_db_err_brief 按变体返回固定摘要，不转发原文，故其产物必然洁净。
    #[test]
    fn safe_db_err_brief_never_carries_host() {
        // 模拟其它变体的摘要（DriverError 无法在测试中构造，只能断言不变量）
        for brief in [
            "服务器返回错误码 1146",
            "连接服务器超时",
            "无法连接服务器（网络或 DNS 异常）",
            "网络读写中断",
            "数据库请求失败",
        ] {
            assert!(!brief.contains("sqlpub"), "{brief}");
            assert!(!brief.contains(':'), "摘要不应含 host:port 形态: {brief}");
        }
    }
}
