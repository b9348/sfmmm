pub(crate) mod downloads;
pub(crate) mod reactions;
pub(crate) mod translation;

use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub(crate) const LABEL: &str = "f95-login";
pub(crate) fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } if window.label() == LABEL => {
            api.prevent_close();
            let _ = window.hide();
        }
        tauri::WindowEvent::Destroyed if window.label() == "main" => {
            if let Some(browser) = window.app_handle().get_webview_window(LABEL) {
                let _ = browser.destroy();
            }
        }
        _ => {}
    }
}

const ORIGIN: &str = "https://f95zone.to";
const LOGIN: &str = "https://f95zone.to/login/";
const REGISTER: &str = "https://f95zone.to/register/";

const SEARCH: &str = "https://f95zone.to/search/";
static REACTION_JOB: AtomicU64 = AtomicU64::new(0);
static LOGIN_WINDOW_PENDING: AtomicBool = AtomicBool::new(false);
static LOGIN_WAITING_FOR_PAGE: AtomicBool = AtomicBool::new(false);
static LOGIN_PAGE_READY: AtomicBool = AtomicBool::new(false);
static LOGIN_REQUESTED_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);
static STOP_SCAN: AtomicBool = AtomicBool::new(false);
static BROWSER_WORK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

type CachedPages = BTreeMap<usize, SamplePage>;
const CACHE_SCHEMA: &str =
    "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS translations (post_id TEXT NOT NULL, language TEXT NOT NULL,
        source TEXT NOT NULL, text TEXT NOT NULL, formatted INTEGER NOT NULL,
        PRIMARY KEY (post_id, language, source));";

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheMode {
    #[default]
    Addresses,
    Content,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum ScanCoverage {
    #[default]
    Unknown,
    Partial,
    Complete,
}

#[derive(Default, serde::Deserialize, serde::Serialize)]
struct ScanCache {
    mode: CacheMode,
    pages: CachedPages,
    #[serde(default)]
    opening: Option<SampleEntry>,
    #[serde(default)]
    coverage: ScanCoverage,
}

#[derive(PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanKind {
    Update,
    Full,
    Recheck,
    New,
}

#[derive(serde::Serialize)]
pub struct SampleProgress {
    mode: CacheMode,
    coverage: ScanCoverage,
    activity: Option<PageActivity>,
    pages: usize,
    posts: usize,
    candidates: usize,
    entries: Vec<SampleCard>,
}

#[derive(serde::Serialize)]
struct PageActivity {
    current: usize,
    read: usize,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct SamplePage {
    thread: String,
    title: String,
    ids: Vec<String>,
    page: usize,
    posts: usize,
    candidates: usize,
    next: Option<String>,
    entries: Vec<SampleEntry>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct SampleEntry {
    id: String,
    page: usize,
    number: Option<usize>,
    #[serde(default)]
    likes: Option<usize>,
    first: bool,
    preview: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    content_html: Option<String>,
    #[serde(default)]
    mod_title: Option<String>,
    #[serde(default, skip_serializing)]
    release_urls: Vec<String>,
    #[serde(default)]
    links: Vec<PostLink>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct PostLink {
    url: String,
    label: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleCard {
    id: String,
    page: usize,
    number: usize,
    likes: Option<usize>,
    first: bool,
    mod_title: Option<String>,
    preview: String,
    has_content: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedThreads {
    threads: Vec<ThreadResult>,
    directory: std::path::PathBuf,
    force_content: bool,
    scans: BTreeMap<String, SampleProgress>,
}

impl SampleEntry {
    fn retain_for_mode(&mut self, mode: CacheMode) {
        if mode == CacheMode::Addresses {
            self.preview.clear();
            self.content = None;
            self.content_html = None;
            self.links.clear();
        }
    }
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct ThreadResult {
    url: String,
    title: String,
    preview: String,
    #[serde(default)]
    likes: Option<usize>,
}

#[derive(serde::Serialize)]
pub struct LikeProgress {
    thread: ThreadResult,
    scan: SampleProgress,
}

#[derive(serde::Deserialize)]
struct SearchPage {
    url: String,
    next: Option<String>,
    threads: Vec<ThreadResult>,
}

fn thread_id(url: &Url) -> Option<&str> {
    if url.origin().ascii_serialization() != ORIGIN {
        return None;
    }
    let slug = url.path().strip_prefix("/threads/")?.split('/').next()?;
    let id = slug.rsplit('.').next()?;
    (!id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())).then_some(id)
}

fn parse_thread(url: &str) -> Result<(Url, String), &'static str> {
    let mut url = Url::parse(url).map_err(|_| "postOpen")?;
    let id = thread_id(&url).ok_or("postOpen")?.to_owned();
    let slug = url
        .path()
        .strip_prefix("/threads/")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    if url.path().trim_end_matches('/') != format!("/threads/{slug}") {
        return Err("postOpen");
    }
    let path = format!("/threads/{slug}/");
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok((url, id))
}

const CACHE_DIR_KEY: &str = "f95_cache_directory";
const CACHE_FILE: &str = "f95-cache.db";

fn default_cache_directory(window: &WebviewWindow) -> Result<std::path::PathBuf, &'static str> {
    let local = window
        .app_handle()
        .path()
        .app_local_data_dir()
        .map_err(|_| "cacheRead")?;
    Ok(local.join("f95-cache"))
}

fn cache_directory(window: &WebviewWindow) -> Result<std::path::PathBuf, &'static str> {
    let config = crate::db::subscribe::open_sqlite(window.app_handle()).map_err(|_| "cacheRead")?;
    let custom = config
        .query_row(
            "SELECT value FROM config WHERE key = ?1",
            [CACHE_DIR_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "cacheRead")?;
    if let Some(path) = custom.filter(|value| !value.is_empty()) {
        return Ok(path.into());
    }
    let default = default_cache_directory(window)?;
    let legacy = default.with_file_name(CACHE_FILE);
    if legacy.is_file() && !default.join(CACHE_FILE).exists() {
        std::fs::create_dir_all(&default).map_err(|_| "cacheWrite")?;
        std::fs::rename(legacy, default.join(CACHE_FILE)).map_err(|_| "cacheWrite")?;
    }
    Ok(default)
}

fn cache_db(window: &WebviewWindow) -> Result<Connection, &'static str> {
    let dir = cache_directory(window)?;
    std::fs::create_dir_all(&dir).map_err(|_| "cacheRead")?;
    let db = Connection::open(dir.join(CACHE_FILE)).map_err(|_| "cacheRead")?;
    db.pragma_update(None, "secure_delete", true)
        .map_err(|_| "cacheRead")?;
    db.execute_batch(CACHE_SCHEMA).map_err(|_| "cacheRead")?;
    Ok(db)
}

fn display_directory(path: &std::path::Path) -> std::path::PathBuf {
    let resolved = path
        .canonicalize()
        .ok()
        .or_else(|| Some(path.parent()?.canonicalize().ok()?.join(path.file_name()?)))
        .unwrap_or_else(|| path.to_path_buf());
    #[cfg(windows)]
    {
        let value = resolved.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}").into();
        }
        if let Some(normal) = value.strip_prefix(r"\\?\") {
            return normal.into();
        }
    }
    resolved
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheLocation {
    directory: std::path::PathBuf,
    default_directory: std::path::PathBuf,
    source_retained: bool,
}

#[tauri::command]
pub async fn f95_cache_location(window: WebviewWindow) -> Result<CacheLocation, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    Ok(CacheLocation {
        directory: display_directory(&cache_directory(&window)?),
        default_directory: display_directory(&default_cache_directory(&window)?),
        source_retained: false,
    })
}

#[tauri::command]
pub async fn f95_set_cache_location(
    window: WebviewWindow,
    directory: Option<String>,
    migrate: bool,
) -> Result<CacheLocation, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.try_lock().map_err(|_| "cacheLocationBusy")?;
    let default_directory = default_cache_directory(&window)?;
    let source = cache_directory(&window)?.join(CACHE_FILE);
    let target: std::path::PathBuf = directory
        .as_ref()
        .map_or_else(|| default_directory.clone(), |dir| dir.into());
    if !target.is_absolute() {
        return Err("cacheLocationInvalid");
    }
    std::fs::create_dir_all(&target).map_err(|_| "cacheLocationInvalid")?;
    let target = target.canonicalize().map_err(|_| "cacheLocationInvalid")?;
    let destination = target.join(CACHE_FILE);
    let same = source == destination
        || source.parent().and_then(|path| path.canonicalize().ok()) == Some(target.clone());
    let mut copied = false;
    if !same && migrate && source.is_file() {
        let old = Connection::open(&source).map_err(|_| "cacheRead")?;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "cacheLocationExists"
                } else {
                    "cacheWrite"
                }
            })?;
        if old
            .execute("VACUUM INTO ?1", [destination.to_string_lossy().as_ref()])
            .is_err()
        {
            let _ = std::fs::remove_file(&destination);
            return Err("cacheWrite");
        }
        copied = true;
    } else if !same && destination.exists() {
        let existing =
            Connection::open_with_flags(&destination, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| "cacheLocationInvalid")?;
        let tables: usize = existing.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('threads','scans','preferences')",
            [], |row| row.get(0)).map_err(|_| "cacheLocationInvalid")?;
        if tables != 3 {
            return Err("cacheLocationInvalid");
        }
    }
    let setting = directory
        .map(|_| display_directory(&target).to_string_lossy().into_owned())
        .unwrap_or_default();
    let saved = crate::db::subscribe::open_sqlite(window.app_handle()).and_then(|db| {
        db.execute("INSERT INTO config (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![CACHE_DIR_KEY, setting]).map_err(|error| error.to_string())
    });
    if saved.is_err() {
        if copied {
            let _ = std::fs::remove_file(&destination);
        }
        return Err("cacheWrite");
    }
    let source_retained = copied && std::fs::remove_file(source).is_err();
    let directory = if setting.is_empty() {
        default_directory.clone()
    } else {
        target
    };
    Ok(CacheLocation {
        directory: display_directory(&directory),
        default_directory: display_directory(&default_directory),
        source_retained,
    })
}

fn read_threads(window: &WebviewWindow) -> Result<Vec<ThreadResult>, &'static str> {
    let db = cache_db(window)?;
    let mut query = db
        .prepare("SELECT data FROM threads ORDER BY rowid")
        .map_err(|_| "cacheRead")?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "cacheRead")?;
    rows.map(|row| serde_json::from_str(&row.map_err(|_| "cacheRead")?).map_err(|_| "cacheRead"))
        .collect()
}

fn save_threads(window: &WebviewWindow, threads: &[ThreadResult]) -> Result<(), &'static str> {
    let mut db = cache_db(window)?;
    let tx = db.transaction().map_err(|_| "cacheWrite")?;
    for thread in threads {
        let (_, id) = parse_thread(&thread.url)?;
        let data = serde_json::to_string(thread).map_err(|_| "cacheWrite")?;
        tx.execute(
            "INSERT INTO threads (id, data) VALUES (?1, ?2)
                    ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![id, data],
        )
        .map_err(|_| "cacheWrite")?;
    }
    tx.commit().map_err(|_| "cacheWrite")
}

fn read_scan(window: &WebviewWindow, id: &str) -> Result<ScanCache, &'static str> {
    read_scan_data(&cache_db(window)?, id)
}

fn read_scan_data(db: &Connection, id: &str) -> Result<ScanCache, &'static str> {
    let cached = db
        .query_row("SELECT data FROM scans WHERE id = ?1", [id], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|_| "cacheRead")?;
    let Some(json) = cached else {
        return Ok(ScanCache::default());
    };
    decode_scan(&json)
}

fn decode_scan(json: &str) -> Result<ScanCache, &'static str> {
    if let Ok(cache) = serde_json::from_str::<ScanCache>(json) {
        return Ok(cache);
    }
    let pages = serde_json::from_str::<CachedPages>(json).map_err(|_| "cacheRead")?;
    let mut cache = ScanCache {
        mode: CacheMode::Addresses,
        pages,
        ..Default::default()
    };
    strip_for_mode(&mut cache, CacheMode::Addresses);
    Ok(cache)
}

fn save_scan(window: &WebviewWindow, id: &str, cache: &ScanCache) -> Result<(), &'static str> {
    write_scan(&cache_db(window)?, id, cache)
}

fn write_scan(db: &Connection, id: &str, cache: &ScanCache) -> Result<(), &'static str> {
    let data = serde_json::to_string(cache).map_err(|_| "cacheWrite")?;
    db.execute(
        "INSERT INTO scans (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        params![id, data],
    ).map_err(|_| "cacheWrite")?;
    Ok(())
}

fn force_content(db: &Connection) -> Result<bool, &'static str> {
    db.query_row(
        "SELECT value FROM preferences WHERE key = 'force_content'",
        [],
        |row| row.get(0),
    )
    .optional()
    .map(|value| value.unwrap_or(false))
    .map_err(|_| "cacheRead")
}

fn effective_mode(window: &WebviewWindow, mode: CacheMode) -> Result<CacheMode, &'static str> {
    Ok(if force_content(&cache_db(window)?)? {
        CacheMode::Content
    } else {
        mode
    })
}

fn strip_for_mode(cache: &mut ScanCache, mode: CacheMode) {
    if mode == CacheMode::Addresses {
        cache.opening = None;
    }
    for entry in cache.pages.values_mut().flat_map(|page| &mut page.entries) {
        entry.retain_for_mode(mode);
    }
}

fn scan_summary(cache: &ScanCache) -> SampleProgress {
    scan_summary_with_previews(cache, &BTreeMap::new())
}

fn sample_card(entry: &SampleEntry, number: usize, live: &BTreeMap<String, String>) -> SampleCard {
    SampleCard {
        id: entry.id.clone(),
        page: entry.page,
        number,
        likes: entry.likes,
        first: entry.first,
        mod_title: entry.mod_title.clone(),
        preview: live
            .get(&entry.id)
            .cloned()
            .unwrap_or_else(|| entry.preview.clone()),
        has_content: entry.content.is_some(),
    }
}

fn scan_summary_with_previews(
    cache: &ScanCache,
    live: &BTreeMap<String, String>,
) -> SampleProgress {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    if let Some(opening) = &cache.opening {
        seen.insert(&opening.id);
        entries.push(sample_card(opening, 1, live));
    }
    let mut offset = 0;
    for page in cache.pages.values() {
        for entry in &page.entries {
            if (entry.first && cache.opening.is_some()) || !seen.insert(&entry.id) {
                continue;
            }
            let number = entry
                .number
                .or_else(|| {
                    page.ids
                        .iter()
                        .position(|id| post_number_id(id) == entry.id)
                        .map(|index| offset + index + 1)
                })
                .unwrap_or_else(|| (entry.page.saturating_sub(1) * 20) + 1);
            entries.push(sample_card(entry, number, live));
        }
        offset += page.posts;
    }
    SampleProgress {
        mode: cache.mode,
        coverage: cache.coverage,
        activity: None,
        pages: cache.pages.len(),
        posts: cache.pages.values().map(|page| page.posts).sum(),
        candidates: cache.pages.values().map(|page| page.candidates).sum(),
        entries,
    }
}

#[derive(serde::Serialize)]
pub struct CachedOpening {
    post: SampleEntry,
    scan: SampleProgress,
}

#[tauri::command]
pub async fn f95_cache_thread_opening(
    window: WebviewWindow,
    thread_url: String,
) -> Result<CachedOpening, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    STOP_SCAN.store(false, Ordering::Relaxed);
    let (url, id) = parse_thread(&thread_url)?;
    let mut cache = read_scan(&window, &id)?;
    if effective_mode(&window, cache.mode)? != CacheMode::Content {
        return Err("cacheRead");
    }
    if let Some(post) = cache
        .opening
        .iter()
        .chain(cache.pages.values().flat_map(|page| &page.entries))
        .find(|entry| entry.first && entry.content.is_some())
    {
        return Ok(CachedOpening {
            post: post.clone(),
            scan: scan_summary(&cache),
        });
    }
    let browser = signed_in_browser(&window)?;
    browser.hide().map_err(|_| "sampleRead")?;
    let page = fetch_thread_page(&browser, url, &id, 1, true)
        .await
        .map_err(|_| "openingUnavailable")?;
    let mut post = page
        .entries
        .into_iter()
        .find(|entry| {
            entry.first
                && entry
                    .content_html
                    .as_ref()
                    .is_some_and(|html| !html.trim().is_empty())
        })
        .ok_or("openingUnavailable")?;
    hydrate_likes(&browser, std::slice::from_mut(&mut post)).await?;
    cache.opening = Some(post.clone());
    // A cached opening post does not establish that the rest of page one was scanned.
    save_scan(&window, &id, &cache)?;
    Ok(CachedOpening {
        post,
        scan: scan_summary(&cache),
    })
}

#[tauri::command]
pub async fn f95_refresh_cached_post(
    window: WebviewWindow,
    thread_url: String,
    post_id: String,
) -> Result<SampleEntry, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    STOP_SCAN.store(false, Ordering::Relaxed);
    let (_, thread_id) = parse_thread(&thread_url)?;
    let mut cache = read_scan(&window, &thread_id)?;
    if effective_mode(&window, cache.mode)? != CacheMode::Content {
        return Err("cacheRead");
    }
    let cached = cache
        .opening
        .iter_mut()
        .chain(cache.pages.values_mut().flat_map(|page| &mut page.entries))
        .find(|entry| entry.id == post_id && entry.content.is_some())
        .ok_or("cacheRead")?;
    let id = post_id
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or("postOpen")?;
    let target = Url::parse(&format!("{ORIGIN}/posts/{id}/")).map_err(|_| "postOpen")?;
    let browser = signed_in_browser(&window)?;
    browser.hide().map_err(|_| "sampleRead")?;
    mark_previous_page(&browser).await?;
    browser.navigate(target).map_err(|_| "sampleRead")?;
    let page = inspect_thread_page(&browser, true, Some(&post_id), |page| {
        page.thread == thread_id && page.entries.iter().any(|entry| entry.id == post_id)
    })
    .await?;
    let fresh = page
        .entries
        .into_iter()
        .find(|entry| entry.id == post_id)
        .ok_or("sampleRead")?;
    if fresh.content_html.is_none() {
        return Err("sampleRead");
    }
    cached.preview = fresh.preview;
    cached.content = fresh.content;
    cached.content_html = fresh.content_html;
    cached.mod_title = fresh.mod_title;
    cached.links = fresh.links;
    let result = cached.clone();
    save_scan(&window, &thread_id, &cache)?;
    Ok(result)
}

#[tauri::command]
pub async fn f95_cached_threads(window: WebviewWindow) -> Result<CachedThreads, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    let threads = read_threads(&window)?;
    let db = cache_db(&window)?;
    let mut scans = BTreeMap::new();
    for thread in &threads {
        let (_, id) = parse_thread(&thread.url)?;
        let cache = read_scan_data(&db, &id)?;
        scans.insert(thread.url.clone(), scan_summary(&cache));
    }
    Ok(CachedThreads {
        threads,
        scans,
        directory: cache_directory(&window)?,
        force_content: force_content(&db)?,
    })
}

#[tauri::command]
pub fn f95_stop_scan(window: WebviewWindow) -> Result<(), &'static str> {
    require_main(&window)?;
    STOP_SCAN.store(true, Ordering::Relaxed);
    Ok(())
}

fn check_scan() -> Result<(), &'static str> {
    if STOP_SCAN.load(Ordering::Relaxed) {
        Err("scanStopped")
    } else {
        Ok(())
    }
}

fn scan_error(default: &'static str) -> &'static str {
    check_scan().err().unwrap_or(default)
}

#[tauri::command]
pub async fn f95_set_force_content(
    window: WebviewWindow,
    enabled: bool,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    update_force_content(&mut cache_db(&window)?, enabled)
}

fn update_force_content(db: &mut Connection, enabled: bool) -> Result<(), &'static str> {
    let tx = db.transaction().map_err(|_| "cacheWrite")?;
    tx.execute(
        "INSERT INTO preferences (key, value) VALUES ('force_content', ?1)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [enabled],
    )
    .map_err(|_| "cacheWrite")?;
    if !enabled {
        let rows: Vec<(String, String)> = {
            let mut query = tx
                .prepare("SELECT id, data FROM scans")
                .map_err(|_| "cacheRead")?;
            let rows = query
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|_| "cacheRead")?;
            rows.collect::<Result<_, _>>().map_err(|_| "cacheRead")?
        };
        for (id, data) in rows {
            let mut cache = decode_scan(&data)?;
            if cache.mode == CacheMode::Addresses {
                strip_for_mode(&mut cache, CacheMode::Addresses);
                write_scan(&tx, &id, &cache)?;
            }
        }
    }
    tx.commit().map_err(|_| "cacheWrite")
}

#[tauri::command]
pub async fn f95_cached_post(
    window: WebviewWindow,
    thread_url: String,
    post_id: String,
) -> Result<Option<SampleEntry>, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    let (_, id) = parse_thread(&thread_url)?;
    let cache = read_scan(&window, &id)?;
    if effective_mode(&window, cache.mode)? != CacheMode::Content {
        return Ok(None);
    }
    Ok(cache
        .opening
        .into_iter()
        .chain(cache.pages.into_values().flat_map(|page| page.entries))
        .find(|entry| entry.id == post_id && entry.content.is_some()))
}

#[tauri::command]
pub async fn f95_cached_thread(
    window: WebviewWindow,
    thread_url: String,
) -> Result<SampleProgress, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    let (_, id) = parse_thread(&thread_url)?;
    Ok(scan_summary(&read_scan(&window, &id)?))
}

#[tauri::command]
pub async fn f95_set_cache_mode(
    window: WebviewWindow,
    thread_url: String,
    mode: CacheMode,
) -> Result<SampleProgress, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    let (_, id) = parse_thread(&thread_url)?;
    let mut cache = read_scan(&window, &id)?;
    cache.mode = mode;
    let effective = effective_mode(&window, mode)?;
    strip_for_mode(&mut cache, effective);
    save_scan(&window, &id, &cache)?;
    Ok(scan_summary(&cache))
}

fn require_main(window: &WebviewWindow) -> Result<(), &'static str> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("unexpected")
    }
}

#[tauri::command]
pub async fn f95_open_login(window: WebviewWindow) -> Result<(), &'static str> {
    open_account_window(window, false).await
}

#[tauri::command]
pub async fn f95_open_registration(window: WebviewWindow) -> Result<(), &'static str> {
    open_account_window(window, true).await
}

async fn open_account_window(window: WebviewWindow, register: bool) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    let app = window.app_handle();
    let destination = Url::parse(if register { REGISTER } else { LOGIN }).unwrap();

    if let Some(browser) = app.get_webview_window(LABEL) {
        let is_registration = browser.url().ok().is_some_and(|url| {
            url.origin().ascii_serialization() == ORIGIN
                && url.path().trim_matches('/').split('/').next() == Some("register")
        });
        if register != is_registration {
            browser.navigate(destination).map_err(|_| "windowOpen")?;
        }
        show_login_window(&browser)?;
        LOGIN_WINDOW_PENDING.store(!register, Ordering::Relaxed);
        LOGIN_WAITING_FOR_PAGE.store(false, Ordering::Relaxed);
        return Ok(());
    }
    LOGIN_PAGE_READY.store(false, Ordering::Relaxed);
    let profile = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "windowOpen")?
        .join("f95-profile");
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(destination))
        .title("F95Zone")
        .visible(false)
        .on_page_load(|_, page| {
            if matches!(page.event(), PageLoadEvent::Finished)
                && page.url().origin().ascii_serialization() == ORIGIN
            {
                LOGIN_PAGE_READY.store(true, Ordering::Relaxed);
            }
        })
        .menu(translation::menu(app).map_err(|_| "windowOpen")?)
        .on_menu_event(translation::handle_menu)
        .inner_size(980.0, 720.0)
        .data_directory(profile)
        .devtools(false)
        .on_navigation(|url| {
            url.origin().ascii_serialization() == ORIGIN
                || downloads::allows_attachment_navigation(url)
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(downloads::handle_download);

    if let Some(url) = std::env::var("SFMMM_F95_PROXY")
        .ok()
        .and_then(|value| Url::parse(&value).ok())
    {
        if matches!(url.scheme(), "http" | "socks5") {
            builder = builder.proxy_url(url);
        }
    }
    let browser = builder.build().map_err(|_| "windowOpen")?;
    LOGIN_WINDOW_PENDING.store(!register, Ordering::Relaxed);
    LOGIN_WAITING_FOR_PAGE.store(!register, Ordering::Relaxed);
    if register {
        show_login_window(&browser)?;
    } else {
        *LOGIN_REQUESTED_AT.lock().map_err(|_| "windowOpen")? = Some(std::time::Instant::now());
    }
    Ok(())
}

fn show_login_window(browser: &WebviewWindow) -> Result<(), &'static str> {
    browser.show().map_err(|_| "windowOpen")?;
    browser.set_focus().map_err(|_| "windowOpen")
}

#[derive(serde::Serialize)]
pub struct F95Status {
    status: &'static str,
    account: Option<String>,
}

#[tauri::command]
pub async fn f95_status(window: WebviewWindow) -> Result<F95Status, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    let Some(browser) = window.app_handle().get_webview_window(LABEL) else {
        return Ok(F95Status {
            status: "signedOut",
            account: None,
        });
    };
    let (mut status, account) = browser_session(&browser)?;
    if status == "signedIn" && LOGIN_WINDOW_PENDING.load(Ordering::Relaxed) {
        browser.hide().map_err(|_| "windowOpen")?;
        LOGIN_WINDOW_PENDING.store(false, Ordering::Relaxed);
        LOGIN_WAITING_FOR_PAGE.store(false, Ordering::Relaxed);
    } else if status == "pending" && LOGIN_WAITING_FOR_PAGE.load(Ordering::Relaxed) {
        let waited = LOGIN_REQUESTED_AT
            .lock()
            .map_err(|_| "windowOpen")?
            .is_some_and(|start| start.elapsed() >= Duration::from_secs(4));
        if LOGIN_PAGE_READY.load(Ordering::Relaxed) || waited {
            show_login_window(&browser)?;
            LOGIN_WAITING_FOR_PAGE.store(false, Ordering::Relaxed);
        } else {
            status = "loadingLogin";
        }
    }
    Ok(F95Status { status, account })
}

fn browser_session(
    browser: &WebviewWindow,
) -> Result<(&'static str, Option<String>), &'static str> {
    // The cookie lookup is scoped to F95 even before the initial page has loaded.
    let cookies = browser
        .cookies_for_url(Url::parse(LOGIN).unwrap())
        .map_err(|_| "sessionCheck")?;
    if let Some(user) = cookies
        .iter()
        .find(|cookie| cookie.name() == "xf_user" && !cookie.value().is_empty())
    {
        let id: String = user
            .value()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        return Ok(("signedIn", (!id.is_empty()).then_some(id)));
    }
    Ok(("pending", None))
}

#[tauri::command]
pub async fn f95_sign_out(window: WebviewWindow) -> Result<&'static str, &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    if let Some(browser) = window.app_handle().get_webview_window(LABEL) {
        browser
            .clear_all_browsing_data()
            .map_err(|_| "sessionCheck")?;
        browser.destroy().map_err(|_| "windowOpen")?;
    }
    LOGIN_WINDOW_PENDING.store(false, Ordering::Relaxed);
    LOGIN_WAITING_FOR_PAGE.store(false, Ordering::Relaxed);
    downloads::clear_attachment_download();
    Ok("signedOut")
}

#[tauri::command]
pub async fn f95_open_post(window: WebviewWindow, post_id: String) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    let id = post_id
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or("postOpen")?;
    let browser = signed_in_browser(&window)?;
    let url = Url::parse(&format!("{ORIGIN}/posts/{id}/")).map_err(|_| "postOpen")?;
    browser.navigate(url).map_err(|_| "postOpen")?;
    LOGIN_WINDOW_PENDING.store(false, Ordering::Relaxed);
    browser.show().map_err(|_| "postOpen")?;
    browser.set_focus().map_err(|_| "postOpen")?;
    Ok(())
}

#[tauri::command]
pub async fn f95_open_thread(
    window: WebviewWindow,
    thread_url: String,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    let (url, _) = parse_thread(&thread_url)?;
    let browser = signed_in_browser(&window)?;
    browser.navigate(url).map_err(|_| "postOpen")?;
    LOGIN_WINDOW_PENDING.store(false, Ordering::Relaxed);
    browser.show().map_err(|_| "postOpen")?;
    browser.set_focus().map_err(|_| "postOpen")?;
    Ok(())
}

#[tauri::command]
pub async fn f95_discover_threads(
    window: WebviewWindow,
    on_progress: Channel<Vec<ThreadResult>>,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    STOP_SCAN.store(false, Ordering::Relaxed);
    let browser = signed_in_browser(&window)?;
    const SUBMIT: &str = r#"
      (() => {
        if (location.origin !== 'https://f95zone.to' ||
            location.pathname.replace(/\/$/, '') !== '/search' ||
            document.readyState === 'loading') return null;
        const searchForms = document.querySelectorAll('.p-body-pageContent form, form');
        const form = [...searchForms].find(form => {
          const action = new URL(form.action);
          return action.origin === location.origin &&
            action.pathname.replace(/\/$/, '') === '/search/search' &&
            form.elements.namedItem('keywords');
        });
        if (!form || form.dataset.sfmmmSubmitted) return null;
        form.dataset.sfmmmSubmitted = 'true';
        form.elements.namedItem('keywords').value = 'Secret Flasher Manaka';
        const titleOnly = form.elements.namedItem('c[title_only]');
        if (titleOnly?.type === 'checkbox') titleOnly.checked = true;
        const grouped = form.elements.namedItem('grouped');
        if (grouped?.type === 'checkbox') grouped.checked = true;
        form.requestSubmit();
        return true;
      })()
    "#;
    const INSPECT: &str = r#"
      (() => {
        if (location.origin !== 'https://f95zone.to' ||
            document.readyState === 'loading') return null;
        const inResults = /^\/search\/\d+(?:\/|$)/.test(location.pathname);
        const noResults = /no results found|did not match any results/i.test(
          document.querySelector('.p-body-pageContent')?.textContent ?? '');
        if (!inResults && !(noResults && location.pathname.startsWith('/search/'))) return null;
        const links = document.querySelectorAll('.contentRow-title a[href], .structItem-title a[href]');
        if (!links.length && !noResults) return null;
        const threads = [...links].flatMap(link => {
          const url = new URL(link.href);
          const path = url.pathname.match(/^\/threads\/([^/]+)(?:\/post-\d+)?\/?$/);
          if (url.origin !== location.origin || !path) return [];
          const title = link.textContent.replace(/\s+/g, ' ').trim();
          if (!title) return [];
          const directThread = /^\/threads\/[^/]+\/?$/.test(url.pathname) && !url.hash.startsWith('#post-');
          if (!directThread && !/secret[\s-]+flasher[\s-]+manaka/i.test(title)) return [];
          url.pathname = '/threads/' + path[1] + '/';
          const row = link.closest('.contentRow-main, .structItem-cell--main');
          const preview = (row?.querySelector('.contentRow-snippet')?.textContent ?? '')
            .replace(/\s+/g, ' ').trim().slice(0, 200);
          url.hash = '';
          url.search = '';
          return [{ url: url.href, title, preview }];
        });
        const next = document.querySelector(
          '.pageNav-jump--next[href], .pageNavSimple-el--next[href], link[rel="next"]'
        )?.href ?? null;
        return { url: location.href, next, threads };
      })()
    "#;
    browser.hide().map_err(|_| "searchRead")?;
    browser
        .navigate(Url::parse(SEARCH).unwrap())
        .map_err(|_| "searchRead")?;
    wait_for_browser(&browser, SUBMIT, |submitted: &bool| *submitted)
        .await
        .ok_or_else(|| scan_error("searchRead"))?;

    let mut expected = None;
    let mut visited = HashSet::new();
    let mut seen_threads: HashSet<_> = read_threads(&window)?
        .iter()
        .filter_map(|thread| parse_thread(&thread.url).ok().map(|(_, id)| id))
        .collect();
    loop {
        check_scan()?;
        let page = wait_for_browser(&browser, INSPECT, |page: &SearchPage| {
            expected
                .as_ref()
                .is_none_or(|url: &Url| Url::parse(&page.url).ok().as_ref() == Some(url))
        })
        .await
        .ok_or_else(|| scan_error("searchRead"))?;
        let current = Url::parse(&page.url).map_err(|_| "searchRead")?;
        visited.insert(current.clone());
        let threads: Vec<_> = page
            .threads
            .into_iter()
            .filter(|result| parse_thread(&result.url).is_ok_and(|(_, id)| seen_threads.insert(id)))
            .collect();
        save_threads(&window, &threads)?;
        on_progress.send(threads).map_err(|_| "searchRead")?;
        let Some(next) = page.next else { break };
        let url = Url::parse(&next).map_err(|_| "searchRead")?;
        if url.origin() != current.origin()
            || url.path() != current.path()
            || visited.contains(&url)
        {
            return Err("searchRead");
        }
        browser.navigate(url.clone()).map_err(|_| "searchRead")?;
        expected = Some(url);
    }

    let mut unavailable = false;
    for mut thread in read_threads(&window)?
        .into_iter()
        .filter(|thread| thread.likes.is_none())
    {
        check_scan()?;
        let (url, id) = parse_thread(&thread.url)?;
        let Ok(mut page) = fetch_thread_page(&browser, url, &id, 1, false).await else {
            check_scan()?;
            unavailable = true;
            continue;
        };
        let Some(opening) = page.entries.iter_mut().find(|entry| entry.first) else {
            unavailable = true;
            continue;
        };
        hydrate_likes(&browser, std::slice::from_mut(opening)).await?;
        if let Some(likes) = opening.likes {
            thread.likes = Some(likes);
            save_threads(&window, std::slice::from_ref(&thread))?;
            on_progress.send(vec![thread]).map_err(|_| "searchRead")?;
        } else {
            unavailable = true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if unavailable {
        Err("someLikesUnavailable")
    } else {
        Ok(())
    }
}

fn signed_in_browser(window: &WebviewWindow) -> Result<WebviewWindow, &'static str> {
    let browser = window
        .app_handle()
        .get_webview_window(LABEL)
        .ok_or("sessionCheck")?;
    if browser_session(&browser)?.0 != "signedIn" {
        return Err("sessionCheck");
    }
    Ok(browser)
}

#[tauri::command]
pub async fn f95_update_threads(
    window: WebviewWindow,
    on_progress: Channel<Vec<ThreadResult>>,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    STOP_SCAN.store(false, Ordering::Relaxed);
    let browser = signed_in_browser(&window)?;
    browser.hide().map_err(|_| "sampleRead")?;
    let mut unavailable = false;
    for mut thread in read_threads(&window)? {
        check_scan()?;
        let (url, id) = parse_thread(&thread.url)?;
        let Ok(mut page) = fetch_thread_page(&browser, url, &id, 1, false).await else {
            check_scan()?;
            unavailable = true;
            continue;
        };
        if !page.title.is_empty() {
            thread.title = page.title;
        }
        if let Some(main) = page.entries.iter_mut().find(|entry| entry.first) {
            hydrate_likes(&browser, std::slice::from_mut(main)).await?;
            thread.preview = main.preview.clone();
            if main.likes.is_some() {
                thread.likes = main.likes;
                let mut cache = read_scan(&window, &id)?;
                for opening in cache.opening.iter_mut().chain(
                    cache
                        .pages
                        .values_mut()
                        .flat_map(|page| &mut page.entries)
                        .filter(|entry| entry.first),
                ) {
                    opening.likes = main.likes;
                }
                if !cache.pages.is_empty() || cache.opening.is_some() {
                    save_scan(&window, &id, &cache)?;
                }
            }
        }
        let updated = vec![thread];
        save_threads(&window, &updated)?;
        on_progress.send(updated).map_err(|_| "sampleRead")?;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if unavailable {
        Err("someThreadsUnavailable")
    } else {
        Ok(())
    }
}

enum LikeBatch {
    Opening,
    Replies { page: usize, ids: HashSet<String> },
}

impl LikeBatch {
    fn page(&self) -> usize {
        match self {
            Self::Opening => 1,
            Self::Replies { page, .. } => *page,
        }
    }

    fn includes(&self, entry: &SampleEntry) -> bool {
        match self {
            Self::Opening => entry.first,
            Self::Replies { ids, .. } => !entry.first && ids.contains(&entry.id),
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Opening => 1,
            Self::Replies { ids, .. } => ids.len(),
        }
    }
}

fn like_refresh_plan(thread: &ThreadResult, cache: &ScanCache) -> [Vec<LikeBatch>; 4] {
    // For each topic: unknown opening, unknown replies, known opening, known replies.
    let mut plan: [Vec<LikeBatch>; 4] = Default::default();
    let opening_likes = thread.likes.or_else(|| {
        cache
            .pages
            .values()
            .flat_map(|page| &page.entries)
            .find(|entry| entry.first)
            .and_then(|entry| entry.likes)
    });
    plan[if opening_likes.is_some() { 2 } else { 0 }].push(LikeBatch::Opening);

    let mut unknown = BTreeMap::<usize, HashSet<String>>::new();
    let mut known = BTreeMap::<usize, HashSet<String>>::new();
    for entry in cache
        .pages
        .values()
        .flat_map(|page| &page.entries)
        .filter(|entry| !entry.first)
    {
        let group = if entry.likes.is_none() {
            &mut unknown
        } else {
            &mut known
        };
        group
            .entry(entry.page)
            .or_default()
            .insert(entry.id.clone());
    }
    plan[1].extend(
        unknown
            .into_iter()
            .map(|(page, ids)| LikeBatch::Replies { page, ids }),
    );
    plan[3].extend(
        known
            .into_iter()
            .map(|(page, ids)| LikeBatch::Replies { page, ids }),
    );
    plan
}

struct LikeRefreshThread {
    thread: ThreadResult,
    base: Url,
    id: String,
    cache: ScanCache,
    plan: [Vec<LikeBatch>; 4],
    observed: BTreeMap<usize, Vec<SampleEntry>>,
}

#[tauri::command]
pub async fn f95_refresh_likes(
    window: WebviewWindow,
    thread_url: Option<String>,
    on_progress: Channel<LikeProgress>,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    STOP_SCAN.store(false, Ordering::Relaxed);
    let browser = signed_in_browser(&window)?;
    browser.hide().map_err(|_| "sampleRead")?;
    let mut topics = Vec::new();
    for thread in read_threads(&window)? {
        if thread_url
            .as_ref()
            .is_some_and(|target| target != &thread.url)
        {
            continue;
        }
        let (base, id) = parse_thread(&thread.url)?;
        let cache = read_scan(&window, &id)?;
        let plan = like_refresh_plan(&thread, &cache);
        topics.push(LikeRefreshThread {
            thread,
            base,
            id,
            cache,
            plan,
            observed: BTreeMap::new(),
        });
    }

    let mut unavailable = false;
    for phase in 0..4 {
        for LikeRefreshThread {
            thread,
            base,
            id,
            cache,
            plan,
            observed,
        } in &mut topics
        {
            for batch in &plan[phase] {
                check_scan()?;
                let number = batch.page();
                if let std::collections::btree_map::Entry::Vacant(slot) = observed.entry(number) {
                    let url = thread_page_url(base, number)?;
                    let Ok(mut page) = fetch_thread_page(&browser, url, id, number, false).await
                    else {
                        check_scan()?;
                        unavailable = true;
                        continue;
                    };
                    for entry in &mut page.entries {
                        entry.retain_for_mode(CacheMode::Addresses);
                    }
                    slot.insert(page.entries);
                }
                let mut entries: Vec<_> = observed[&number]
                    .iter()
                    .filter(|entry| batch.includes(entry))
                    .cloned()
                    .collect();
                hydrate_likes(&browser, &mut entries).await?;
                unavailable |= entries.len() < batch.len()
                    || entries.iter().any(|entry| entry.likes.is_none());
                let counts: BTreeMap<_, _> = entries
                    .iter()
                    .filter_map(|entry| entry.likes.map(|likes| (entry.id.as_str(), likes)))
                    .collect();
                if let Some(likes) = entries
                    .iter()
                    .find(|entry| entry.first)
                    .and_then(|entry| entry.likes)
                {
                    thread.likes = Some(likes);
                }
                for entry in cache
                    .opening
                    .iter_mut()
                    .chain(cache.pages.values_mut().flat_map(|page| &mut page.entries))
                {
                    if let Some(likes) = counts.get(entry.id.as_str()) {
                        entry.likes = Some(*likes);
                    }
                }
                if !cache.pages.is_empty() || cache.opening.is_some() {
                    save_scan(&window, id, cache)?;
                }
                save_threads(&window, std::slice::from_ref(thread))?;
                on_progress
                    .send(LikeProgress {
                        thread: thread.clone(),
                        scan: scan_summary(cache),
                    })
                    .map_err(|_| "sampleRead")?;
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    if unavailable {
        Err("someLikesUnavailable")
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn f95_scan_thread(
    window: WebviewWindow,
    thread_url: String,
    scan: ScanKind,
    on_progress: Channel<SampleProgress>,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    STOP_SCAN.store(false, Ordering::Relaxed);
    let (base_url, id) = parse_thread(&thread_url)?;
    let browser = signed_in_browser(&window)?;
    browser.hide().map_err(|_| "sampleRead")?;

    let mut cache = read_scan(&window, &id)?;
    let mode = effective_mode(&window, cache.mode)?;
    if scan == ScanKind::Recheck && !cache.pages.is_empty() {
        return recheck_entries(&window, &browser, &id, &mut cache, mode, &on_progress).await;
    }
    cache.coverage = ScanCoverage::Partial;
    save_scan(&window, &id, &cache)?;
    let mut read_pages = HashSet::new();
    let mut main_release_urls = HashSet::new();
    let previous_last = cache
        .pages
        .last_key_value()
        .map_or(0, |(number, _)| *number);
    let new_only = scan == ScanKind::New && previous_last > 0;
    let seen_posts: HashSet<_> = if new_only {
        cache
            .pages
            .values()
            .flat_map(|page| {
                page.ids
                    .iter()
                    .map(|id| post_number_id(id).to_owned())
                    .chain(page.entries.iter().map(|entry| entry.id.clone()))
            })
            .collect()
    } else {
        HashSet::new()
    };
    let mut rescan_tail = scan != ScanKind::Update;
    let mut first_skipped = None;
    let mut previews = BTreeMap::new();
    let mut expected = if new_only { previous_last } else { 1 };
    let mut url = thread_page_url(&base_url, expected)?;
    loop {
        check_scan()?;
        let mut page =
            fetch_thread_page(&browser, url, &id, expected, mode == CacheMode::Content).await?;
        if let Some(main) = page.entries.iter().find(|entry| entry.first) {
            main_release_urls.extend(main.release_urls.iter().cloned());
        }
        for entry in page.entries.iter_mut().filter(|entry| !entry.first) {
            if !entry.release_urls.is_empty()
                && entry
                    .release_urls
                    .iter()
                    .all(|url| main_release_urls.contains(url))
            {
                entry.mod_title = None;
            }
        }
        let next = page.next.take();
        read_pages.insert(expected);
        let before_old_end = expected < previous_last;
        let layout_changed = cache.pages.get(&expected).is_some_and(|prior| {
            if before_old_end {
                prior.ids != page.ids
            } else {
                !page.ids.starts_with(&prior.ids)
            }
        });
        if !rescan_tail && (layout_changed || (before_old_end && next.is_none())) {
            rescan_tail = true;
            if let Some(restart) = first_skipped.take() {
                expected = restart;
                url = thread_page_url(&base_url, expected)?;
                continue;
            }
        }
        if before_old_end && layout_changed {
            cache.pages.split_off(&expected);
        }
        if new_only {
            page.entries.retain(|entry| !seen_posts.contains(&entry.id));
        }
        hydrate_likes(&browser, &mut page.entries).await?;
        if new_only {
            if let Some(prior) = cache.pages.get_mut(&expected) {
                prior.entries.append(&mut page.entries);
                page.entries = std::mem::take(&mut prior.entries);
            }
            page.candidates = page.entries.iter().filter(|entry| !entry.first).count();
        }
        for entry in &mut page.entries {
            if !entry.preview.is_empty() {
                previews.insert(entry.id.clone(), entry.preview.clone());
            }
            entry.retain_for_mode(mode);
        }
        if page
            .entries
            .iter()
            .any(|entry| entry.first && entry.content.is_some())
        {
            cache.opening = None;
        }
        cache.pages.insert(expected, page);
        if next.is_none() {
            cache.pages.retain(|number, _| *number <= expected);
            if cache.pages.len() == expected {
                cache.coverage = ScanCoverage::Complete;
            }
        }
        save_scan(&window, &id, &cache)?;
        let mut snapshot = scan_summary_with_previews(&cache, &previews);
        snapshot.activity = Some(PageActivity {
            current: expected,
            read: read_pages.len(),
        });
        on_progress.send(snapshot).map_err(|_| "sampleRead")?;

        let Some(next) = next else { return Ok(()) };
        expected += 1;
        url = Url::parse(&next).map_err(|_| "sampleRead")?;
        let path = url.path().trim_end_matches('/');
        if thread_id(&url) != Some(id.as_str()) || !path.ends_with(&format!("/page-{expected}")) {
            return Err("sampleRead");
        }
        if !rescan_tail {
            let next_page = next_page_to_refresh(&cache.pages, expected, previous_last);
            if next_page != expected {
                first_skipped.get_or_insert(expected);
                expected = next_page;
                url = thread_page_url(&base_url, expected)?;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn post_number_id(id: &str) -> &str {
    id.trim_start_matches("js-").trim_start_matches("post-")
}

fn thread_page_url(base: &Url, page: usize) -> Result<Url, &'static str> {
    if page == 1 {
        return Ok(base.clone());
    }
    base.join(&format!("page-{page}")).map_err(|_| "sampleRead")
}

async fn recheck_entries(
    window: &WebviewWindow,
    browser: &WebviewWindow,
    thread: &str,
    cache: &mut ScanCache,
    mode: CacheMode,
    progress: &Channel<SampleProgress>,
) -> Result<(), &'static str> {
    let targets: Vec<_> = cache
        .pages
        .values()
        .flat_map(|page| page.entries.iter())
        .map(|entry| entry.id.clone())
        .collect();
    let mut pending: HashSet<_> = targets.iter().map(String::as_str).collect();
    let mut previews = BTreeMap::new();
    for id in &targets {
        check_scan()?;
        if !pending.contains(id.as_str()) {
            continue;
        }
        let url = Url::parse(&format!("{ORIGIN}/posts/{id}/")).map_err(|_| "sampleRead")?;
        mark_previous_page(browser).await?;
        browser.navigate(url).map_err(|_| "sampleRead")?;
        let Ok(mut page) = inspect_thread_page(browser, mode == CacheMode::Content, None, |page| {
            page.thread == thread && page.ids.iter().any(|value| post_number_id(value) == id)
        })
        .await
        else {
            check_scan()?;
            continue;
        };
        page.entries
            .retain(|entry| pending.contains(entry.id.as_str()));
        hydrate_likes(browser, &mut page.entries).await?;
        let on_page: HashSet<_> = page.ids.iter().map(|id| post_number_id(id)).collect();
        let refreshed: BTreeMap<_, _> = page
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect();
        for cached_page in cache.pages.values_mut() {
            cached_page.entries.retain_mut(|entry| {
                if !on_page.contains(entry.id.as_str()) || !pending.remove(entry.id.as_str()) {
                    return true;
                }
                let Some(new) = refreshed.get(entry.id.as_str()) else {
                    return false;
                };
                *entry = (*new).clone();
                previews.insert(entry.id.clone(), entry.preview.clone());
                entry.retain_for_mode(mode);
                true
            });
            cached_page.candidates = cached_page
                .entries
                .iter()
                .filter(|entry| !entry.first)
                .count();
        }
        save_scan(window, thread, cache)?;
        progress
            .send(scan_summary_with_previews(cache, &previews))
            .map_err(|_| "sampleRead")?;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if pending.is_empty() {
        Ok(())
    } else {
        Err("somePostsUnavailable")
    }
}

fn next_page_to_refresh(pages: &CachedPages, mut next: usize, previous_last: usize) -> usize {
    while next < previous_last && pages.get(&next).is_some_and(|page| page.candidates == 0) {
        next += 1;
    }
    next
}

async fn fetch_thread_page(
    browser: &WebviewWindow,
    url: Url,
    id: &str,
    expected: usize,
    capture_layout: bool,
) -> Result<SamplePage, &'static str> {
    let already_here = browser.url().is_ok_and(|current| {
        current.origin() == url.origin()
            && current.path().trim_end_matches('/') == url.path().trim_end_matches('/')
    });
    if already_here {
        mark_previous_page(browser).await?;
        browser.reload().map_err(|_| "sampleRead")?;
    } else {
        browser.navigate(url).map_err(|_| "sampleRead")?;
    }
    inspect_thread_page(browser, capture_layout, None, |page| {
        page.thread == id && page.page == expected
    })
    .await
}

async fn mark_previous_page(browser: &WebviewWindow) -> Result<(), &'static str> {
    wait_for_browser(
        browser,
        "window.__sfmmmPreviousDocument = true",
        |marked: &bool| *marked,
    )
    .await
    .map(|_| ())
    .ok_or_else(|| scan_error("sampleRead"))
}

async fn inspect_thread_page(
    browser: &WebviewWindow,
    capture_layout: bool,
    required_post: Option<&str>,
    ready: impl Fn(&SamplePage) -> bool,
) -> Result<SamplePage, &'static str> {
    const INSPECT: &str = r#"
      ((captureLayout, requiredPost, modTitle) => {
        const thread = location.pathname.match(/^\/threads\/(?:[^/]*\.)?(\d+)(?:\/|$)/)?.[1];
        if (location.origin !== 'https://f95zone.to' || !thread || window.__sfmmmPreviousDocument ||
            document.readyState === 'loading') return null;
        const page = Number(location.pathname.match(/\/page-(\d+)\/?$/)?.[1] ?? 1);
        const posts = [...document.querySelectorAll('article.message--post')];
        if (!posts.length) return null;
        const ids = posts.map(post => post.getAttribute('data-content') || post.id);
        const title = (document.querySelector('.p-title-value')?.textContent ?? '').trim();
        const downloadLinks = post =>
          [...post.querySelectorAll('.message-body a[href], .message-attachments a[href]')].filter(link => {
            if (link.closest('.bbCodeBlock--quote, .message-signature')) return false;
            try {
              const url = new URL(link.href);
              if (!['http:', 'https:'].includes(url.protocol)) return false;
              return (url.origin === location.origin && url.pathname.startsWith('/attachments/')) ||
                (url.origin === 'https://attachments.f95zone.to' && /^\/\d{4}\/\d{2}\/\d+_[^/]+$/.test(url.pathname)) ||
                /\.(?:zip|rar|7z|dll)$/i.test(url.pathname) ||
                /(?:^|\.)(?:mega\.nz|mediafire\.com|gofile\.io|drive\.google\.com|pixeldrain\.com)$/i.test(url.hostname);
            } catch { return false; }
          });
        let candidates = 0;
        const entries = posts.flatMap((post, index) => {
          const first = page === 1 && index === 0;
          const id = ids[index].match(/^(?:js-)?post-(\d+)$/)?.[1];
          const downloads = downloadLinks(post).map(link => ({
            url: link.href,
            label: (link.closest('.file')?.querySelector('.file-name')?.textContent || link.textContent).trim(),
          }));
          if (!id || (requiredPost ? id !== requiredPost : !first &&
              !downloads.length)) return [];
          if (!first) candidates++;
          const number = [...post.querySelectorAll('.message-attribution a[href], .message-attribution-opposite a[href]')]
            .map(link => (link.textContent.trim().match(/^#\s*([\d,]+)$/)?.[1] ?? '').replace(/,/g, ''))
            .find(Boolean);
          const bar = post.querySelector('.reactionsBar');
          const like = bar?.querySelector('[data-reaction-id="1"][data-reaction-count]');
          const explicitLikes = like?.getAttribute('data-reaction-count');
          const reactions = [...(bar?.querySelectorAll('.reactionSummary [data-reaction-id]') ?? [])];
          const onlyLike = reactions.length > 0 && reactions.every(icon => icon.dataset.reactionId === '1');
          const names = bar?.querySelectorAll('.reactionsBar-link .username, .reactionsBar-link bdi') ?? [];
          const named = [...names].filter(node => !node.parentElement.closest('.reactionsBar-link .username')).length;
          const others = Number(bar?.querySelector('.reactionsBar-link')?.textContent.match(/(?:and|plus)\s+([\d,]+)\s+other/i)?.[1]?.replace(/,/g, '') ?? 0);
          const likes = explicitLikes && /^\d+$/.test(explicitLikes) ? Number(explicitLikes)
            : bar && !bar.classList.contains('is-active') ? 0
            : onlyLike && named > 0 ? named + others : null;
          const original = post.querySelector('.message-body .bbWrapper, .message-body');
          const attachments = captureLayout
            ? [...post.querySelectorAll('.message-attachments')].filter(node => !original?.contains(node))
            : [];
          const contentHtml = captureLayout && (original || attachments.length)
            ? (original?.innerHTML ?? '') + attachments.map(node => node.outerHTML).join('')
            : null;
          const body = original?.cloneNode(true);
          body?.querySelectorAll('.bbCodeBlock--quote, .message-signature, script, style')
            .forEach(node => node.remove());
          const preview = (body?.textContent ?? '').replace(/\s+/g, ' ').trim();
          const content = original?.cloneNode(true);
          content?.querySelectorAll('script, style').forEach(node => node.remove());
          content?.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
          content?.querySelectorAll('p, li, div, blockquote').forEach(node => node.append('\n'));
          const links = [...post.querySelectorAll('.message-body a[href], .message-attachments a[href], .message-body img[src]')]
            .flatMap(link => {
              try {
                const url = new URL(link.href ?? link.src);
                if (!['http:', 'https:'].includes(url.protocol)) return [];
                return [{ url: url.href, label: (link.textContent || link.alt || url.href).trim() || url.href }];
              } catch { return []; }
            });
          return [{
            id, page, number: number ? Number(number) : (page - 1) * 20 + index + 1, likes, first,
            preview: (preview || links.slice(0, 2).map(link => link.label).join(' · ')).slice(0, 200) +
              (preview.length > 200 ? '…' : ''),
            content: (content?.textContent ?? '').trim(),
            content_html: contentHtml,
            mod_title: first ? null : modTitle(original, downloads),
            release_urls: downloads.filter(link => /\.(?:zip|7z|rar|dll|json)(?:[?#]|$)/i.test(link.label || link.url)
              || /\.(?:zip|7z|rar|dll|json)(?:[?#]|$)/i.test(link.url)
              || /^https?:\/\/(?:www\.)?mega\.nz\/(?:file|folder)\//i.test(link.url)).map(link => link.url),
            links: [...new Map(links.map(link => [link.url, link])).values()],
          }];
        });
        const next = document.querySelector(
          '.pageNav-jump--next[href], .pageNavSimple-el--next[href], link[rel="next"]'
        )?.href ?? null;
        return { thread, title, ids, page, posts: posts.length, candidates, next, entries };
      })
    "#;
    let post = serde_json::to_string(&required_post).map_err(|_| "sampleRead")?;
    let title = include_str!("f95/mod-title.js")
        .trim_start_matches('\u{feff}')
        .trim();
    let script = format!("{INSPECT}({capture_layout}, {post}, {title})");
    wait_for_browser(browser, &script, ready)
        .await
        .ok_or_else(|| scan_error("sampleRead"))
}

async fn hydrate_likes(
    browser: &WebviewWindow,
    entries: &mut [SampleEntry],
) -> Result<(), &'static str> {
    let ids: Vec<_> = entries
        .iter()
        .filter(|entry| entry.likes.is_none())
        .map(|entry| entry.id.as_str())
        .collect();
    if ids.is_empty() {
        return Ok(());
    }

    const READ_LIKES: &str = r#"
      ((key, ids) => {
        if (location.origin !== 'https://f95zone.to') return null;
        if (window.__sfmmmReactionJob?.key !== key) {
          const job = { key, done: false, counts: {}, blocked: false };
          window.__sfmmmReactionJob = job;
          let next = 0;
          const worker = async () => {
            while (next < ids.length && !job.blocked && !job.cancelled) {
              const id = ids[next++];
              if (!/^\d+$/.test(id)) continue;
              try {
                const response = await fetch('/posts/' + id + '/reactions', {
                  signal: AbortSignal.timeout(5000),
                });
                if (response.status === 429 || response.status === 403) {
                  job.blocked = true;
                  return;
                }
                if (!response.ok) continue;
                const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
                const like = doc.querySelector('.tabs-tab--reaction1');
                const count = like?.textContent.match(/\(([\d,]+)\)\s*$/)?.[1];
                if (count) job.counts[id] = Number(count.replace(/,/g, ''));
                else if (!like && doc.querySelector('.tabs-tab--reaction0')) job.counts[id] = 0;
              } catch { /* Keep this count unknown if the reaction page is unavailable. */ }
            }
          };
          Promise.all([worker(), worker(), worker()]).finally(() => { job.done = true; });
        }
        const job = window.__sfmmmReactionJob;
        return job.done ? job.counts : null;
      })
    "#;
    let key = REACTION_JOB.fetch_add(1, Ordering::Relaxed);
    let ids = serde_json::to_string(&ids).map_err(|_| "sampleRead")?;
    let script = format!("{READ_LIKES}({key}, {ids})");
    let counts = wait_for_browser(&browser, &script, |_: &BTreeMap<String, usize>| true).await;
    if counts.is_none() {
        let _ = browser
            .eval("if (window.__sfmmmReactionJob) window.__sfmmmReactionJob.cancelled = true");
    }
    if let Some(counts) = counts {
        for entry in entries {
            if let Some(likes) = counts.get(&entry.id) {
                entry.likes = Some(*likes);
            }
        }
    }
    check_scan()
}

async fn wait_for_browser<T: serde::de::DeserializeOwned>(
    browser: &WebviewWindow,
    script: &str,
    ready: impl Fn(&T) -> bool,
) -> Option<T> {
    for _ in 0..20 {
        if check_scan().is_err() {
            return None;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        browser
            .eval_with_callback(script, move |value| {
                if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
                    let _ = tx.send(value);
                }
            })
            .ok()?;
        if let Ok(Ok(value)) = tokio::time::timeout(Duration::from_millis(800), rx).await {
            if let Ok(result) = serde_json::from_str::<T>(&value) {
                if ready(&result) {
                    return Some(result);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(number: usize, candidates: usize) -> SamplePage {
        SamplePage {
            thread: "42".into(),
            title: String::new(),
            ids: vec![],
            page: number,
            posts: 20,
            candidates,
            next: None,
            entries: vec![],
        }
    }

    #[test]
    fn incremental_refresh_keeps_candidates_last_page_and_gaps() {
        let pages = [
            page(1, 0),
            page(2, 0),
            page(3, 1),
            page(4, 0),
            page(5, 0),
            page(7, 0),
        ]
        .into_iter()
        .map(|page| (page.page, page))
        .collect();
        assert_eq!(next_page_to_refresh(&pages, 2, 7), 3);
        assert_eq!(next_page_to_refresh(&pages, 4, 7), 6);
        assert_eq!(next_page_to_refresh(&pages, 7, 7), 7);
        assert_eq!(next_page_to_refresh(&pages, 8, 7), 8);
    }

    #[test]
    fn replacing_a_cached_page_replaces_its_counters() {
        let mut pages = BTreeMap::from([(1, page(1, 1)), (2, page(2, 2))]);
        let mut refreshed = page(2, 0);
        refreshed.posts = 18;
        pages.insert(2, refreshed);
        let summary = scan_summary(&ScanCache {
            mode: CacheMode::Addresses,
            pages,
            ..Default::default()
        });
        assert_eq!(
            (summary.pages, summary.posts, summary.candidates),
            (2, 38, 1)
        );
    }

    #[test]
    fn legacy_replies_use_their_position_and_can_show_live_previews() {
        let first = page(1, 0);
        let mut later = page(2, 1);
        later.ids = vec!["post-90".into(), "js-post-91".into()];
        later.entries.push(SampleEntry {
            id: "91".into(),
            page: 2,
            number: None,
            likes: Some(5),
            first: false,
            preview: String::new(),
            content: None,
            content_html: None,
            mod_title: None,
            release_urls: vec![],
            links: vec![],
        });
        let cache = ScanCache {
            pages: BTreeMap::from([(1, first), (2, later)]),
            ..Default::default()
        };
        let previews = BTreeMap::from([("91".into(), "Live preview".into())]);
        let summary = scan_summary_with_previews(&cache, &previews);
        assert_eq!(summary.entries[0].number, 22);
        assert_eq!(summary.entries[0].likes, Some(5));
        assert_eq!(summary.entries[0].preview, "Live preview");
        assert!(cache.pages[&2].entries[0].preview.is_empty());
    }

    #[test]
    fn like_refresh_prioritizes_missing_counts_and_keeps_zero_known() {
        let thread = ThreadResult {
            url: String::new(),
            title: String::new(),
            preview: String::new(),
            likes: None,
        };
        let mut replies = page(3, 2);
        for (id, likes) in [("92", None), ("93", Some(0))] {
            replies.entries.push(SampleEntry {
                id: id.into(),
                page: 3,
                number: None,
                likes,
                first: false,
                preview: String::new(),
                content: None,
                content_html: None,
                mod_title: None,
                release_urls: vec![],
                links: vec![],
            });
        }
        let cache = ScanCache {
            pages: BTreeMap::from([(3, replies)]),
            ..Default::default()
        };
        let plan = like_refresh_plan(&thread, &cache);
        assert!(matches!(plan[0].as_slice(), [LikeBatch::Opening]));
        assert!(plan[2].is_empty());
        assert!(
            matches!(plan[1].as_slice(), [LikeBatch::Replies { page: 3, ids }] if ids.contains("92") && ids.len() == 1)
        );
        assert!(
            matches!(plan[3].as_slice(), [LikeBatch::Replies { page: 3, ids }] if ids.contains("93") && ids.len() == 1)
        );
        let known = ThreadResult {
            likes: Some(0),
            ..thread
        };
        let plan = like_refresh_plan(&known, &cache);
        assert!(plan[0].is_empty());
        assert!(matches!(plan[2].as_slice(), [LikeBatch::Opening]));
    }

    #[test]
    fn cached_opening_does_not_advance_reply_scan_and_is_not_duplicated() {
        let opening = SampleEntry {
            id: "91".into(),
            page: 1,
            number: Some(1),
            likes: None,
            first: true,
            preview: "Preview".into(),
            content: Some("Original text".into()),
            content_html: Some("<b>Original text</b>".into()),
            mod_title: None,
            release_urls: vec![],
            links: vec![],
        };
        let mut cache = ScanCache {
            opening: Some(opening.clone()),
            ..Default::default()
        };
        let summary = scan_summary(&cache);
        assert_eq!(summary.pages, 0);
        assert_eq!(summary.entries.len(), 1);
        assert!(summary.entries[0].has_content);
        let mut first_page = page(1, 0);
        let mut address = opening;
        address.retain_for_mode(CacheMode::Addresses);
        first_page.entries.push(address);
        cache.pages.insert(1, first_page);
        assert_eq!(scan_summary(&cache).entries.len(), 1);
        strip_for_mode(&mut cache, CacheMode::Addresses);
        assert!(cache.opening.is_none());
        assert!(!scan_summary(&cache).entries[0].has_content);
    }

    #[test]
    fn earlier_scan_caches_have_unknown_coverage() {
        let old = r#"{"mode":"addresses","pages":{}}"#;
        let cache = decode_scan(old).unwrap();
        assert!(cache.coverage == ScanCoverage::Unknown);
        let partial = r#"{"mode":"addresses","pages":{},"coverage":"partial"}"#;
        assert!(decode_scan(partial).unwrap().coverage == ScanCoverage::Partial);
    }

    #[test]
    fn turning_off_the_override_preserves_thread_modes_and_strips_only_address_caches() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(CACHE_SCHEMA).unwrap();
        let mut recorded = page(1, 1);
        recorded.entries.push(SampleEntry {
            id: "91".into(),
            page: 1,
            number: Some(4),
            likes: None,
            first: false,
            preview: "Preview".into(),
            content: Some("Original text".into()),
            content_html: Some("<b>Original text</b>".into()),
            mod_title: None,
            release_urls: vec![],
            links: vec![PostLink {
                url: "https://f95zone.to/attachments/mod.1/".into(),
                label: "mod.zip".into(),
            }],
        });
        let mut cache = ScanCache {
            pages: BTreeMap::from([(1, recorded)]),
            ..Default::default()
        };
        write_scan(&db, "42", &cache).unwrap();
        cache.mode = CacheMode::Content;
        write_scan(&db, "43", &cache).unwrap();

        update_force_content(&mut db, true).unwrap();
        assert!(force_content(&db).unwrap());
        let restored = read_scan_data(&db, "42").unwrap();
        assert!(restored.mode == CacheMode::Addresses);
        assert_eq!(
            restored.pages[&1].entries[0].content.as_deref(),
            Some("Original text")
        );

        update_force_content(&mut db, false).unwrap();
        assert!(!force_content(&db).unwrap());
        let stripped = read_scan_data(&db, "42").unwrap();
        let entry = &stripped.pages[&1].entries[0];
        assert_eq!(entry.id, "91");
        assert!(
            entry.content.is_none()
                && entry.content_html.is_none()
                && entry.links.is_empty()
                && entry.preview.is_empty()
        );
        let retained = read_scan_data(&db, "43").unwrap();
        assert!(retained.mode == CacheMode::Content);
        assert_eq!(
            retained.pages[&1].entries[0].content.as_deref(),
            Some("Original text")
        );
    }
}
