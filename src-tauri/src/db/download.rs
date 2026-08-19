// 渐进式多线程下载引擎：BepInEx 前置安装（db/bepinex.rs）与程序更新（db/installer.rs）共用。
//
// 服务端支持 Range 时按 threads（默认 8）分块并行下载（渐进式落盘 + 节流进度上报）；
// 单个子块失败会在子任务内重试，仍失败则主线程串行补下失败区间，子线程失败不影响主流程；
// 服务端不支持 Range / 大小未知 / 单线程时自动回退单流下载（整体重试 3 次）。
// 进度经 on_progress 回调上报（percent + downloaded + total + speed，约 400ms 节流），
// 具体写库/广播事件由调用方实现（update-progress / bepinex-progress 各自独立）。
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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

/// 下载 [start, end] 闭区间到文件对应偏移（独立句柄 + seek，与其它子块互不干扰）。
/// 内部重试 3 次；成功返回 Ok(())，最终失败返回 Err(())，已写字节数会回退，
/// 由调用方（主线程）决定是否补下该区间——子线程失败不影响主流程。
async fn download_range(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    start: u64,
    end: u64,
    downloaded: &AtomicU64,
) -> Result<(), ()> {
    const ATTEMPTS: u32 = 3;
    for attempt in 0..ATTEMPTS {
        let range = format!("bytes={}-{}", start, end);
        let resp = match client
            .get(url)
            .header(reqwest::header::RANGE, range)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => {
                tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
                continue;
            }
        };
        let mut file = match tokio::fs::OpenOptions::new().write(true).open(path).await {
            Ok(f) => f,
            Err(_) => continue,
        };
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            continue;
        }
        let mut stream = resp.bytes_stream();
        let mut written: u64 = 0;
        let mut stream_err = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(c) => {
                    if file.write_all(&c).await.is_err() {
                        stream_err = true;
                        break;
                    }
                    written += c.len() as u64;
                }
                Err(_) => {
                    stream_err = true;
                    break;
                }
            }
        }
        drop(file);
        // 进度只统计成功写入的字节；失败时回退，避免重试重复计数
        downloaded.fetch_add(written, Ordering::Relaxed);
        if !stream_err && written == end - start + 1 {
            return Ok(());
        }
        downloaded.fetch_sub(written, Ordering::Relaxed);
        tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64 + 1))).await;
    }
    Err(())
}

/// 渐进式多线程分块下载（服务端支持 Range 时使用）：
/// 预分配文件 → 按 threads 分块并行拉取 → 子块失败在主线程串行补下（带重试）。
/// 全程持续落盘并节流上报进度，成功返回 Ok(())。
async fn download_parallel(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    total: u64,
    threads: u32,
    on_progress: ProgressFn,
) -> Result<(), String> {
    // 预分配文件，供各子块独立句柄 seek 写入
    let file = match fs::File::create(path) {
        Ok(f) => f,
        Err(e) => return Err(format!("创建文件失败: {e}")),
    };
    if let Err(e) = file.set_len(total) {
        return Err(format!("预分配文件失败: {e}"));
    }
    drop(file);

    let chunk_size = total.div_ceil(threads as u64);
    let downloaded = Arc::new(AtomicU64::new(0));
    let failed_ranges: Arc<std::sync::Mutex<Vec<(u64, u64)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));

    // 并行子块任务
    let mut handles = Vec::new();
    for i in 0..threads {
        let start = (i as u64) * chunk_size;
        if start >= total {
            break;
        }
        let end = (start + chunk_size - 1).min(total - 1);
        let c = client.clone();
        let u = url.to_string();
        let p = path.to_path_buf();
        let dl = downloaded.clone();
        let failed = failed_ranges.clone();
        handles.push(tokio::spawn(async move {
            if download_range(&c, &u, &p, start, end, &dl).await.is_err() {
                if let Ok(mut m) = failed.lock() {
                    m.push((start, end));
                }
            }
        }));
    }

    // 进度监控循环：聚合子块已下载字节，节流回调（含实时速度）
    let monitor = {
        let dl = downloaded.clone();
        let cb = on_progress.clone();
        tokio::spawn(async move {
            let mut prev_bytes: u64 = 0;
            let mut prev_time = tokio::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                let d = dl.load(Ordering::Relaxed);
                let now = tokio::time::Instant::now();
                let elapsed = now.duration_since(prev_time).as_secs_f64();
                let speed = if elapsed > 0.0 {
                    ((d - prev_bytes) as f64 / elapsed) as u64
                } else {
                    0
                };
                prev_bytes = d;
                prev_time = now;
                let percent = if total > 0 { (d * 100 / total) as u32 } else { 0 };
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

    // 子线程失败不影响主流程：主线程串行补下失败区间（每个区间再重试 3 次）
    let failed = failed_ranges.lock().map(|m| m.clone()).unwrap_or_default();
    for (start, end) in failed {
        let mut ok = false;
        for _ in 0..3 {
            if download_range(client, url, path, start, end, &downloaded).await.is_ok() {
                ok = true;
                break;
            }
        }
        if !ok {
            let _ = fs::remove_file(path);
            return Err("分块下载失败，请检查网络后重试".into());
        }
    }

    // 完整性校验：落盘字节数必须等于 Content-Length
    let real_len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if real_len != total {
        let _ = fs::remove_file(path);
        return Err("文件完整性校验失败".into());
    }
    Ok(())
}

/// 单次单流下载尝试：成功 Ok(())，失败 Err(错误信息)，不写失败状态
async fn single_stream_attempt(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    on_progress: ProgressFn,
) -> Result<(), String> {
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
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(c) => {
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
            Err(e) => {
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
async fn download_single_stream(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    on_progress: ProgressFn,
) -> Result<(), String> {
    const ATTEMPTS: u32 = 3;
    let mut last_err = String::from("下载失败");
    for attempt in 0..ATTEMPTS {
        // 重试前上报 downloading 初始进度，覆盖上次尝试残留
        if attempt > 0 {
            on_progress(DownloadProgress { downloaded: 0, total: 0, percent: 0, speed: 0 });
        }
        match single_stream_attempt(client, url, path, on_progress.clone()).await {
            Ok(()) => return Ok(()),
            Err(e) => {
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
pub async fn download_file(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    threads: u32,
    on_progress: ProgressFn,
) -> Result<(), String> {
    // 探测是否支持 Range 分块（多线程下载的前提）。
    // 先 HEAD 探测；HEAD 失败/未确认 Range 支持时，回退 GET + Range: bytes=0-0
    // 实测（GitHub 等 CDN 对 Range 请求返回 206 + content-range，可拿到总大小）。
    let mut total: u64 = 0;
    let mut supports_range = false;
    if let Ok(r) = client.head(url).send().await {
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
        if let Ok(r) = client
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .send()
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

    // HEAD/Range 探测不可用 / 大小未知 / 不支持 Range / 单线程 → 回退单流
    if total > 0 && supports_range && threads > 1 {
        download_parallel(client, url, path, total, threads, on_progress).await
    } else {
        download_single_stream(client, url, path, on_progress).await
    }
}
