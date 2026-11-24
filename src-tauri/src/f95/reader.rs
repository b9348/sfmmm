use super::*;

pub(super) const LABEL: &str = "f95-reader";
const PAGE_STYLE: &str = include_str!("reader-layout.js");

#[derive(serde::Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum ReaderTargetKind {
    Post(String),
    Thread(String),
}

#[derive(serde::Deserialize)]
pub struct ReaderBounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl ReaderBounds {
    fn within(&self, window: &WebviewWindow) -> Result<(f64, f64, f64, f64), &'static str> {
        let size = window.inner_size().map_err(|_| "windowOpen")?;
        let scale = window.scale_factor().map_err(|_| "windowOpen")?;
        let size = size.to_logical::<f64>(scale);
        let x = f64::from(self.x).min(size.width);
        let y = f64::from(self.y).min(size.height);
        let width = f64::from(self.width).min(size.width - x);
        let height = f64::from(self.height).min(size.height - y);
        Ok((x, y, width, height))
    }
}

pub(super) fn pane_builder<'a>(
    window: &'a WebviewWindow,
    label: &str,
    title: &str,
    url: Url,
    bounds: &ReaderBounds,
) -> Result<WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>, &'static str> {
    let (x, y, width, height) = bounds.within(window)?;
    let app = window.app_handle();
    // A native child keeps SFMMM's main Tauri webview and IPC intact.
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(title)
        .parent_raw(window.hwnd().map_err(|_| "windowOpen")?)
        .decorations(false)
        .shadow(false)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .position(x, y)
        .inner_size(width.max(1.0), height.max(1.0))
        .data_directory(browser_profile(app)?)
        .devtools(false)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(downloads::handle_download);
    if let Some(proxy) = browser_proxy() {
        builder = builder.proxy_url(proxy);
    }
    Ok(builder)
}

pub(super) fn page_layout(post_id: Option<u64>, focus_post: bool) -> String {
    format!(
        "({PAGE_STYLE})({}, {focus_post})",
        serde_json::json!(post_id.map(|id| id.to_string()))
    )
}

#[tauri::command]
pub async fn f95_open_reader(
    window: WebviewWindow,
    target: ReaderTargetKind,
    bounds: ReaderBounds,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let _work = BROWSER_WORK.lock().await;
    signed_in_browser(&window)?;
    let (url, post_id, opening_thread_id) = match target {
        ReaderTargetKind::Post(value) => {
            let id = value
                .parse::<u64>()
                .ok()
                .filter(|id| *id > 0)
                .ok_or("postOpen")?;
            (
                Url::parse(&format!("{ORIGIN}/posts/{id}/")).map_err(|_| "postOpen")?,
                Some(id),
                None,
            )
        }
        ReaderTargetKind::Thread(value) => {
            let (url, id) = parse_thread(&value)?;
            (url, None, Some(id))
        }
    };
    let app = window.app_handle();
    if let Some(reader) = app.get_webview_window(LABEL) {
        reader.destroy().map_err(|_| "windowOpen")?;
    }
    let reader = pane_builder(&window, LABEL, "F95Zone Reader", url, &bounds)?
        .initialization_script(page_layout(post_id, true))
        .on_navigation(move |url| {
            if let Some(id) = thread_id(url) {
                return opening_thread_id
                    .as_deref()
                    .is_none_or(|expected| expected == id);
            }
            url.origin().ascii_serialization() == ORIGIN
                && (url.path().starts_with("/cdn-cgi/")
                    || url.path().starts_with("/login")
                    || post_id.is_some_and(|id| {
                        url.path().trim_end_matches('/') == format!("/posts/{id}")
                    }))
                || downloads::attachment_id(url).is_some()
        })
        .build()
        .map_err(|_| "windowOpen")?;
    position_pane(&window, &reader, &bounds)
}

#[tauri::command]
pub fn f95_position_reader(
    window: WebviewWindow,
    bounds: ReaderBounds,
    account: bool,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let label = if account { super::LABEL } else { LABEL };
    let Some(reader) = window.app_handle().get_webview_window(label) else {
        return Ok(());
    };
    position_pane(&window, &reader, &bounds)
}

pub(super) fn position_pane(
    window: &WebviewWindow,
    reader: &WebviewWindow,
    bounds: &ReaderBounds,
) -> Result<(), &'static str> {
    let (x, y, width, height) = bounds.within(window)?;
    if width <= 0.0 || height <= 0.0 {
        return reader.hide().map_err(|_| "windowOpen");
    }
    reader
        .set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|_| "windowOpen")?;
    reader
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|_| "windowOpen")?;
    if !reader.is_visible().unwrap_or(false) {
        reader.show().map_err(|_| "windowOpen")?;
    }
    Ok(())
}

#[tauri::command]
pub fn f95_close_reader(window: WebviewWindow, account: bool) -> Result<(), &'static str> {
    require_main(&window)?;
    let label = if account { super::LABEL } else { LABEL };
    if let Some(reader) = window.app_handle().get_webview_window(label) {
        if account {
            reader.hide().map_err(|_| "windowOpen")?;
        } else {
            reader.destroy().map_err(|_| "windowOpen")?;
        }
    }
    Ok(())
}
