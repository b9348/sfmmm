use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{webview::DownloadEvent, Manager, Url, Webview, WebviewWindow};
use tokio::sync::oneshot;

use super::{require_main, signed_in_browser, BROWSER_WORK, ORIGIN};
use crate::db::archive::{game_downloads_dir, sanitize_file_name};

struct AttachmentDownload {
    id: u64,
    dir: PathBuf,
    destination: Option<PathBuf>,
    started: Option<oneshot::Sender<()>>,
    finished: oneshot::Sender<Result<PathBuf, &'static str>>,
}

static ACTIVE_DOWNLOAD: Mutex<Option<AttachmentDownload>> = Mutex::new(None);

fn attachment_id(url: &Url) -> Option<u64> {
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let id = match url.origin().ascii_serialization().as_str() {
        ORIGIN => {
            let name = url
                .path()
                .strip_prefix("/attachments/")?
                .trim_end_matches('/');
            if name.contains('/') {
                return None;
            }
            name.rsplit('.').next()?
        }
        "https://attachments.f95zone.to" => {
            let mut parts = url.path_segments()?;
            let year = parts.next()?;
            let month = parts.next()?;
            let (id, file) = parts.next()?.split_once('_')?;
            if year.len() != 4
                || month.len() != 2
                || file.is_empty()
                || parts.next().is_some()
                || !year
                    .bytes()
                    .chain(month.bytes())
                    .all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            id
        }
        _ => return None,
    };
    if !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    id.parse::<u64>().ok().filter(|id| *id > 0)
}

pub(crate) fn allows_attachment_navigation(url: &Url) -> bool {
    attachment_id(url).is_some_and(|id| {
        ACTIVE_DOWNLOAD.lock().ok().is_some_and(|active| {
            active
                .as_ref()
                .is_some_and(|job| job.id == id && job.destination.is_none())
        })
    })
}

fn windows_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

fn download_destination(dir: &Path, id: u64, suggested: &Path) -> Result<PathBuf, &'static str> {
    let name = suggested
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitize_file_name)
        .unwrap_or_default();
    let path = Path::new(&name);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    let extension = if extension.is_empty() {
        String::new()
    } else {
        format!(".{}", extension.chars().take(16).collect::<String>())
    };
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    let stem: String =
        if stem.is_empty() || stem == "." || stem == ".." || windows_device_name(&name) {
            format!("f95-attachment-{id}")
        } else {
            stem.chars().take(150).collect()
        };
    for attempt in 0.. {
        let suffix = match attempt {
            0 => String::new(),
            1 => format!(" (F95 {id})"),
            _ => format!(" (F95 {id}-{attempt})"),
        };
        let target = dir.join(format!("{stem}{suffix}{extension}"));
        match std::fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(target),
            Err(_) => return Err("attachmentDestination"),
            Ok(_) => {}
        }
    }
    Err("attachmentDestination")
}

fn fail_download(slot: &mut Option<AttachmentDownload>, reason: &'static str) {
    if let Some(job) = slot.take() {
        let _ = job.finished.send(Err(reason));
    }
}

pub(crate) fn handle_download(webview: Webview, event: DownloadEvent<'_>) -> bool {
    let Ok(mut active) = ACTIVE_DOWNLOAD.lock() else {
        return false;
    };
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Some(id) = attachment_id(&url) else {
                if active.as_ref().is_some_and(|job| job.started.is_some()) {
                    fail_download(&mut active, "attachmentUnavailable");
                    return false;
                }
                return true;
            };
            if active
                .as_ref()
                .is_some_and(|job| job.id == id && job.destination.is_some())
            {
                return false;
            }
            let dir = active
                .as_ref()
                .filter(|job| job.id == id)
                .map(|job| job.dir.clone())
                .or_else(|| game_downloads_dir(webview.app_handle()).ok());
            let target = dir
                .as_deref()
                .ok_or("attachmentDestination")
                .and_then(|dir| download_destination(dir, id, destination));
            let target = match target {
                Ok(target) => target,
                Err(reason) => {
                    if active.as_ref().is_some_and(|job| job.id == id) {
                        fail_download(&mut active, reason);
                    }
                    return false;
                }
            };
            if let Some(job) = active.as_mut().filter(|job| job.id == id) {
                job.destination = Some(target.clone());
                if let Some(started) = job.started.take() {
                    let _ = started.send(());
                }
            }
            *destination = target;
        }
        DownloadEvent::Finished { url, path, success } => {
            if active
                .as_ref()
                .is_some_and(|job| Some(job.id) == attachment_id(&url) && job.destination.is_some())
            {
                if let Some(job) = active.take() {
                    let result = if success {
                        let found = path.or_else(|| job.destination.clone());
                        found
                            .filter(|actual| {
                                actual.is_file()
                                    && job.destination.as_ref().is_some_and(|expected| {
                                        actual == expected
                                            || actual.canonicalize().ok().is_some_and(|canonical| {
                                                expected.canonicalize().ok().as_ref()
                                                    == Some(&canonical)
                                            })
                                    })
                            })
                            .ok_or("attachmentUnavailable")
                    } else {
                        Err("attachmentUnavailable")
                    };
                    let _ = job.finished.send(result);
                }
            }
        }
        _ => {}
    }
    true
}

pub(crate) fn clear_attachment_download() {
    if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
        fail_download(&mut active, "attachmentUnavailable");
    }
}

#[tauri::command]
pub async fn f95_download_attachment(
    window: WebviewWindow,
    url: String,
) -> Result<PathBuf, &'static str> {
    require_main(&window)?;
    let url = Url::parse(&url).map_err(|_| "attachmentUnavailable")?;
    let id = attachment_id(&url).ok_or("attachmentUnavailable")?;
    let work = BROWSER_WORK.lock().await;
    let browser = signed_in_browser(&window)?;
    let dir = game_downloads_dir(window.app_handle()).map_err(|reason| {
        if reason == "GAME_DIR_INVALID" {
            "attachmentGameDir"
        } else {
            "attachmentDestination"
        }
    })?;
    let dir = dir.canonicalize().map_err(|_| "attachmentDestination")?;
    let (started, wait_for_start) = oneshot::channel();
    let (finished, wait_for_file) = oneshot::channel();
    {
        let mut active = ACTIVE_DOWNLOAD
            .lock()
            .map_err(|_| "attachmentUnavailable")?;
        if active.is_some() {
            return Err("attachmentBusy");
        }
        *active = Some(AttachmentDownload {
            id,
            dir,
            destination: None,
            started: Some(started),
            finished,
        });
    }
    if browser.navigate(url).is_err() {
        clear_attachment_download();
        return Err("attachmentUnavailable");
    }
    if tokio::time::timeout(Duration::from_secs(20), wait_for_start)
        .await
        .is_err()
    {
        let mut active = ACTIVE_DOWNLOAD
            .lock()
            .map_err(|_| "attachmentUnavailable")?;
        if active
            .as_ref()
            .is_some_and(|job| job.id == id && job.destination.is_none())
        {
            active.take();
            return Err("attachmentUnavailable");
        }
    }
    drop(work);
    wait_for_file.await.unwrap_or(Err("attachmentUnavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_actual_f95_attachments_only() {
        let example = |url| attachment_id(&Url::parse(url).unwrap());
        assert_eq!(
            example("https://f95zone.to/attachments/5244196/"),
            Some(5244196)
        );
        assert_eq!(
            example("https://f95zone.to/attachments/mod.zip.5244196/?x=1"),
            Some(5244196)
        );
        assert_eq!(example("https://other.test/attachments/5244196/"), None);
        assert_eq!(
            example("https://attachments.f95zone.to/2026/07/6273747_DualBond_CM2_v1.11_F95.zip"),
            Some(6273747)
        );
        assert_eq!(
            example("https://f95zone.to/attachments/nested/5244196/"),
            None
        );
        assert_eq!(example("https://f95zone.to/threads/5244196/"), None);
    }

    #[test]
    fn uses_server_filename_and_avoids_existing_file() {
        let existing = std::env::current_exe().unwrap();
        let folder = existing.parent().unwrap();
        let target = download_destination(folder, 123, &existing).unwrap();
        assert_eq!(target.parent(), Some(folder));
        assert_ne!(target, existing);
        assert!(target
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .contains("F95 123"));
        assert_eq!(
            download_destination(folder, 123, Path::new("CON.zip"))
                .unwrap()
                .file_name()
                .unwrap(),
            "f95-attachment-123.zip"
        );
    }
}
