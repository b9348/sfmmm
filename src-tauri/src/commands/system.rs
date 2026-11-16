use std::fs;
use std::io::Write;
use std::path::PathBuf;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;

use crate::fs_util::current_timestamp;

#[tauri::command(rename_all = "snake_case")]
pub fn open_folder(path: String, selected_items: Option<Vec<String>>) -> Result<(), String> {
    let input_path = PathBuf::from(&path);
    let mut items = selected_items.unwrap_or_default();

    // selected_items 为空 => 前端要“打开该路径本身”：
    //   - 路径是目录 → 直接打开该目录（钻入），不高亮子项；
    //   - 路径是文件 → 在其父目录中高亮该文件（is_dir 误判时回退父目录，单文件场景安全）。
    // selected_items 非空 => 前端已保证 input_path 就是要打开的目录（currentDir / 已安装 mod
    //   目录），直接打开该目录并高亮 items 列出的全部条目，绝不回退到父目录——
    //   否则 junction 目录（如 v1 的 CustomMissions）会被 std::fs::is_dir() 误判为假，导致
    //   “打开游戏根目录 + 高亮该目录”的错位。SHParseDisplayName 会跟随符号链接/目录交接点解析。
    // 前端无需自行判定目录/文件，“打开哪个目录”由 input_path + items 是否为空唯一决定。
    let open_path = if items.is_empty() {
        if input_path.is_dir() {
            input_path.clone()
        } else if input_path.is_file() {
            // 单文件：在其父目录中高亮该文件
            if let Some(name) = input_path.file_name().and_then(|n| n.to_str()) {
                items.push(name.to_string());
            }
            input_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| input_path.clone())
        } else if input_path.exists() {
            // 路径存在但既不是常规文件也不是常规目录（如 junction/符号链接/交接点）。
            // is_dir() 对 junction 可能误判为假，直接打开该路径，由 SHParseDisplayName 可靠解析。
            input_path.clone()
        } else {
            // 路径不存在：尝试打开父目录并高亮原路径名称
            if let Some(name) = input_path.file_name().and_then(|n| n.to_str()) {
                items.push(name.to_string());
            }
            input_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| input_path.clone())
        }
    } else {
        // items 非空：前端已保证 input_path 就是要打开的目录（如 currentDir / 已安装 mod 目录）。
        // 直接打开该目录并高亮全部 items，绝不回退到父目录——否则 junction 目录（如 v1 的
        // CustomMissions）会被 std::fs::is_dir() 误判为假，导致“打开游戏根目录 + 高亮该目录”的错位。
        // 依赖 SHParseDisplayName 跟随符号链接/目录交接点解析（与单文件夹钻入走同一可靠路径）。
        input_path.clone()
    };

    // 不再用 is_dir() 提前 return：符号链接 / 交接点下 is_dir() 可能误判为假，直接交给
    // SHParseDisplayName 解析，解析成功即打开（见下方 Windows 分支的 HRESULT 判定）。

    #[cfg(target_os = "windows")]
    {
        use std::ffi::{OsStr, c_void};
        use std::iter::once;
        use std::os::windows::ffi::OsStrExt;

        type HRESULT = i32;
        type LPITEMIDLIST = *mut c_void;
        type LPBC = *mut c_void;

        #[link(name = "ole32")]
        extern "system" {
            fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> HRESULT;
        }

        #[link(name = "shell32")]
        extern "system" {
            fn SHParseDisplayName(
                pszName: *const u16,
                pbc: LPBC,
                ppidl: *mut LPITEMIDLIST,
                sfgaoIn: u32,
                psfgaoOut: *mut u32,
            ) -> HRESULT;
            fn SHOpenFolderAndSelectItems(
                pidlFolder: LPITEMIDLIST,
                cidl: u32,
                apidl: *const LPITEMIDLIST,
                dwFlags: u32,
            ) -> HRESULT;
            fn ILFree(pidl: LPITEMIDLIST);
        }

        const COINIT_APARTMENTTHREADED: u32 = 0x2;

        fn to_wide(s: &str) -> Vec<u16> {
            OsStr::new(s).encode_wide().chain(once(0)).collect()
        }

        unsafe {
            let _ = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED);
        }

        let path_str = open_path.to_string_lossy().to_string();
        let folder_wide = to_wide(&path_str);
        let mut folder_pidl: LPITEMIDLIST = std::ptr::null_mut();
        let hr = unsafe {
            SHParseDisplayName(folder_wide.as_ptr(), std::ptr::null_mut(), &mut folder_pidl, 0, std::ptr::null_mut())
        };
        if hr < 0 {
            return Err(format!("解析目录失败: 0x{:08X}", hr));
        }

        // apidl 传入每个条目的绝对 PIDL（SHParseDisplayName 解析其完整路径）。官方示例
        // （ILCreateFromPath 生成绝对 PIDL 多选）与 Windows 资源管理器实际行为一致：会打开
        // pidlFolder 并高亮这些条目；对符号链接/目录交接点(junction) 子项也稳定，故不转换为
        // 相对 PIDL（ILFindChild 对 junction 子项会返回 null，反而导致高亮丢失）。
        // 注意：item 可能来自前端 manifest（含 '/' 分隔符），必须归一化为 '\' 再 join，
        // 否则 SHParseDisplayName 对混合分隔符路径返回 E_INVALIDARG(0x80070057) 解析失败，
        // 导致 item_pidls 为空、cidl=0，SHOpenFolderAndSelectItems 转而打开父目录并选中
        // pidlFolder 本身（表现为"打开游戏根目录 + 高亮 v1 文件夹"的错位）。
        let mut item_pidls: Vec<LPITEMIDLIST> = Vec::new();
        for item in &items {
            let item_norm = item.replace('/', "\\");
            let item_path = open_path.join(&item_norm);
            let item_wide = to_wide(&item_path.to_string_lossy());
            let mut item_pidl: LPITEMIDLIST = std::ptr::null_mut();
            let hr = unsafe {
                SHParseDisplayName(item_wide.as_ptr(), std::ptr::null_mut(), &mut item_pidl, 0, std::ptr::null_mut())
            };
            if hr >= 0 && !item_pidl.is_null() {
                item_pidls.push(item_pidl);
            }
        }

        let result = unsafe {
            SHOpenFolderAndSelectItems(
                folder_pidl,
                item_pidls.len() as u32,
                if item_pidls.is_empty() { std::ptr::null() } else { item_pidls.as_ptr() },
                0,
            )
        };

        unsafe {
            for pidl in item_pidls {
                ILFree(pidl);
            }
            ILFree(folder_pidl);
        }

        if result < 0 {
            return Err(format!("打开目录失败: 0x{:08X}", result));
        }
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(open_path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(open_path)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 用系统默认关联程序打开一个文件（如 sfmmmDownloads 里下载好的 zip）。
///
/// 与 open_folder 的分工：open_folder 走资源管理器"打开目录并高亮条目"，
/// 用户要自己去解压/移动；这里要的是"交给默认程序直接运行"。
/// 不用 tauri-plugin-shell 的 open：它的 open 参数受 scope 正则约束（默认只允许
/// mailto/tel/http(s)），文件路径会被直接拒绝，而放宽成正则匹配任意路径等于
/// 把任意命令交给前端，不如在 Rust 侧显式做这一件事。
#[tauri::command(rename_all = "snake_case")]
pub fn open_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    // 只接受真实存在的文件：下载条上的路径可能已被用户在资源管理器里删掉，
    // 提前给出明确错误胜过把不存在的东西丢给 ShellExecute。
    if !target.is_file() {
        return Err(format!("文件不存在: {}", target.display()));
    }

    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        use std::iter::once;
        use std::os::windows::ffi::OsStrExt;

        type HANDLE = isize;
        type LPCWSTR = *const u16;
        type LPVOID = *mut c_void;
        type DWORD = u32;

        // 与 webview_check.rs 的声明保持逐字一致：同一个符号在两处模块里各声明
        // 一次时，签名不同会触发 clashing_extern_declarations 警告。
        #[link(name = "shell32")]
        extern "system" {
            fn ShellExecuteW(
                hwnd: HANDLE,
                lpOperation: LPCWSTR,
                lpFile: LPCWSTR,
                lpParameters: LPCWSTR,
                lpDirectory: LPCWSTR,
                nShowCmd: DWORD,
            ) -> LPVOID;
        }
        const SW_SHOWNORMAL: DWORD = 1;

        fn to_wide(s: &str) -> Vec<u16> {
            std::ffi::OsStr::new(s).encode_wide().chain(once(0)).collect()
        }

        let verb = to_wide("open");
        let file = to_wide(&target.to_string_lossy());
        // ShellExecuteW 的返回值不是 HRESULT：> 32 才算成功，<= 32 是错误码
        // （如 31 = 没有关联程序），不能按正负号判断。
        let ret = unsafe {
            ShellExecuteW(
                0,
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if ret <= 32 {
            return Err(format!("打开文件失败: 错误码 {}", ret));
        }
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&target)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 判断路径是否含非 ASCII 字符（中文等）。
///
/// BepInEx 前置与游戏本体内部大量走 ANSI 接口（中文系统为 GBK），路径含非 ASCII
/// 字符时会出现注入失败、资源定位错误甚至闪退，故安装/启动前统一用此函数拦截。
/// 返回 true 表示路径不可用（含中文等非 ASCII 字符）。
#[tauri::command]
pub fn path_has_non_ascii(path: String) -> bool {
    path.chars().any(|c| !c.is_ascii())
}

/// 启动游戏：运行游戏根目录下的 SecretFlasherManaka.exe，不打开任何页面。
/// 工作目录设为游戏目录，保证游戏能按相对路径找到资源文件。
#[tauri::command]
pub fn launch_game(game_path: String) -> Result<(), String> {
    let game_dir = PathBuf::from(&game_path);
    let exe_path = game_dir.join("SecretFlasherManaka.exe");

    if !exe_path.is_file() {
        return Err(format!("未找到游戏可执行文件: {}", exe_path.display()));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：防止游戏（若为控制台子系统程序）弹出黑框窗口，
        // GUI 程序不受该标志影响，窗口照常显示。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // 中文路径兼容：下面经 CreateProcessW 启动本身支持任意 Unicode 路径，
        // 但游戏本体是日文程序，内部多用 ANSI 接口（中文系统为 GBK）定位自身资源，
        // 安装在含中文的目录下会因编码不符而闪退。转为纯 ASCII 的 8.3 短路径启动
        // 即可绕开；纯 ASCII 路径不做转换（8.3 短名会截断 exe 文件名，Unity 按
        // exe 名查找 <exe>_Data 文件夹会失败），卷禁用 8.3 名生成或转换失败时
        // 原样回退，行为与旧版一致。
        let exe_launch = short_ascii_path(&exe_path).unwrap_or_else(|| exe_path.clone());
        let dir_launch = short_ascii_path(&game_dir).unwrap_or_else(|| game_dir.clone());

        std::process::Command::new(&exe_launch)
            .current_dir(&dir_launch)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动游戏失败: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(&exe_path)
            .current_dir(&game_dir)
            .spawn()
            .map_err(|e| format!("启动游戏失败: {}", e))?;
    }

    Ok(())
}

/// 取路径的 8.3 短路径（GetShortPathNameW），仅用于含非 ASCII 字符（如中文）
/// 的路径：ASCII 在各代码页下字节一致，可供内部走 ANSI 接口的老程序安全使用。
/// 路径本身已是纯 ASCII 时必须原样返回、不做转换——GetShortPathNameW 会把超过
/// 8.3 格式的长文件名截断成短名（如 SecretFlasherManaka.exe → SECRET~1.EXE），
/// Unity 按 exe 文件名推断 Data 文件夹（SECRET1_Data）将找不到实际的
/// <长名>_Data 目录导致游戏无法启动。注意短名只保证 OEM 代码页可表示，中文
/// 系统下可能仍含非 ASCII 双字节字符，故拿到结果后复查，含非 ASCII（如卷关闭
/// 了 8.3 名生成时返回原长路径）则返回 None，由调用方回退到原始路径。文件必须已存在。
#[cfg(target_os = "windows")]
fn short_ascii_path(p: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::ffi::OsString;
    use std::iter::once;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    // 纯 ASCII 路径无需也无法安全转换：短名截断会破坏 Unity 的
    // <exe 名>_Data 文件夹查找，直接原样返回。
    if p.as_os_str().encode_wide().all(|c| c <= 0x7F) {
        return Some(p.to_path_buf());
    }

    type DWORD = u32;
    type LPCWSTR = *const u16;
    type LPWSTR = *mut u16;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetShortPathNameW(lpszLongPath: LPCWSTR, lpszShortPath: LPWSTR, cchBuffer: DWORD) -> DWORD;
    }

    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(once(0)).collect();
    unsafe {
        // 先传 NULL 缓冲区取所需长度（含结尾 NUL），再实际取短路径
        let len = GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let n = GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), len);
        if n == 0 {
            return None;
        }
        buf.truncate(n as usize);
        if buf.iter().any(|&c| c > 0x7F) {
            return None;
        }
        Some(std::path::PathBuf::from(OsString::from_wide(&buf)))
    }
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    percent: u32,
    stage: String,
}

#[tauri::command]
pub async fn download_and_extract_7z(
    url: String,
    target_dir: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    let target_path = PathBuf::from(&target_dir);
    if !target_path.is_dir() {
        return Err("目标目录不存在".into());
    }

    let _ = on_progress.send(DownloadProgress {
        percent: 0,
        stage: "downloading".into(),
    });

    // 图床域名的 URL 按当前生效线路改写（加速/原始）
    let url = crate::db::cdn::rewrite_url(&url);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| format!("下载失败: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败，HTTP {}", status));
    }

    let total = response.content_length().unwrap_or(0);
    let temp_path = std::env::temp_dir().join(format!("bepinex_download_{}.7z", current_timestamp()));
    let mut file = fs::File::create(&temp_path).map_err(|e| format!("创建临时文件失败: {}", e))?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载失败: {}", e))?;
        file.write_all(&chunk).map_err(|e| format!("写入临时文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        if total > 0 {
            let percent = (downloaded * 100 / total) as u32;
            let _ = on_progress.send(DownloadProgress {
                percent,
                stage: "downloading".into(),
            });
        }
    }

    let _ = on_progress.send(DownloadProgress {
        percent: 100,
        stage: "extracting".into(),
    });

    crate::db::sevenz::extract_safely(&temp_path, &target_path)?;

    let _ = fs::remove_file(&temp_path);
    let _ = on_progress.send(DownloadProgress {
        percent: 100,
        stage: "done".into(),
    });

    Ok(())
}

#[tauri::command]
pub async fn http_request(url: String, method: String, body: Option<String>) -> Result<String, String> {
    println!("[Rust] HTTP Request: {} {}", method, url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建客户端失败: {}", e))?;

    let mut request = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("不支持的 HTTP 方法: {}", method)),
    };

    request = request.header("Content-Type", "application/json");

    if let Some(b) = body {
        request = request.body(b);
    }

    let response = request.send().await.map_err(|e| {
        println!("[Rust] Request Error: {:?}", e);
        format!("请求失败: {}", e)
    })?;
    let status = response.status().as_u16();
    let body_text = response.text().await.map_err(|e| format!("读取响应失败: {}", e))?;

    println!("[Rust] Response: HTTP {} - {}", status, body_text.chars().take(100).collect::<String>());

    // 返回 JSON 字符串
    let result = format!("{{\"status\":{},\"body\":{}}}", status, serde_json::to_string(&body_text).map_err(|e| e.to_string())?);
    Ok(result)
}
