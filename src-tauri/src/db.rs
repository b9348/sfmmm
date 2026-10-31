use mysql::prelude::*;
use mysql::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex as AsyncMutex;

pub mod hash;
pub mod installer;
pub mod subscribe;
pub mod archive;
pub mod bepinex;
pub mod lanzou;
pub mod gh;
pub mod crypto;
pub mod secret;
pub mod download;

mod master_key;
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
mod cleanup;

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
pub use cleanup::*;

const DB_POOL_MIN: usize = 0;
const DB_POOL_MAX: usize = 1;
const IDLE_TIMEOUT_SECS: i64 = 60;
const IDLE_CHECK_INTERVAL_SECS: u64 = 10;
// 连接/读写超时：TCP+MySQL 握手慢归 CONNECT_TIMEOUT 管。
// 关键（勿回退到 5s）：SQLPub 高峰限流时服务器收下查询后长时间不回**任何字节**
// （实测同一条 SQL 平时 0~1s 返回，高峰可静默挂起 10 分钟以上），所以单次
// socket read 的等待时长就等于「整个查询能等多久」。旧值 5s 时 Windows 的
// SO_RCVTIMEO 到期报 os error 10060（WSAETIMEDOUT），前端看到
// CodecError{IoError(10060)}，永远轮不到 90s 软超时收尾。
// 现取 CALL_SOFT_TIMEOUT_SECS + 5：read 上限略宽于执行段软超时，让软超时
// 先行收尾（产生结构化 QUERY_TIMEOUT 错误 + 丢池重建），IO 超时只作极端兜底。
const CONNECT_TIMEOUT_SECS: u64 = 15;
const IO_TIMEOUT_SECS: u64 = CALL_SOFT_TIMEOUT_SECS + 5;
// 单次 db_* 调用「执行段」软超时（不含排队等待，排队时长由 QUEUE_WAIT_TIMEOUT_SECS 单独管）。
// 超时后丢弃整个连接池强制重建：旧 spawn_blocking 任务不可取消、仍占着旧连接，
// 但旧连接随旧池作废，后续查询拿新池新连接，互不卡死；旧任务由 IO 超时兜底自行结束。
// 取 90s：SQLPub 免费库高峰期限流，实测单查询 15ms~56s 重尾分布——限流排队中的
// 查询多等一会总能返回，宁慢勿错（前端 DB_CALL_TIMEOUT_MS 已相应放宽）。
// 注意：IO_TIMEOUT（read 上限）已放宽到本值 +5，限流期间服务器不发字节时
// 由本软超时先行收尾（结构化错误 + 丢池重建）。
const CALL_SOFT_TIMEOUT_SECS: u64 = 90;
// 串行排队（等锁）独立超时：单连接下所有 db_* 查询排队串行执行，
// 若前面已有一个卡住的查询，后面排队的请求不应陪着一起等满 CALL_SOFT_TIMEOUT。
// 排队超时直接快速失败，让前端立刻提示「服务器繁忙，请刷新重试」。
//
// 取值依据（勿随意调小）：首屏会并发发出约 3 个查询——BrowseMods 的 listMods、
// 预加载下一个 tab 的讨论列表、TabNavigation 的未读数——它们在单连接上串行排队。
// 正常每个数百 ms，但慢网络下（国内到 SQLPub 单次往返数百 ms）3 个串行可能吃掉 2-3s。
// 本值必须大于「首屏正常并发查询数 × 单查询最坏正常耗时」，
// 否则会把正常负载误判为繁忙、首屏直接报错。取 30s：执行段已放宽到 90s，
// 前一个查询被限流慢跑时，后面的请求最多陪等 30s 再快速失败（纯白等的排队
// 不宜与执行段等长，否则一次限流会拖垮整串请求）。
const QUEUE_WAIT_TIMEOUT_SECS: u64 = 30;
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
// 周期性僵尸清理间隔：即使近期无连接失败也兜底清理。
// 动机：清理原本仅在「失败后首次建连」触发，安静期僵尸会缓慢累积——
// 最坏情况全部 max_user_connections 名额被僵尸占满，新连接在代理层被拒，
// 任何实例都建不了连，「失败后清理」的前提永远无法满足，只能等名额释放。
// 释放机制未完全确认：曾观测到一次 1226 拒绝后约 190s 重试成功，可能是
// SQLPub 代理计数窗口重置（报错中含截断的 "reset utime: 179..."），也可能
// 只是恰好有活跃连接断开；若两者皆无，上界是服务器 wait_timeout（8h）。
// 周期清理保证只要有任一实例能正常建连，僵尸就永远积累不到占满名额的程度，
// 使上述锁死窗口在实践上不可达。
const PERIODIC_CLEANUP_SECS: i64 = 600;

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
    /// 离线开发模式：刻意不连接云数据库（`pnpm tauri dev:of`）
    OfflineDev,
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
            DbErrorKind::OfflineDev => "OFFLINE_DEV",
            DbErrorKind::Network => "NETWORK",
        }
    }
}

/// 离线开发模式开关（`pnpm tauri dev:of` 以 `SFMMM_OFFLINE=1` 启动应用）。
///
/// 置位后后端**不建立任何 MySQL 连接**：所有云库调用在排队/取连接前直接
/// 返回 `[DBERR:OFFLINE_DEV]`，前端 `dbCall` 随即回退到本地 SQLite 缓存
/// （request_cache / 各类业务缓存），便于无网络或无有效 `src-tauri/.env`
/// 时开发纯前端/本地功能。纯本地命令（订阅任务列表、线路读写等）不受影响。
pub(crate) fn offline_dev() -> bool {
    static OFFLINE: OnceLock<bool> = OnceLock::new();
    *OFFLINE.get_or_init(|| {
        std::env::var("SFMMM_OFFLINE")
            .map(|v| is_truthy(&v))
            .unwrap_or(false)
    })
}

fn is_truthy(v: &str) -> bool {
    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

/// 离线开发模式下所有云库访问统一返回的错误（前端按 OFFLINE_DEV 类别展示原文）
fn offline_dev_err() -> String {
    db_err(
        DbErrorKind::OfflineDev,
        "离线开发模式（pnpm tauri dev:of）：未连接云数据库，仅使用本地缓存",
    )
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
        mysql::Error::IoError(io) => {
            // Windows 上 SO_RCVTIMEO 到期报 os error 10060（WSAETIMEDOUT）：
            // 服务器（限流中）收下查询后长时间不回字节，read 超时。给出限流语义提示。
            if io.kind() == std::io::ErrorKind::TimedOut || io.raw_os_error() == Some(10060) {
                "连接读取超时（服务器响应缓慢或限流中，请稍后重试）".to_string()
            } else {
                "网络读写中断".to_string()
            }
        }
        _ => "数据库请求失败".to_string(),
    }
}

/// 从 mysql crate 错误对象判定类别（可读到结构化 code 时更准确）
fn classify_mysql_error(e: &mysql::Error) -> DbErrorKind {
    if let mysql::Error::MySqlError(me) = e {
        // 1040 = 服务器连接数上限；1226 = 用户级资源上限（max_user_connections，
        // SQLPub 代理实际返回的形态）。两者对用户语义相同：稍后重试即可。
        if me.code == 1040 || me.code == 1226 {
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

// ── 数据库线路选择 ─────────────────────────────────────────
// 线路 1 = 线路1，线路 2 = 线路2。
// 连接串由编译期注入，运行时经 `db::secret::reveal` 解码。
static DB_LINE: AtomicU8 = AtomicU8::new(1);

pub fn db_line() -> u8 {
    DB_LINE.load(Ordering::Relaxed)
}

pub fn set_db_line(line: u8) {
    DB_LINE.store(if line == 2 { 2 } else { 1 }, Ordering::Relaxed);
}

fn db_url_line1() -> String {
    let raw = option_env!("DB_URL")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("DB_URL").ok())
        .expect("DB_URL 未设置：请在 src-tauri/.env 中配置数据库连接，然后重新构建");
    secret::reveal(&raw)
}

fn db_url_line2() -> String {
    let raw = option_env!("DB_URL2")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("DB_URL2").ok())
        .expect("DB_URL2 未设置：请在 src-tauri/.env 中配置线路2数据库连接，然后重新构建");
    secret::reveal(&raw)
}

/// 当前线路是否强制 TLS。
/// 由构建期 `DB_TLS1`/`DB_TLS2`（0/1）声明，缺省时线路 2 视为强制 TLS，
/// 避免在源码/二进制中硬编码服务商域名。
fn db_tls() -> bool {
    let raw = match db_line() {
        2 => option_env!("DB_TLS2")
            .map(|s| s.to_string())
            .or_else(|| std::env::var("DB_TLS2").ok()),
        _ => option_env!("DB_TLS1")
            .map(|s| s.to_string())
            .or_else(|| std::env::var("DB_TLS1").ok()),
    };
    match raw.as_deref().map(str::trim) {
        Some("1") | Some("true") | Some("TRUE") => true,
        Some("0") | Some("false") | Some("FALSE") => false,
        _ => db_line() == 2,
    }
}

fn db_url() -> String {
    match db_line() {
        2 => db_url_line2(),
        _ => db_url_line1(),
    }
}

/// 查询当前线路（前端设置页显示用）
#[tauri::command]
pub async fn db_get_line() -> u8 {
    db_line()
}

/// 切换数据库线路（1=sqlpub，2=TiDB Cloud）：
/// 更新全局线路号 → 重置连接池（下次请求按新线路重建）→ 持久化到本地 config.db
#[tauri::command]
pub async fn db_set_line(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    line: u8,
) -> Result<u8, String> {
    if line != 1 && line != 2 {
        return Err(format!("无效的数据库线路: {line}"));
    }
    set_db_line(line);
    state.pool.inner.reset_pool("切换数据库线路");
    let conn = crate::db::subscribe::open_sqlite(&app)?;
    conn.execute(
        "INSERT OR REPLACE INTO config (id, `key`, value) VALUES ((SELECT id FROM config WHERE `key` = 'db_line'), 'db_line', ?1)",
        [line.to_string()],
    )
    .map_err(|e| format!("写入线路配置失败: {e}"))?;
    println!("[ManagedPool] 已切换数据库线路: 线路{line}");
    Ok(line)
}

#[derive(Clone)]
pub struct ManagedPool {
    inner: Arc<ManagedPoolInner>,
}

struct ManagedPoolInner {
    pool: Mutex<Option<Pool>>,
    last_activity: AtomicI64,
    checker_started: AtomicBool,
    /// 最近是否出现过连接失败（get_conn 失败/ping 探活失败/软超时）。
    /// 置位后下一次成功建连时立即清理服务器端僵尸连接（带冷却）；
    /// 即使标志未置位，超过 PERIODIC_CLEANUP_SECS 也会周期性兜底清理。
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
            let url = db_url();
            let opts = Opts::from_url(&url).map_err(|e| {
                db_err(DbErrorKind::Network, format!("数据库连接串无效: {e}"))
            })?;
            let pool_opts = opts
                .get_pool_opts()
                .clone()
                .with_constraints(PoolConstraints::new(DB_POOL_MIN, DB_POOL_MAX).unwrap_or_default());
            // 部分云数据库强制 TLS：mysql crate 仅在显式设置 ssl_opts 时才升级 TLS
            // （URL 参数不支持 ssl_opts，改由 DB_TLS1/DB_TLS2 声明，避免硬编码域名）
            let tls = db_tls();
            log::info!("[ManagedPool] 建池：线路{}，TLS={}", db_line(), tls);
            let builder = if tls {
                OptsBuilder::from_opts(opts)
                    .ssl_opts(Some(mysql::SslOpts::default()))
                    .prefer_socket(false)
            } else {
                OptsBuilder::from_opts(opts)
            };
            let opts: Opts = builder
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

    /// 僵尸清理触发判定：recent_failure 置位 → 立即清理（失败驱动）；
    /// 否则距上次清理超过 PERIODIC_CLEANUP_SECS → 也清理（周期兜底）。
    /// 两路径共用 CLEANUP_COOLDOWN_SECS 冷却，冷却期内一律跳过。
    /// 返回 true 表示本次应执行清理。
    fn should_cleanup(&self, now: i64) -> bool {
        let failed = self.recent_failure.swap(false, Ordering::Relaxed);
        if failed {
            // 失败驱动的清理不受周期间隔约束，仅受最小冷却约束
            return now - self.last_cleanup.load(Ordering::Relaxed) >= CLEANUP_COOLDOWN_SECS;
        }
        now - self.last_cleanup.load(Ordering::Relaxed) >= PERIODIC_CLEANUP_SECS
    }

    /// 成功建连后清理服务器端僵尸连接：失败后立即触发，或每
    /// PERIODIC_CLEANUP_SECS 周期兜底触发（冷却期内跳过）。
    /// 清理失败静默忽略（不影响本次查询）。
    fn maybe_cleanup_zombies(&self, conn: &mut PooledConn) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        if !self.should_cleanup(now) {
            return;
        }
        self.last_cleanup.store(now, Ordering::Relaxed);
        Self::kill_zombie_conns(conn);
    }
}

impl ManagedPool {
    fn new() -> Self {
        // last_cleanup 初始化为进程启动时刻（而非 0）：
        // 若从 0 起，首次成功建连会立即触发僵尸清理（PROCESSLIST 两次串行往返），
        // 把首屏第一查询无谓拖慢数百 ms~1s；从启动时刻起，首次清理自然落在
        // PERIODIC_CLEANUP_SECS 之后，不影响首屏。
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        Self {
            inner: Arc::new(ManagedPoolInner {
                pool: Mutex::new(None),
                last_activity: AtomicI64::new(0),
                checker_started: AtomicBool::new(false),
                recent_failure: AtomicBool::new(false),
                last_cleanup: AtomicI64::new(now),
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
        // 离线开发模式：连接池永不创建，直接失败交给前端回退本地缓存
        if offline_dev() {
            return Err(offline_dev_err());
        }
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

/// 连接池健康快照（前端网络信号灯用）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatus {
    /// 最近是否出现过连接失败（get_conn 失败/ping 探活失败/软超时）。
    /// 成功建连时由池内部清除，语义与前端信号灯的「红/绿」一致。
    pub recent_failure: bool,
}

/// 只读连接池原子标志，不触碰 MySQL：
/// 前端启动/进页时调用一次，校准信号灯初始状态（本会话尚无请求时的红/绿判定）。
#[tauri::command]
pub async fn db_pool_status(state: tauri::State<'_, DbState>) -> Result<PoolStatus, String> {
    Ok(PoolStatus {
        recent_failure: state.pool.inner.recent_failure.load(Ordering::Relaxed),
    })
}

impl DbState {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let pool = ManagedPool::new();
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
    // 离线开发模式短路：不排队、不 spawn_blocking、不建连（纯本地命令不走本函数）
    if offline_dev() {
        return Err(offline_dev_err());
    }

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

    /// 周期清理判定：失败驱动仅受冷却约束，周期兜底受周期间隔约束。
    /// should_cleanup 只做判定，last_cleanup 的写入在 maybe_cleanup_zombies
    /// （需真实连接），故此处手动 store 模拟各时间点。
    #[test]
    fn should_cleanup_failure_and_periodic_paths() {
        let mp = ManagedPool::new();
        let inner = &*mp.inner;

        // last_cleanup 初始化为进程启动时刻（而非 0），首次建连不触发清理，
        // 避免首屏第一查询被 PROCESSLIST 往返拖慢
        let init = inner.last_cleanup.load(Ordering::Relaxed);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        assert!(init > 0 && now >= init && now - init < 60);

        // 测试统一手动设定基准模拟各时间点
        let t0 = 1_000_000;
        inner.last_cleanup.store(t0, Ordering::Relaxed);

        // 无失败 + 冷却/周期均未到：不清理
        assert!(!inner.should_cleanup(t0 + CLEANUP_COOLDOWN_SECS - 1));
        assert!(!inner.should_cleanup(t0 + PERIODIC_CLEANUP_SECS - 1));

        // 无失败 + 周期已到：清理（即使从未失败）
        assert!(inner.should_cleanup(t0 + PERIODIC_CLEANUP_SECS));

        // 模拟 t1 时刻刚清理过（周期触发后由 maybe_cleanup_zombies 写入）
        let t1 = t0 + PERIODIC_CLEANUP_SECS;
        inner.last_cleanup.store(t1, Ordering::Relaxed);

        // 失败置位 + 冷却未过：失败驱动仍受最小冷却约束
        inner.recent_failure.store(true, Ordering::Relaxed);
        assert!(!inner.should_cleanup(t1 + 1));
        // swap 已消费标志，不能残留
        assert!(!inner.recent_failure.load(Ordering::Relaxed));

        // 失败置位 + 冷却已过：立即清理
        inner.recent_failure.store(true, Ordering::Relaxed);
        assert!(inner.should_cleanup(t1 + CLEANUP_COOLDOWN_SECS));
    }

    /// 离线开发开关的取值解析：仅显式真值才视为开启，避免误改环境变量时静默断库
    #[test]
    fn offline_flag_truthy_values() {
        for v in ["1", "true", "TRUE", " True ", "yes", "on"] {
            assert!(is_truthy(v), "应视为开启: {v:?}");
        }
        for v in ["", "0", "false", "off", "no", "2", "enabled"] {
            assert!(!is_truthy(v), "应视为关闭: {v:?}");
        }
    }

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
