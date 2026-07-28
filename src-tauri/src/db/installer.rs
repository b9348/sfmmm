// 更新安装包下载 / 应用：installer_path、db_prepare_update、db_apply_update。
use std::io::Write;
use tauri::ipc::Channel;
use tauri::Manager;
use futures_util::StreamExt;

fn installer_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app_handle.path().app_data_dir().map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(data_dir.join("sfmmm_update.exe"))
}

/// 下载更新安装包到应用数据目录，返回保存路径（带进度通知）
#[tauri::command]
pub async fn db_prepare_update(
    app_handle: tauri::AppHandle,
    url: String,
    on_progress: Channel<crate::DownloadProgress>,
) -> Result<String, String> {
    let _ = on_progress.send(crate::DownloadProgress {
        percent: 0,
        stage: "downloading".into(),
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("下载失败: {}", e))?;

    let total = response.content_length().unwrap_or(0);
    let path = installer_path(&app_handle)?;
    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载失败: {}", e))?;
        file.write_all(&chunk).map_err(|e| format!("写入文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let percent = (downloaded * 100 / total) as u32;
            let _ = on_progress.send(crate::DownloadProgress {
                percent,
                stage: "downloading".into(),
            });
        }
    }

    let _ = on_progress.send(crate::DownloadProgress {
        percent: 100,
        stage: "done".into(),
    });

    Ok(path.to_string_lossy().into_owned())
}

/// 启动已下载的安装包并退出当前应用，安装完成后自动重启
#[tauri::command]
pub async fn db_apply_update(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = installer_path(&app_handle)?;
    if !path.exists() {
        return Err("未找到更新安装包，请重新检查更新".into());
    }

    // 获取当前 exe 路径（安装后的新版本会覆盖此路径）
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("无法获取当前可执行路径: {}", e))?;

    // 创建临时 bat 脚本：等待当前进程退出 → 静默安装 → 启动新版本
    let bat_path = std::env::temp_dir().join("sfmmm_restart_update.bat");
    let bat_content = format!(
        "@echo off\r\n\
         rem 等待当前应用完全退出\r\n\
         ping 127.0.0.1 -n 5 > nul\r\n\r\n\
         rem 静默安装更新\r\n\
         \"{}\" /S\r\n\r\n\
         rem 启动更新后的应用\r\n\
         start \"\" \"{}\"\r\n\r\n\
         rem 删除自身\r\n\
         del \"{}\" > nul 2>&1\r\n",
        path.display(),
        current_exe.display(),
        bat_path.display(),
    );
    std::fs::write(&bat_path, &bat_content)
        .map_err(|e| format!("创建更新脚本失败: {}", e))?;

    // 启动 bat 脚本（独立进程，不受当前进程退出影响）
    std::process::Command::new(&bat_path)
        .spawn()
        .map_err(|e| format!("启动更新脚本失败: {}", e))?;

    // 退出当前应用，避免安装程序无法覆盖运行中的 exe
    app_handle.exit(0);

    // 注意：exit 会终止进程，因此 Ok 返回值不会到达前端
    Ok("更新程序已启动，应用将自动更新并重启".into())
}
