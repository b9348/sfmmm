use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_sql::{Builder, Migration, MigrationKind};
use futures_util::StreamExt;

mod db;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModEntry {
    id: String,
    name: String,
    path: String,
    relative_path: String,
    source_dir: String,
    kind: String,
    is_banned: bool,
    is_directory_mod: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanModsResult {
    mods: Vec<ModEntry>,
    checked_dirs: Vec<String>,
    active_dirs: Vec<String>,
    warnings: Vec<String>,
    missing_core_files: Vec<String>,
    bepin_ex_installed: bool,
    scanned_at: String,
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn is_ignored_entry(name: &str) -> bool {
    name.starts_with('.') || name.ends_with('~') || name.ends_with(".tmp")
}

fn is_dll_file(path: &PathBuf) -> bool {
    path.extension()
        .map(|extension| extension.to_string_lossy().eq_ignore_ascii_case("dll"))
        .unwrap_or(false)
        || path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase().ends_with("[ban]dll"))
            .unwrap_or(false)
}

fn file_stem(path: &PathBuf) -> Option<String> {
    path.file_stem().map(|name| name.to_string_lossy().into_owned())
}

fn is_banned_file(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    lower.ends_with("[ban].dll")
        || lower.ends_with("[ban].json")
        || lower.ends_with("[ban]dll")
        || lower.ends_with("[ban]json")
}

fn strip_banned_suffix(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    if lower.ends_with("[ban].dll") {
        let stem_len = lower.trim_end_matches("[ban].dll").len();
        file_name[..stem_len].to_string()
    } else if lower.ends_with("[ban].json") {
        let stem_len = lower.trim_end_matches("[ban].json").len();
        file_name[..stem_len].to_string()
    } else if lower.ends_with("[ban]dll") {
        let stem_len = lower.trim_end_matches("[ban]dll").len();
        file_name[..stem_len].to_string()
    } else if lower.ends_with("[ban]json") {
        let stem_len = lower.trim_end_matches("[ban]json").len();
        file_name[..stem_len].to_string()
    } else {
        file_name.to_string()
    }
}

fn current_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn required_bepinex_core_files() -> &'static [&'static str] {
    &[
        ".doorstop_version",
        "BepInEx/core/0Harmony.dll",
        "BepInEx/core/AsmResolver.dll",
        "BepInEx/core/AsmResolver.DotNet.dll",
        "BepInEx/core/AsmResolver.PE.dll",
        "BepInEx/core/AsmResolver.PE.File.dll",
        "BepInEx/core/AssetRipper.CIL.dll",
        "BepInEx/core/AssetRipper.Primitives.dll",
        "BepInEx/core/BepInEx.Core.dll",
        "BepInEx/core/BepInEx.Core.xml",
        "BepInEx/core/BepInEx.Preloader.Core.dll",
        "BepInEx/core/BepInEx.Preloader.Core.xml",
        "BepInEx/core/BepInEx.Unity.Common.dll",
        "BepInEx/core/BepInEx.Unity.Common.xml",
        "BepInEx/core/BepInEx.Unity.IL2CPP.dll",
        "BepInEx/core/BepInEx.Unity.IL2CPP.dll.config",
        "BepInEx/core/BepInEx.Unity.IL2CPP.xml",
        "BepInEx/core/Cpp2IL.Core.dll",
        "BepInEx/core/Disarm.dll",
        "BepInEx/core/dobby.dll",
        "BepInEx/core/Gee.External.Capstone.dll",
        "BepInEx/core/Iced.dll",
        "BepInEx/core/Il2CppInterop.Common.dll",
        "BepInEx/core/Il2CppInterop.Generator.dll",
        "BepInEx/core/Il2CppInterop.HarmonySupport.dll",
        "BepInEx/core/Il2CppInterop.Runtime.dll",
        "BepInEx/core/LibCpp2IL.dll",
        "BepInEx/core/Mono.Cecil.dll",
        "BepInEx/core/Mono.Cecil.Mdb.dll",
        "BepInEx/core/Mono.Cecil.Pdb.dll",
        "BepInEx/core/Mono.Cecil.Rocks.dll",
        "BepInEx/core/MonoMod.RuntimeDetour.dll",
        "BepInEx/core/MonoMod.Utils.dll",
        "BepInEx/core/SemanticVersioning.dll",
        "BepInEx/core/StableNameDotNet.dll",
        "BepInEx/core/WasmDisassembler.dll",
        "doorstop_config.ini",
        "dotnet/.version",
        "dotnet/clretwrc.dll",
        "dotnet/clrjit.dll",
        "dotnet/coreclr.dll",
        "dotnet/dbgshim.dll",
        "dotnet/hostpolicy.dll",
        "dotnet/Microsoft.Bcl.AsyncInterfaces.dll",
        "dotnet/Microsoft.CSharp.dll",
        "dotnet/Microsoft.DiaSymReader.Native.amd64.dll",
        "dotnet/Microsoft.Extensions.DependencyInjection.Abstractions.dll",
        "dotnet/Microsoft.Extensions.DependencyInjection.dll",
        "dotnet/Microsoft.Extensions.Logging.Abstractions.dll",
        "dotnet/Microsoft.Extensions.Logging.dll",
        "dotnet/Microsoft.Extensions.Options.dll",
        "dotnet/Microsoft.Extensions.Primitives.dll",
        "dotnet/Microsoft.NETCore.App.deps.json",
        "dotnet/Microsoft.NETCore.App.runtimeconfig.json",
        "dotnet/Microsoft.VisualBasic.Core.dll",
        "dotnet/Microsoft.VisualBasic.dll",
        "dotnet/Microsoft.Win32.Primitives.dll",
        "dotnet/Microsoft.Win32.Registry.dll",
        "dotnet/mscordaccore.dll",
        "dotnet/mscordaccore_amd64_amd64_6.0.722.32202.dll",
        "dotnet/mscordbi.dll",
        "dotnet/mscorlib.dll",
        "dotnet/mscorrc.dll",
        "dotnet/msquic.dll",
        "dotnet/netstandard.dll",
        "dotnet/System.AppContext.dll",
        "dotnet/System.Buffers.dll",
        "dotnet/System.Collections.Concurrent.dll",
        "dotnet/System.Collections.dll",
        "dotnet/System.Collections.Immutable.dll",
        "dotnet/System.Collections.NonGeneric.dll",
        "dotnet/System.Collections.Specialized.dll",
        "dotnet/System.ComponentModel.Annotations.dll",
        "dotnet/System.ComponentModel.DataAnnotations.dll",
        "dotnet/System.ComponentModel.dll",
        "dotnet/System.ComponentModel.EventBasedAsync.dll",
        "dotnet/System.ComponentModel.Primitives.dll",
        "dotnet/System.ComponentModel.TypeConverter.dll",
        "dotnet/System.Configuration.dll",
        "dotnet/System.Console.dll",
        "dotnet/System.Core.dll",
        "dotnet/System.Data.Common.dll",
        "dotnet/System.Data.DataSetExtensions.dll",
        "dotnet/System.Data.dll",
        "dotnet/System.Diagnostics.Contracts.dll",
        "dotnet/System.Diagnostics.Debug.dll",
        "dotnet/System.Diagnostics.DiagnosticSource.dll",
        "dotnet/System.Diagnostics.FileVersionInfo.dll",
        "dotnet/System.Diagnostics.Process.dll",
        "dotnet/System.Diagnostics.StackTrace.dll",
        "dotnet/System.Diagnostics.TextWriterTraceListener.dll",
        "dotnet/System.Diagnostics.Tools.dll",
        "dotnet/System.Diagnostics.TraceSource.dll",
        "dotnet/System.Diagnostics.Tracing.dll",
        "dotnet/System.dll",
        "dotnet/System.Drawing.dll",
        "dotnet/System.Drawing.Primitives.dll",
        "dotnet/System.Dynamic.Runtime.dll",
        "dotnet/System.Formats.Asn1.dll",
        "dotnet/System.Globalization.Calendars.dll",
        "dotnet/System.Globalization.dll",
        "dotnet/System.Globalization.Extensions.dll",
        "dotnet/System.IO.Compression.Brotli.dll",
        "dotnet/System.IO.Compression.dll",
        "dotnet/System.IO.Compression.FileSystem.dll",
        "dotnet/System.IO.Compression.Native.dll",
        "dotnet/System.IO.Compression.ZipFile.dll",
        "dotnet/System.IO.dll",
        "dotnet/System.IO.FileSystem.AccessControl.dll",
        "dotnet/System.IO.FileSystem.dll",
        "dotnet/System.IO.FileSystem.DriveInfo.dll",
        "dotnet/System.IO.FileSystem.Primitives.dll",
        "dotnet/System.IO.FileSystem.Watcher.dll",
        "dotnet/System.IO.IsolatedStorage.dll",
        "dotnet/System.IO.MemoryMappedFiles.dll",
        "dotnet/System.IO.Pipes.AccessControl.dll",
        "dotnet/System.IO.Pipes.dll",
        "dotnet/System.IO.UnmanagedMemoryStream.dll",
        "dotnet/System.Linq.dll",
        "dotnet/System.Linq.Expressions.dll",
        "dotnet/System.Linq.Parallel.dll",
        "dotnet/System.Linq.Queryable.dll",
        "dotnet/System.Memory.dll",
        "dotnet/System.Net.dll",
        "dotnet/System.Net.Http.dll",
        "dotnet/System.Net.Http.Json.dll",
        "dotnet/System.Net.HttpListener.dll",
        "dotnet/System.Net.Mail.dll",
        "dotnet/System.Net.NameResolution.dll",
        "dotnet/System.Net.NetworkInformation.dll",
        "dotnet/System.Net.Ping.dll",
        "dotnet/System.Net.Primitives.dll",
        "dotnet/System.Net.Quic.dll",
        "dotnet/System.Net.Requests.dll",
        "dotnet/System.Net.Security.dll",
        "dotnet/System.Net.ServicePoint.dll",
        "dotnet/System.Net.Sockets.dll",
        "dotnet/System.Net.WebClient.dll",
        "dotnet/System.Net.WebHeaderCollection.dll",
        "dotnet/System.Net.WebProxy.dll",
        "dotnet/System.Net.WebSockets.Client.dll",
        "dotnet/System.Net.WebSockets.dll",
        "dotnet/System.Numerics.dll",
        "dotnet/System.Numerics.Vectors.dll",
        "dotnet/System.ObjectModel.dll",
        "dotnet/System.Private.CoreLib.dll",
        "dotnet/System.Private.DataContractSerialization.dll",
        "dotnet/System.Private.Uri.dll",
        "dotnet/System.Private.Xml.dll",
        "dotnet/System.Private.Xml.Linq.dll",
        "dotnet/System.Reflection.DispatchProxy.dll",
        "dotnet/System.Reflection.dll",
        "dotnet/System.Reflection.Emit.dll",
        "dotnet/System.Reflection.Emit.ILGeneration.dll",
        "dotnet/System.Reflection.Emit.Lightweight.dll",
        "dotnet/System.Reflection.Extensions.dll",
        "dotnet/System.Reflection.Metadata.dll",
        "dotnet/System.Reflection.Primitives.dll",
        "dotnet/System.Reflection.TypeExtensions.dll",
        "dotnet/System.Resources.Reader.dll",
        "dotnet/System.Resources.ResourceManager.dll",
        "dotnet/System.Resources.Writer.dll",
        "dotnet/System.Runtime.CompilerServices.Unsafe.dll",
        "dotnet/System.Runtime.CompilerServices.VisualC.dll",
        "dotnet/System.Runtime.dll",
        "dotnet/System.Runtime.Extensions.dll",
        "dotnet/System.Runtime.Handles.dll",
        "dotnet/System.Runtime.InteropServices.dll",
        "dotnet/System.Runtime.InteropServices.RuntimeInformation.dll",
        "dotnet/System.Runtime.Intrinsics.dll",
        "dotnet/System.Runtime.Loader.dll",
        "dotnet/System.Runtime.Numerics.dll",
        "dotnet/System.Runtime.Serialization.dll",
        "dotnet/System.Runtime.Serialization.Formatters.dll",
        "dotnet/System.Runtime.Serialization.Json.dll",
        "dotnet/System.Runtime.Serialization.Primitives.dll",
        "dotnet/System.Runtime.Serialization.Xml.dll",
        "dotnet/System.Security.AccessControl.dll",
        "dotnet/System.Security.Claims.dll",
        "dotnet/System.Security.Cryptography.Algorithms.dll",
        "dotnet/System.Security.Cryptography.Cng.dll",
        "dotnet/System.Security.Cryptography.Csp.dll",
        "dotnet/System.Security.Cryptography.Encoding.dll",
        "dotnet/System.Security.Cryptography.OpenSsl.dll",
        "dotnet/System.Security.Cryptography.Primitives.dll",
        "dotnet/System.Security.Cryptography.X509Certificates.dll",
        "dotnet/System.Security.dll",
        "dotnet/System.Security.Principal.dll",
        "dotnet/System.Security.Principal.Windows.dll",
        "dotnet/System.Security.SecureString.dll",
        "dotnet/System.ServiceModel.Web.dll",
        "dotnet/System.ServiceProcess.dll",
        "dotnet/System.Text.Encoding.CodePages.dll",
        "dotnet/System.Text.Encoding.dll",
        "dotnet/System.Text.Encoding.Extensions.dll",
        "dotnet/System.Text.Encodings.Web.dll",
        "dotnet/System.Text.Json.dll",
        "dotnet/System.Text.RegularExpressions.dll",
        "dotnet/System.Threading.Channels.dll",
        "dotnet/System.Threading.dll",
        "dotnet/System.Threading.Overlapped.dll",
        "dotnet/System.Threading.Tasks.Dataflow.dll",
        "dotnet/System.Threading.Tasks.dll",
        "dotnet/System.Threading.Tasks.Extensions.dll",
        "dotnet/System.Threading.Tasks.Parallel.dll",
        "dotnet/System.Threading.Thread.dll",
        "dotnet/System.Threading.ThreadPool.dll",
        "dotnet/System.Threading.Timer.dll",
        "dotnet/System.Transactions.dll",
        "dotnet/System.Transactions.Local.dll",
        "dotnet/System.ValueTuple.dll",
        "dotnet/System.Web.dll",
        "dotnet/System.Web.HttpUtility.dll",
        "dotnet/System.Windows.dll",
        "dotnet/System.Xml.dll",
        "dotnet/System.Xml.Linq.dll",
        "dotnet/System.Xml.ReaderWriter.dll",
        "dotnet/System.Xml.Serialization.dll",
        "dotnet/System.Xml.XDocument.dll",
        "dotnet/System.Xml.XmlDocument.dll",
        "dotnet/System.Xml.XmlSerializer.dll",
        "dotnet/System.Xml.XPath.dll",
        "dotnet/System.Xml.XPath.XDocument.dll",
        "dotnet/WindowsBase.dll",
        "winhttp.dll",
    ]
}

fn missing_bepinex_core_files(game_path: &PathBuf) -> Vec<String> {
    required_bepinex_core_files()
        .iter()
        .filter(|relative_path| !game_path.join(relative_path).is_file())
        .map(|relative_path| (*relative_path).to_string())
        .collect()
}

#[tauri::command]
fn open_folder(path: String, selected_items: Option<Vec<String>>) -> Result<(), String> {
    let path = PathBuf::from(path);

    if !path.is_dir() {
        return Err("游戏目录不存在".into());
    }

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

        let path_str = path.to_string_lossy().to_string();
        let folder_wide = to_wide(&path_str);
        let mut folder_pidl: LPITEMIDLIST = std::ptr::null_mut();
        let hr = unsafe {
            SHParseDisplayName(folder_wide.as_ptr(), std::ptr::null_mut(), &mut folder_pidl, 0, std::ptr::null_mut())
        };
        if hr < 0 {
            return Err(format!("解析目录失败: 0x{:08X}", hr));
        }

        let mut item_pidls: Vec<LPITEMIDLIST> = Vec::new();
        if let Some(items) = selected_items {
            for item in items {
                let item_path = path.join(&item);
                let item_wide = to_wide(&item_path.to_string_lossy());
                let mut item_pidl: LPITEMIDLIST = std::ptr::null_mut();
                let hr = unsafe {
                    SHParseDisplayName(item_wide.as_ptr(), std::ptr::null_mut(), &mut item_pidl, 0, std::ptr::null_mut())
                };
                if hr >= 0 && !item_pidl.is_null() {
                    item_pidls.push(item_pidl);
                }
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
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    percent: u32,
    stage: String,
}

#[tauri::command]
async fn download_and_extract_7z(
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

    sevenz_rust::decompress_file(&temp_path, &target_path).map_err(|e| format!("解压失败: {}", e))?;

    let _ = fs::remove_file(&temp_path);
    let _ = on_progress.send(DownloadProgress {
        percent: 100,
        stage: "done".into(),
    });

    Ok(())
}

#[tauri::command]
fn toggle_mod_enabled(path: String) -> Result<(bool, String), String> {
    let path = PathBuf::from(&path);

    if !path.is_file() {
        return Err("文件不存在".into());
    }

    let file_name = path.file_name()
        .ok_or("无法获取文件名")?
        .to_string_lossy()
        .into_owned();

    let parent = path.parent()
        .ok_or("无法获取父目录")?
        .to_path_buf();

    let (new_name, is_banned) = if file_name.to_lowercase().ends_with("[ban]dll") {
        let lower = file_name.to_lowercase();
        let stem_len = lower.trim_end_matches("[ban]dll").len();
        let stem = &file_name[..stem_len];
        let new_name = format!("{}.dll", stem);
        (new_name, false)
    } else if file_name.to_lowercase().ends_with(".dll") {
        let lower = file_name.to_lowercase();
        let stem_len = lower.trim_end_matches(".dll").len();
        let stem = &file_name[..stem_len];
        let new_name = format!("{}[ban]dll", stem);
        (new_name, true)
    } else if file_name.to_lowercase().ends_with("[ban]json") {
        let lower = file_name.to_lowercase();
        let stem_len = lower.trim_end_matches("[ban]json").len();
        let stem = &file_name[..stem_len];
        let new_name = format!("{}.json", stem);
        (new_name, false)
    } else if file_name.to_lowercase().ends_with(".json") {
        let lower = file_name.to_lowercase();
        let stem_len = lower.trim_end_matches(".json").len();
        let stem = &file_name[..stem_len];
        let new_name = format!("{}[ban]json", stem);
        (new_name, true)
    } else {
        return Err("无法识别的文件格式".into());
    };

    let new_path = parent.join(&new_name);
    fs::rename(&path, &new_path).map_err(|e| format!("重命名失败: {}", e))?;

    Ok((is_banned, path_to_string(new_path)))
}

#[tauri::command]
fn batch_toggle_mod_enabled(dir: String, ban: bool) -> Result<(usize, usize), String> {
    let dir = PathBuf::from(&dir);
    if !dir.is_dir() {
        return Err("目录不存在".into());
    }

    let mut success = 0usize;
    let mut failed = 0usize;

    let entries = fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = match path.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => continue,
        };
        let lower = file_name.to_lowercase();

        let (new_name, should_rename) = if ban {
            if lower.ends_with(".dll") && !lower.ends_with("[ban]dll") {
                let stem = &file_name[..file_name.len() - 4];
                (format!("{}[ban]dll", stem), true)
            } else if lower.ends_with(".json") && !lower.ends_with("[ban]json") {
                let stem = &file_name[..file_name.len() - 5];
                (format!("{}[ban]json", stem), true)
            } else {
                (file_name.clone(), false)
            }
        } else {
            if lower.ends_with("[ban]dll") {
                let stem = &file_name[..file_name.len() - 8];
                (format!("{}.dll", stem), true)
            } else if lower.ends_with("[ban]json") {
                let stem = &file_name[..file_name.len() - 9];
                (format!("{}.json", stem), true)
            } else {
                (file_name.clone(), false)
            }
        };

        if should_rename {
            let new_path = dir.join(&new_name);
            match fs::rename(&path, &new_path) {
                Ok(_) => success += 1,
                Err(_) => failed += 1,
            }
        }
    }

    Ok((success, failed))
}

#[tauri::command]
async fn http_request(url: String, method: String, body: Option<String>) -> Result<String, String> {
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

#[tauri::command]
async fn test_network() -> Result<String, String> {
    use std::net::ToSocketAddrs;
    
    let mut results = vec![];
    
    // 测试 DNS 解析
    match "sfm.b9349.dpdns.org:443".to_socket_addrs() {
        Ok(addrs) => {
            let addrs_vec: Vec<_> = addrs.collect();
            results.push(format!("DNS 解析成功: {:?}", addrs_vec));
        }
        Err(e) => {
            results.push(format!("DNS 解析失败: {}", e));
        }
    }
    
    // 测试 TCP 连接
    use std::net::TcpStream;
    match TcpStream::connect("sfm.b9349.dpdns.org:443") {
        Ok(_) => results.push("TCP 连接成功".to_string()),
        Err(e) => results.push(format!("TCP 连接失败: {}", e)),
    }
    
    // 测试 HTTP 连接 - 使用详细错误
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    match client.get("https://sfm.b9349.dpdns.org/api/mods/list").send().await {
        Ok(resp) => {
            results.push(format!("HTTP 请求成功: HTTP {}", resp.status()));
        }
        Err(e) => {
            let err_msg = if e.is_timeout() {
                format!("HTTP 请求超时: {}", e)
            } else if e.is_connect() {
                format!("HTTP 连接错误: {}", e)
            } else if let Some(status) = e.status() {
                format!("HTTP 错误状态: {}", status)
            } else {
                format!("HTTP 请求失败: {:?}", e)
            };
            results.push(err_msg);
        }
    }
    
    Ok(results.join("\n"))
}

#[tauri::command]
fn scan_mods(game_path: String) -> Result<ScanModsResult, String> {
    let game_path = PathBuf::from(game_path);

    if !game_path.is_dir() {
        return Err("游戏目录不存在或无法访问".into());
    }

    let mut checked_dirs = Vec::new();
    let mut active_dirs = Vec::new();
    let mut warnings = Vec::new();
    let mut mods = Vec::new();
    let missing_core_files = missing_bepinex_core_files(&game_path);
    let bepin_ex_installed = missing_core_files.is_empty();

    if !bepin_ex_installed {
        warnings.push("mod 前置未安装或不完整".into());
        return Ok(ScanModsResult {
            mods,
            checked_dirs,
            active_dirs,
            warnings,
            missing_core_files,
            bepin_ex_installed,
            scanned_at: current_timestamp(),
        });
    }

    let plugins_dir = game_path.join("BepInEx").join("plugins");
    checked_dirs.push(path_to_string(plugins_dir.clone()));

    if plugins_dir.is_dir() {
        active_dirs.push(path_to_string(plugins_dir.clone()));

        for entry in fs::read_dir(&plugins_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().into_owned();

            if is_ignored_entry(&file_name) {
                continue;
            }

            let metadata = entry.metadata().map_err(|e| e.to_string())?;

            if metadata.is_file() && is_dll_file(&path) {
                let is_banned = is_banned_file(&file_name);
                let display_name = if is_banned {
                    strip_banned_suffix(&file_name)
                } else {
                    file_stem(&path).unwrap_or_else(|| file_name.clone())
                };
                mods.push(ModEntry {
                    id: path_to_string(path.clone()),
                    name: display_name,
                    path: path_to_string(path),
                    relative_path: format!("BepInEx/plugins/{}", file_name),
                    source_dir: path_to_string(plugins_dir.clone()),
                    kind: "dll".into(),
                    is_banned,
                    is_directory_mod: false,
                });
                continue;
            }

            if !metadata.is_dir() {
                continue;
            }

            let folder_name = file_name;
            for nested_entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                let nested_entry = nested_entry.map_err(|e| e.to_string())?;
                let nested_path = nested_entry.path();
                let nested_file_name = nested_entry.file_name().to_string_lossy().into_owned();

                if is_ignored_entry(&nested_file_name) || !is_dll_file(&nested_path) {
                    continue;
                }

                let nested_metadata = nested_entry.metadata().map_err(|e| e.to_string())?;
                if !nested_metadata.is_file() {
                    continue;
                }

                let is_banned = is_banned_file(&nested_file_name);
                let display_name = if is_banned {
                    format!("{} - {}", folder_name, strip_banned_suffix(&nested_file_name))
                } else {
                    format!("{} - {}", folder_name, file_stem(&nested_path).unwrap_or_else(|| nested_file_name.clone()))
                };
                mods.push(ModEntry {
                    id: path_to_string(nested_path.clone()),
                    name: display_name,
                    path: path_to_string(nested_path),
                    relative_path: format!("BepInEx/plugins/{}/{}", folder_name, nested_file_name),
                    source_dir: path_to_string(path.clone()),
                    kind: "dll".into(),
                    is_banned,
                    is_directory_mod: true,
                });
            }
        }
    }

    mods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    if active_dirs.is_empty() {
        warnings.push("未找到 BepInEx/plugins 模组目录".into());
    }

    if !game_path.join("SecretFlasherManaka.exe").is_file() {
        warnings.push("未在游戏目录中找到 SecretFlasherManaka.exe".into());
    }

    Ok(ScanModsResult {
        mods,
        checked_dirs,
        active_dirs,
        warnings,
        missing_core_files,
        bepin_ex_installed,
        scanned_at: current_timestamp(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_config_table",
            sql: "CREATE TABLE IF NOT EXISTS config (
                id INTEGER PRIMARY KEY,
                `key` TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                installed_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "ensure_tables_exist",
            sql: "CREATE TABLE IF NOT EXISTS config (
                id INTEGER PRIMARY KEY,
                `key` TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_installed_workshop_mods",
            sql: "CREATE TABLE IF NOT EXISTS installed_workshop_mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_key TEXT NOT NULL UNIQUE,
                mod_id INTEGER DEFAULT 0,
                category TEXT NOT NULL,
                installed_version TEXT NOT NULL,
                file_hash TEXT DEFAULT '',
                installed_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add_lang_code_to_installed_workshop_mods",
            sql: "ALTER TABLE installed_workshop_mods ADD COLUMN lang_code TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_manifest_to_installed_workshop_mods",
            sql: "ALTER TABLE installed_workshop_mods ADD COLUMN manifest TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "create_installed_workshop_mod_files",
            sql: "CREATE TABLE IF NOT EXISTS installed_workshop_mod_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_key TEXT NOT NULL,
                lang_code TEXT NOT NULL,
                installed_version TEXT NOT NULL,
                file_hash TEXT DEFAULT '',
                manifest TEXT DEFAULT '',
                installed_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(mod_key, lang_code)
            );",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            open_folder, scan_mods, toggle_mod_enabled, batch_toggle_mod_enabled, http_request, test_network, download_and_extract_7z,
            db::db_login, db::db_register,
            db::db_list_mods, db::db_list_my_mods,
            db::db_get_mod_detail, db::db_get_mod_for_edit,
            db::db_create_mod, db::db_update_mod, db::db_delete_mod,
            db::db_save_mod_file,
            db::db_check_mod_key,
            db::db_delete_mod_file,
            db::db_get_imgbed_config,
            db::db_delete_imgbed_file,
            db::db_get_version,
            db::db_add_comment, db::db_get_comments, db::db_get_replies, db::db_edit_comment, db::db_delete_comment,
            db::db_like_mod, db::db_unlike_mod,
            db::db_check_updates,
            db::db_prepare_update,
            db::db_apply_update,
            // 权限系统
            db::db_set_mod_permissions,
            db::db_submit_application,
            db::db_list_applications,
            db::db_handle_application,
            db::db_get_unread_count,
            db::db_get_my_notifications,
            db::db_mark_read,
        ])
        .plugin(
            Builder::default()
                .add_migrations("sqlite:config.db", migrations)
                .build(),
        )
        .manage(db::DbState::new().expect("failed to init MySQL pool"))
        .setup(|app| {
            // 启动 MySQL 连接池空闲检查器：超过 60 秒无请求则释放连接
            app.state::<db::DbState>().pool.start_idle_checker();

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
