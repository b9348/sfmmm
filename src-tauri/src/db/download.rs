// 渐进式下载引擎：BepInEx 前置安装（db/bepinex.rs）与程序更新（db/installer.rs）共用。
//
// 多线程下载当前默认关闭（DEFAULT_DOWNLOAD_THREADS = 1），一律走单流下载；
// 并行分块代码仍在，把该常量调回 >1 即可恢复。
// 服务端支持 Range 且 threads > 1 时按 threads 分块并行下载（渐进式落盘 + 节流进度上报）；
// 单个子块失败会在子任务内重试，仍失败则主线程串行补下失败区间，子线程失败不影响主流程；
// 服务端不支持 Range / 大小未知 / 单线程时自动回退单流下载（整体重试 3 次）。
// 进度经 on_progress 回调上报（percent + downloaded + total + speed，约 400ms 节流），
// 具体写库/广播事件由调用方实现（update-progress / bepinex-progress 各自独立）。
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

/// 下载进度快照（节流上报）
#[derive(Clone, Copy, Debug, Default)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: u32,
    pub speed: u64,
}

/// 进度回调：调用方自行写库 + 广播事件
pub type ProgressFn = Arc<dyn Fn(DownloadProgress) + Send + Sync>;

/// 默认分块下载线程数。所有下载通路（前置安装 / 程序更新 / 订阅安装 / 仅下载）
/// 共用此常量，避免各处散落魔法数字；调用方仍可显式传入更小/更大的值。
///
/// 当前暂时关闭多线程下载（置 1 → `download_file_once` 直接走单流）。
/// 恢复并行只需改回 8，并行分块相关代码保持原样未删。
pub const DEFAULT_DOWNLOAD_THREADS: u32 = 1;

/// 进度持久化节流器：事件可以每个 tick 都广播，写 SQLite 按固定间隔限流，
/// 避免 `update_task_status`（每次新开连接 + PRAGMA）拖慢进度事件的发送。
/// 各下载任务用 `Arc<Mutex<PersistThrottle>>` 包一层放进进度回调即可。
pub struct PersistThrottle {
    last: std::time::Instant,
}

impl PersistThrottle {
    pub fn new() -> Self {
        Self {
            last: std::time::Instant::now() - std::time::Duration::from_secs(5),
        }
    }

    /// 距上次放行已超过 `every` 时返回 true 并刷新计时。
    pub fn should_persist(&mut self, every: std::time::Duration) -> bool {
        let now = std::time::Instant::now();
        if now.duration_since(self.last) >= every {
            self.last = now;
            true
        } else {
            false
        }
    }
}

impl Default for PersistThrottle {
    fn default() -> Self {
        Self::new()
    }
}

/// 取消标志：置 true 后所有下载子任务尽快停止并返回 Err，避免取消后残留子任务
/// 继续写文件（与再次下载并发写同一文件导致安装包损坏）。调用方在 spawn 任务时
/// 创建并持有，cancel 命令置位。无取消需求的调用方传入 `Arc::new(AtomicBool::new(false))` 即可。
pub type CancelFlag = Arc<AtomicBool>;

/// 下载客户端建连超时。曾经是 30s：线路短暂劣化时用户要盯着 0% 干等半分钟
/// 才等到回退，实测镜像域名会出现 TLS 阶段整段挂死，30s 纯属放大伤害。
/// 8s 足够覆盖正常握手（实测 0.7~3s），失败就交给上层回退原始域名。
pub const DOWNLOAD_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Range 探测（HEAD / bytes=0-0）超时：探测只是拿大小与 Range 支持，
/// 拿不到就该尽快走单流兜底，不该在这里陪跑几十秒。
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 单个请求的停滞超时：连续该时长收不到任何数据（含响应头）即放弃本次尝试，
/// 换一条新连接重来。TCP 被中途限速/饿死时不会抛 Err——socket 只是安静下来，
/// 没有这个超时子块会无限挂起，进度条恒定不动（表现为"卡 0%"永不结束）。
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 分块粒度上下限与「每线程目标块数」。
///
/// 不再按线程数等分文件：等分会让每条连接预先圈占 1/threads 的地盘，慢连接
/// 拖着那一大块不放，而快连接干完自己的只能空转（"一方有难，八方围观"，
/// 末段表现就是进度卡在 99%）。改为共享游标领块后，单块上限决定慢连接
/// 最多能拖住多少数据，所以块要小；但块太小则每块一次 HTTP 请求，
/// 延迟开销占比升高，所以设下限。
///
/// 下限 256KB 还有一层作用：低于它的文件只会分出 1 块，worker 数被块数夹成 1，
/// 等于自动回落到单连接——实测 89KB 文件单流 1.3s，多连接反而 2.8~9.2s
/// （8 次 TLS 握手比传输本身还贵）。这样"小文件别开线程"不需要单独写一条分支。
const MIN_CHUNK_SIZE: u64 = 256 * 1024;
const MAX_CHUNK_SIZE: u64 = 1024 * 1024;
const CHUNKS_PER_THREAD: u64 = 4;

/// 单块字节数：目标 total / (threads * 4)，夹在 [MIN, MAX]。
/// 于是并发量 ≈ min(threads, ceil(total / 每块)），由体积自然决定：
/// 89KB → 1 块 1 连接；6MB → 25 块供 8 个 worker 抢（约 3 块/人，够均摊慢连接）；
/// ≥32MB → 稳定 1MB 块，靠块数扩展并发。
fn chunk_size_for(total: u64, threads: u32) -> u64 {
    let lanes = threads.max(1) as u64 * CHUNKS_PER_THREAD;
    (total / lanes).clamp(MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
}

/// 单块下载的结果。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RangeOutcome {
    /// 已下到区间末端
    Done,
    /// 因被其它 worker 窃取而提前收工（已完成的部分有效且已落盘）
    Stolen,
    /// 重试用尽仍失败（已落盘的部分保留，缺口由末尾的覆盖校验统一补下）
    Failed,
}

/// 在途分块登记：让空闲 worker 看见谁还欠多少字节，从而窃取其余下部分。
/// 整个下载共享一个 `Vec<Arc<ActiveChunk>>`，每个在途块对应一个条目。
struct ActiveChunk {
    /// 下一个待写的绝对偏移（= 起点 + 已确认落盘字节数）
    current: AtomicU64,
    /// 收工边界（独占）。被窃取时下调到中缝，原 worker 到界即干净收工。
    stop_at: AtomicU64,
}

impl ActiveChunk {
    fn new(start: u64, end: u64) -> Self {
        Self {
            current: AtomicU64::new(start),
            stop_at: AtomicU64::new(end + 1),
        }
    }
}

/// 从共享游标领一块；游标越过末尾返回 None（领地已分完）。
fn claim_chunk(cursor: &AtomicU64, chunk_size: u64, total: u64) -> Option<(u64, u64)> {
    let start = cursor.fetch_add(chunk_size, Ordering::Relaxed);
    if start >= total {
        return None;
    }
    Some((start, (start + chunk_size - 1).min(total - 1)))
}

/// 值得窃取的最小剩余长度。必须远小于块大小，否则正常块永远够不到门槛，
/// 窃取逻辑等于死代码（块 256KB 时若门槛取块大小，任何块都偷不动）。
const MIN_STEAL_SIZE: u64 = 64 * 1024;

/// 从在途分块中挑剩余最多的一个，把它的后半段交给空闲 worker。
/// 返回要接手的闭区间；没有值得窃取的就返回 None。
///
/// 用 CAS 把 `stop_at` 下调到中缝：中缝一旦确定就不会被第二个 worker 重复切走，
/// 原 worker 也会在同一位置收工，两边地盘不重叠。这是治「末段变慢」的关键——
/// 光靠共享游标，游标耗尽后空闲 worker 只能退出，末尾几块就剩少数慢连接在爬。
fn try_steal(active: &Mutex<Vec<Arc<ActiveChunk>>>, min_split: u64) -> Option<(u64, u64)> {
    // 锁中毒（其它 worker panic）时按"无可窃取"处理，避免在这里再 panic 一次
    let guard = active.lock().ok()?;
    let victim = guard
        .iter()
        .map(|c| {
            let cur = c.current.load(Ordering::Relaxed);
            let stop = c.stop_at.load(Ordering::Relaxed);
            (stop.saturating_sub(cur), c)
        })
        // 只剩一小截的不值得再开一条连接（握手成本会盖过收益）
        .filter(|(remaining, _)| *remaining >= min_split * 2)
        .max_by_key(|(remaining, _)| *remaining)?
        .1;

    let cur = victim.current.load(Ordering::Relaxed);
    let stop = victim.stop_at.load(Ordering::Relaxed);
    if stop.saturating_sub(cur) < min_split * 2 {
        return None;
    }
    let mid = cur + (stop - cur) / 2;
    victim
        .stop_at
        .compare_exchange(stop, mid, Ordering::Relaxed, Ordering::Relaxed)
        .ok()?;
    Some((mid, stop - 1))
}

/// 合并已完成区间后，返回仍未覆盖的缺口（闭区间）。按落盘确认而不是文件长度
/// 判完整性：文件在下载前就 set_len(total) 预分配过，长度恒等于 total，
/// 拿它当校验等于什么都没查。
fn missing_ranges(done: &mut [(u64, u64)], total: u64) -> Vec<(u64, u64)> {
    done.sort_unstable();
    let mut gaps = Vec::new();
    let mut covered_to: u64 = 0; // 下一个尚未确认的偏移
    for (start, end) in done.iter().copied() {
        if start > covered_to {
            gaps.push((covered_to, start - 1));
        }
        covered_to = covered_to.max(end.saturating_add(1));
        if covered_to >= total {
            return gaps;
        }
    }
    if covered_to < total {
        gaps.push((covered_to, total - 1));
    }
    gaps
}

/// 把 [current, end] 落到文件对应偏移（独立句柄 + seek，与其它子块互不干扰）。
///
/// 与朴素分块下载的区别：
/// 1. 从 `chunk.current` 续传——重试不再从头再来，已落盘字节就是已下载字节，
///    所以进度计数只增不减，不需要失败时回退去重。
/// 2. 每次写入前读 `chunk.stop_at`：被窃取后一到中缝就收工（Stolen），
///    且写入量按边界截断，绝不越过中缝去覆盖对方的地盘。
/// 3. 等响应头与等数据块都受 STALL_TIMEOUT 约束——socket 被饿死时不报错、
///    只是安静下来，没有这层包夹会永久挂起（"卡 0%"的直接成因）。
async fn download_range(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    chunk: &Arc<ActiveChunk>,
    end: u64,
    downloaded: &AtomicU64,
    cancel: &CancelFlag,
) -> RangeOutcome {
    const ATTEMPTS: u32 = 3;
    for attempt in 0..ATTEMPTS {
        if cancel.load(Ordering::Relaxed) {
            return RangeOutcome::Failed;
        }
        let mut pos = chunk.current.load(Ordering::Relaxed);
        // stop_at 可能已被窃取下调；end 是本条登记的原始区间末端
        let mut stop = chunk.stop_at.load(Ordering::Relaxed).min(end + 1);
        if pos >= stop {
            return if stop <= end { RangeOutcome::Stolen } else { RangeOutcome::Done };
        }
        let range = format!("bytes={}-{}", pos, stop - 1);
        let resp = match tokio::time::timeout(
            STALL_TIMEOUT,
            client.get(url).header(reqwest::header::RANGE, range).send(),
        )
        .await
        {
            Ok(Ok(r)) if r.status().is_success() => r,
            _ => {
                tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
                continue;
            }
        };
        let mut file = match tokio::fs::OpenOptions::new().write(true).open(path).await {
            Ok(f) => f,
            Err(_) => continue,
        };
        if file.seek(std::io::SeekFrom::Start(pos)).await.is_err() {
            continue;
        }
        let mut stream = resp.bytes_stream();
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(file);
                return RangeOutcome::Failed;
            }
            stop = chunk.stop_at.load(Ordering::Relaxed).min(end + 1);
            if pos >= stop {
                break; // 已到中缝：剩下的归窃取者
            }
            match tokio::time::timeout(STALL_TIMEOUT, stream.next()).await {
                // 流结束（可能提前）：交给下方判定要不要重试
                Ok(None) => break,
                // 停滞超时：本次尝试作废，从 pos 续传重来
                Err(_) => break,
                Ok(Some(Ok(bytes))) => {
                    // 只写到边界为止：多出来的字节属于窃取者的地盘
                    let take = (bytes.len() as u64).min(stop - pos) as usize;
                    if file.write_all(&bytes[..take]).await.is_err() {
                        break;
                    }
                    pos += take as u64;
                    // 先落 current 再加进度：窃取者靠 current 算剩余量
                    chunk.current.store(pos, Ordering::Relaxed);
                    downloaded.fetch_add(take as u64, Ordering::Relaxed);
                    if take < bytes.len() {
                        break; // 中缝正好落在这块数据中间
                    }
                }
                Ok(Some(Err(_))) => break,
            }
        }
        drop(file);
        // 本次尝试的结果：到界即算完成（Stolen 也算本条登记完成，缺口已交给对方）
        stop = chunk.stop_at.load(Ordering::Relaxed).min(end + 1);
        if pos >= stop {
            return if stop <= end { RangeOutcome::Stolen } else { RangeOutcome::Done };
        }
        // 没走完：退避后从 pos 续传
        tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
    }
    RangeOutcome::Failed
}

/// 跑完一条分块登记，并把「实际已确认落盘」的区间记入完成表。
///
/// 三件事必须一起做：
/// 1. 把块登记的 `[start, end]` 放进在途表，空闲 worker 才看得见并可能窃取；
/// 2. 无论 Done / Stolen / Failed，都按 `current` 的实际值登记已完成部分——
///    失败时已落盘的字节是有效的，丢掉它们只会让缺口变大、补下更慢；
/// 3. 从在途表移除自己，避免别的 worker 继续对一个收工的块做窃取。
async fn run_chunk(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    active: &Mutex<Vec<Arc<ActiveChunk>>>,
    completed: &Mutex<Vec<(u64, u64)>>,
    downloaded: &AtomicU64,
    cancel: &CancelFlag,
    start: u64,
    end: u64,
) {
    let chunk = Arc::new(ActiveChunk::new(start, end));
    if let Ok(mut v) = active.lock() {
        v.push(chunk.clone());
    }
    let _ = download_range(client, url, path, &chunk, end, downloaded, cancel).await;
    // 已确认落盘区间：从 start 到 current 之前一个字节
    let written_to = chunk.current.load(Ordering::Relaxed);
    if written_to > start {
        if let Ok(mut m) = completed.lock() {
            m.push((start, written_to - 1));
        }
    }
    if let Ok(mut v) = active.lock() {
        v.retain(|x| !Arc::ptr_eq(x, &chunk));
    }
}

/// 渐进式多线程分块下载（服务端支持 Range 时使用）：
/// 预分配文件 → 按 threads 分块并行拉取 → 子块失败在主线程串行补下（带重试）。
/// 全程持续落盘并节流上报进度，成功返回 Ok(())。
/// 取消：cancel 置位后子块立即停止，主线程检测到取消即删半成品文件返回取消错误。
async fn download_parallel(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    total: u64,
    threads: u32,
    on_progress: ProgressFn,
    cancel: CancelFlag,
) -> Result<(), String> {
    // 取消前置检查：进入前已被取消则不创建/预分配文件
    if cancel.load(Ordering::Relaxed) {
        return Err("下载已取消".into());
    }
    // 预分配文件，供各子块独立句柄 seek 写入
    let file = match fs::File::create(path) {
        Ok(f) => f,
        Err(e) => return Err(format!("创建文件失败: {e}")),
    };
    if let Err(e) = file.set_len(total) {
        return Err(format!("预分配文件失败: {e}"));
    }
    drop(file);

    let chunk_size = chunk_size_for(total, threads);
    let total_chunks = total.div_ceil(chunk_size);
    // 共享游标：谁空谁领下一块，不再预先给每条连接划地盘。
    let next_start = Arc::new(AtomicU64::new(0));
    let downloaded = Arc::new(AtomicU64::new(0));
    // 在途分块登记：worker 领到块就登记，完成后移除；空闲 worker 据此窃取慢块的
    // 后半段。没有这张表的话，游标领完后空闲 worker 只能退出，末尾几块就剩少数
    // 慢连接在爬——用户看到的「92%→100% 特别慢」正是这一段。
    let active: Arc<Mutex<Vec<Arc<ActiveChunk>>>> = Arc::new(Mutex::new(Vec::new()));
    // 已完成区间（闭区间），用于末尾按"落盘确认"而不是文件长度判断完整性
    let completed: Arc<Mutex<Vec<(u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));

    // 块数可能少于线程数（小文件被 MIN_CHUNK_SIZE 兜住），此时少开线程没有损失
    let worker_count = (threads as u64).min(total_chunks).max(1) as u32;
    // 窃取门槛：剩余不足 128KB 不值得再开一条连接
    let min_split = MIN_STEAL_SIZE;

    // 并行 worker：先抢新块，没新块可抢就偷别人的后半段
    let mut handles = Vec::new();
    for _ in 0..worker_count {
        let c = client.clone();
        let u = url.to_string();
        let p = path.to_path_buf();
        let dl = downloaded.clone();
        let act = active.clone();
        let done = completed.clone();
        let can = cancel.clone();
        let cursor = next_start.clone();
        handles.push(tokio::spawn(async move {
            loop {
                if can.load(Ordering::Relaxed) {
                    return;
                }
                // 1) 领新块（游标优先），领不到就去偷在途慢块的后半段
                let task = claim_chunk(&cursor, chunk_size, total)
                    .or_else(|| try_steal(&act, min_split));
                if let Some((start, end)) = task {
                    run_chunk(&c, &u, &p, &act, &done, &dl, &can, start, end).await;
                    continue;
                }
                // 2) 既没新块也没得偷：在途块还活着就等一会儿再看（它们可能被窃取
                //    下调后产生新空间），全都收工了才说明确实干完了。
                let idle = act.lock().map(|v| v.is_empty()).unwrap_or(true);
                if idle {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }));
    }

    // 进度监控循环：聚合子块已下载字节，节流回调（含实时速度）
    let monitor = {
        let dl = downloaded.clone();
        let cb = on_progress.clone();
        let can = cancel.clone();
        tokio::spawn(async move {
            let mut prev_bytes: u64 = 0;
            let mut prev_time = tokio::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                if can.load(Ordering::Relaxed) {
                    break;
                }
                let d = dl.load(Ordering::Relaxed);
                let now = tokio::time::Instant::now();
                let elapsed = now.duration_since(prev_time).as_secs_f64();
                let speed = if elapsed > 0.0 {
                    // saturating：失败重试会回退已计字节，采样间隔内计数可能变小
                    (d.saturating_sub(prev_bytes) as f64 / elapsed) as u64
                } else {
                    0
                };
                prev_bytes = d;
                prev_time = now;
                // 夹到 100：窃取时原 worker 可能多写一小段（内容相同、无害），
                // 字节数会被两家各计一次，不夹住会显示 101%。
                let percent = if total > 0 {
                    ((d * 100 / total) as u32).min(100)
                } else {
                    0
                };
                cb(DownloadProgress { downloaded: d, total, percent, speed });
                if percent >= 100 {
                    break;
                }
            }
        })
    };

    for h in handles {
        let _ = h.await;
    }
    monitor.abort();

    // 取消：worker 停止后直接删半成品文件返回，不进入补下流程
    if cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(path);
        return Err("下载已取消".into());
    }

    // 收尾补洞：按「已确认落盘」的区间算缺口，串行补齐（每段重试 3 次）。
    // 不能拿文件长度判断完整性——文件开头就 set_len(total) 预分配过，长度恒为 total，
    // 那样校验等于什么都没查。缺口来自：分块重试用尽失败、被窃取后接手方也失败。
    let mut gaps = {
        let mut done = completed.lock().map(|m| m.clone()).unwrap_or_default();
        missing_ranges(&mut done, total)
    };
    // 缺口本身也可能下不全，循环到没有缺口或重试用尽（防止无限补洞）
    for _round in 0..3 {
        if gaps.is_empty() {
            break;
        }
        for (start, end) in gaps.clone() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let chunk = Arc::new(ActiveChunk::new(start, end));
            if download_range(client, url, path, &chunk, end, &downloaded, &cancel).await
                == RangeOutcome::Done
            {
                if let Ok(mut m) = completed.lock() {
                    m.push((start, end));
                }
            }
        }
        gaps = {
            let mut done = completed.lock().map(|m| m.clone()).unwrap_or_default();
            missing_ranges(&mut done, total)
        };
    }

    if !gaps.is_empty() {
        let _ = fs::remove_file(path);
        log::warn!("[DL] 仍有 {} 段未完成，例如 {:?}", gaps.len(), &gaps[..gaps.len().min(3)]);
        return Err("分块下载失败，请检查网络后重试".into());
    }
    Ok(())
}

/// 单次单流下载尝试：成功 Ok(())，失败 Err(错误信息)，不写失败状态
/// 取消：cancel 置位立即停止写文件并返回取消错误。
async fn single_stream_attempt(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    on_progress: ProgressFn,
    cancel: &CancelFlag,
) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("下载已取消".into());
    }
    let response = match client.get(url).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return Err(format!("下载失败 HTTP {}", r.status())),
        Err(e) => return Err(format!("下载失败: {e}")),
    };
    let total = response.content_length().unwrap_or(0);
    let mut file = match fs::File::create(path) {
        Ok(f) => f,
        Err(e) => return Err(format!("创建文件失败: {e}")),
    };
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    // 节流上报 + 实时速度：每 400ms 计算一次增量速度并回调
    let mut prev_bytes: u64 = 0;
    let mut prev_time = tokio::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = fs::remove_file(path);
            return Err("下载已取消".into());
        }
        // 与并行分块同款的停滞超时：socket 被饿死时只会安静下来而不报错，
        // 单流是全部数据唯一的通道，不设超时就是永久 0%。超时按失败处理，
        // 由 download_single_stream 整体重试（换新连接）。
        match tokio::time::timeout(STALL_TIMEOUT, stream.next()).await {
            // 流正常结束
            Ok(None) => break,
            Err(_) => {
                drop(file);
                return Err(format!(
                    "下载停滞：{} 秒内未收到数据",
                    STALL_TIMEOUT.as_secs()
                ));
            }
            Ok(Some(Ok(c))) => {
                if let Err(e) = file.write_all(&c) {
                    return Err(format!("写入文件失败: {e}"));
                }
                downloaded += c.len() as u64;
                let now = tokio::time::Instant::now();
                let elapsed = now.duration_since(prev_time).as_secs_f64();
                if elapsed >= 0.4 {
                    let speed = if elapsed > 0.0 {
                        ((downloaded - prev_bytes) as f64 / elapsed) as u64
                    } else {
                        0
                    };
                    prev_bytes = downloaded;
                    prev_time = now;
                    let percent = if total > 0 { (downloaded * 100 / total) as u32 } else { 0 };
                    on_progress(DownloadProgress { downloaded, total, percent, speed });
                }
            }
            Ok(Some(Err(e))) => {
                return Err(format!("下载中断: {e}"));
            }
        }
    }
    // 收尾：上报最终进度
    let final_percent = if total > 0 { 100 } else { 0 };
    on_progress(DownloadProgress { downloaded, total, percent: final_percent, speed: 0 });
    drop(file);
    Ok(())
}

/// 单流下载（服务端不支持 Range / 大小未知 / 单线程时回退）。
/// 网络抖动/连接被截断时整体重试 3 次（间隔递增），避免一次中断即失败。
/// 取消：任意一次尝试被取消即立即返回，不再重试。
async fn download_single_stream(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    on_progress: ProgressFn,
    cancel: CancelFlag,
) -> Result<(), String> {
    const ATTEMPTS: u32 = 3;
    let mut last_err = String::from("下载失败");
    for attempt in 0..ATTEMPTS {
        if cancel.load(Ordering::Relaxed) {
            return Err("下载已取消".into());
        }
        // 重试前上报 downloading 初始进度，覆盖上次尝试残留
        if attempt > 0 {
            on_progress(DownloadProgress { downloaded: 0, total: 0, percent: 0, speed: 0 });
        }
        match single_stream_attempt(client, url, path, on_progress.clone(), &cancel).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                // 取消不重试
                if cancel.load(Ordering::Relaxed) {
                    return Err(e);
                }
                last_err = e;
                let _ = fs::remove_file(path);
                if attempt + 1 < ATTEMPTS {
                    // 递增退避：800ms / 1600ms
                    tokio::time::sleep(std::time::Duration::from_millis(800 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last_err)
}

/// 统一入口：探测 Range 支持 → 分派并行分块或单流回退，成功 Ok(())，失败 Err(错误信息)。
/// 失败时已删除半成品文件，调用方只需写失败状态。
/// cancel：取消标志，置位后立即停止下载并删除半成品文件返回"下载已取消"。
/// 图床域名的 URL 先经 cdn::rewrite_url 改写到当前生效线路；
/// 加速线路整体失败时自动回退原始域名重试一次。
pub async fn download_file(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    threads: u32,
    on_progress: ProgressFn,
    cancel: CancelFlag,
) -> Result<(), String> {
    let rewritten = crate::db::cdn::rewrite_url(url);
    let fallback = crate::db::cdn::mirror_fallback(&rewritten);
    // 仅当确实改写过（当前生效为加速域名）才具备回退条件
    let can_fallback = fallback != rewritten;
    let result =
        download_file_once(client, &rewritten, path, threads, on_progress.clone(), cancel.clone())
            .await;
    if result.is_err() && can_fallback {
        log::warn!("[CDN] 加速域名下载失败，回退原始域名重试: {}", fallback);
        return download_file_once(client, &fallback, path, threads, on_progress, cancel).await;
    }
    result
}

async fn download_file_once(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    threads: u32,
    on_progress: ProgressFn,
    cancel: CancelFlag,
) -> Result<(), String> {
    // 进入探测前先检查取消，避免取消后又创建/预分配文件
    if cancel.load(Ordering::Relaxed) {
        return Err("下载已取消".into());
    }
    // 探测是否支持 Range 分块（多线程下载的前提）。
    // 先 HEAD 探测；HEAD 失败/未确认 Range 支持时，回退 GET + Range: bytes=0-0
    // 实测（GitHub 等 CDN 对 Range 请求返回 206 + content-range，可拿到总大小）。
    let mut total: u64 = 0;
    let mut supports_range = false;
    if let Ok(Ok(r)) = tokio::time::timeout(PROBE_TIMEOUT, client.head(url).send()).await {
        if r.status().is_success() {
            total = r.content_length().unwrap_or(0);
            supports_range = r
                .headers()
                .get(reqwest::header::ACCEPT_RANGES)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.eq_ignore_ascii_case("bytes"))
                .unwrap_or(false);
        }
    }
    if total == 0 || !supports_range {
        if let Ok(Ok(r)) = tokio::time::timeout(
            PROBE_TIMEOUT,
            client
                .get(url)
                .header(reqwest::header::RANGE, "bytes=0-0")
                .send(),
        )
        .await
        {
            if r.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                // content-range: bytes 0-0/10027510 → 取斜杠后的总大小
                if let Some(cr) = r
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                {
                    if let Some(size) = cr.rsplit('/').next().and_then(|s| s.trim().parse::<u64>().ok()) {
                        total = size;
                        supports_range = size > 0;
                    }
                }
            }
        }
    }

    // 探测期间被取消：直接返回，不进入下载
    if cancel.load(Ordering::Relaxed) {
        return Err("下载已取消".into());
    }

    // HEAD/Range 探测不可用 / 大小未知 / 不支持 Range / 单线程 → 回退单流
    if total > 0 && supports_range && threads > 1 {
        download_parallel(client, url, path, total, threads, on_progress, cancel).await
    } else {
        download_single_stream(client, url, path, on_progress, cancel).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 小文件必须收敛到单块 → worker 数被块数夹成 1，等价自动回落单连接。
    /// 实测 89KB 单流 1.3s、8 分块 2.8~9.2s，多开连接是净亏。
    #[test]
    fn tiny_files_collapse_to_single_chunk() {
        assert_eq!(chunk_size_for(89_216, 8), MIN_CHUNK_SIZE);
        assert_eq!(89_216u64.div_ceil(chunk_size_for(89_216, 8)), 1);
    }

    /// 6MB 这类典型 mod 包：块数要明显多于线程数，慢连接才只拖住一小块。
    #[test]
    fn six_megabyte_file_yields_many_chunks_for_stealing() {
        let total = 6_346_251u64;
        let cs = chunk_size_for(total, 8);
        assert_eq!(cs, MIN_CHUNK_SIZE);
        let chunks = total.div_ceil(cs);
        assert!(chunks >= 20, "块数 {chunks} 太少，慢连接会拖住过大一段");
    }

    /// 超大文件才触到上限，之后靠块数而非线程数扩展并发。
    #[test]
    fn huge_files_cap_at_max_chunk() {
        assert_eq!(chunk_size_for(100 * 1024 * 1024, 8), MAX_CHUNK_SIZE);
    }

    /// 中间尺寸落在上下限之间且块能覆盖整个文件。
    #[test]
    fn mid_size_splits_proportionally() {
        let total = 16 * 1024 * 1024;
        let cs = chunk_size_for(total, 8);
        assert!(cs >= MIN_CHUNK_SIZE && cs <= MAX_CHUNK_SIZE);
        assert!(cs * total.div_ceil(cs) >= total);
    }

    /// 线程数被夹到至少 1，且任何输入都不会返回 0（否则游标会原地踏步）。
    #[test]
    fn chunk_size_is_never_zero() {
        for total in [0u64, 1, 1023, 64 * 1024, 5 * 1024 * 1024] {
            for threads in [0u32, 1, 8, 16] {
                assert!(chunk_size_for(total, threads) >= MIN_CHUNK_SIZE);
            }
        }
    }

    /// 领块游标：连续领取应严丝合缝覆盖整个文件，末尾块按 total 截断。
    #[test]
    fn cursor_claims_cover_file_without_overlap() {
        let total = 6_346_251u64;
        let cs = MIN_CHUNK_SIZE;
        let cursor = AtomicU64::new(0);
        let mut claims = Vec::new();
        while let Some(c) = claim_chunk(&cursor, cs, total) {
            claims.push(c);
            assert!(claims.len() < 10_000, "领块不收敛，游标可能没前进");
        }
        assert_eq!(claims[0].0, 0);
        assert_eq!(claims.last().unwrap().1, total - 1);
        for w in claims.windows(2) {
            assert_eq!(w[0].1 + 1, w[1].0, "相邻块之间出现缝隙或重叠");
        }
    }

    /// 游标越过末尾必须返回 None，不能退化成 0 长度块（否则 worker 会空转）。
    #[test]
    fn cursor_returns_none_past_end() {
        let cursor = AtomicU64::new(100);
        assert_eq!(claim_chunk(&cursor, 64, 100), None);
    }

    /// 窃取：把最大在途块的剩余部分对半切开，且原块边界被同步下调到中缝，
    /// 两块不重叠。这正是治「末段变慢」的核心保证。
    #[test]
    fn steal_splits_largest_chunk_without_overlap() {
        let small = Arc::new(ActiveChunk::new(0, 100 * 1024 - 1));
        let big = Arc::new(ActiveChunk::new(300 * 1024, 300 * 1024 + 400 * 1024 - 1));
        let active = Mutex::new(vec![small.clone(), big.clone()]);

        let (steal_start, steal_end) = try_steal(&active, MIN_STEAL_SIZE).expect("应当可窃取");
        // 偷的是剩余最多的那块（big），从其中缝到其末端
        assert_eq!(steal_end, 300 * 1024 + 400 * 1024 - 1);
        assert!(steal_start > 300 * 1024 && steal_start < steal_end);
        // 原块收工边界下移到中缝，二者正好接上、不重叠
        assert_eq!(big.stop_at.load(Ordering::Relaxed), steal_start);
        assert_eq!(small.stop_at.load(Ordering::Relaxed), 100 * 1024);
    }

    /// 剩余太小的块不该被窃取（再开一条连接的握手成本会盖过收益）。
    #[test]
    fn steal_skips_chunks_below_threshold() {
        let tiny = Arc::new(ActiveChunk::new(0, MIN_STEAL_SIZE * 2 - 2));
        let active = Mutex::new(vec![tiny]);
        assert!(try_steal(&active, MIN_STEAL_SIZE).is_none());
    }

    /// 空表时不可窃取，且 worker 据此判定"确实干完了"而不是空转。
    #[test]
    fn steal_from_empty_returns_none() {
        let active: Mutex<Vec<Arc<ActiveChunk>>> = Mutex::new(Vec::new());
        assert!(try_steal(&active, MIN_STEAL_SIZE).is_none());
    }

    /// 缺口计算：已确认区间应正确合并，返回未覆盖部分。
    #[test]
    fn missing_ranges_reports_gaps() {
        // 完整覆盖
        let mut done = vec![(0u64, 99u64)];
        assert!(missing_ranges(&mut done, 100).is_empty());
        // 中间有洞 + 尾部缺失
        let mut done = vec![(0u64, 9u64), (20, 29)];
        assert_eq!(missing_ranges(&mut done, 40), vec![(10, 19), (30, 39)]);
        // 乱序输入也要能合并
        let mut done = vec![(20u64, 29u64), (0, 9)];
        assert_eq!(missing_ranges(&mut done, 30), vec![(10, 19)]);
        // 一段都没有：整份都缺
        let mut done: Vec<(u64, u64)> = vec![];
        assert_eq!(missing_ranges(&mut done, 50), vec![(0, 49)]);
    }

    /// 缺口计算必须能发现"预分配吞掉空洞"的情况——文件长度恒为 total，
    /// 只有按已确认区间算才能抓到未下载的部分。
    #[test]
    fn missing_ranges_detects_hole_that_file_len_hides() {
        let total = 1000u64;
        // 首尾都下了，中间 100..500 未确认（文件长度仍是 1000）
        let mut done = vec![(0u64, 99u64), (500, 999)];
        assert_eq!(missing_ranges(&mut done, total), vec![(100, 499)]);
    }
}
