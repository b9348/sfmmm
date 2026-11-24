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
    let (x, y, width, height) = bounds.within(&window)?;
    let app = window.app_handle();
    if let Some(reader) = app.get_webview_window(LABEL) {
        reader.destroy().map_err(|_| "windowOpen")?;
    }
    // The reader is a native child window. The original SFMMM webview stays the
    // only webview owned by the main Tauri window, including for its IPC commands.
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("F95Zone Reader")
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
        .initialization_script(format!(
            "({PAGE_STYLE})({})",
            serde_json::json!(post_id.map(|id| id.to_string()))
        ))
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
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(downloads::handle_download);
    if let Some(proxy) = browser_proxy() {
        builder = builder.proxy_url(proxy);
    }
    let reader = builder.build().map_err(|_| "windowOpen")?;
    if width > 0.0 && height > 0.0 {
        reader.show().map_err(|_| "windowOpen")?;
    }
    Ok(())
}

#[tauri::command]
pub fn f95_position_reader(
    window: WebviewWindow,
    bounds: ReaderBounds,
) -> Result<(), &'static str> {
    require_main(&window)?;
    let Some(reader) = window.app_handle().get_webview_window(LABEL) else {
        return Ok(());
    };
    let (x, y, width, height) = bounds.within(&window)?;
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
pub fn f95_close_reader(window: WebviewWindow) -> Result<(), &'static str> {
    require_main(&window)?;
    if let Some(reader) = window.app_handle().get_webview_window(LABEL) {
        reader.destroy().map_err(|_| "windowOpen")?;
    }
    Ok(())
}
