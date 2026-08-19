use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::OptionalExtension;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_sql::{Builder, Migration, MigrationKind};
use futures_util::StreamExt;

pub mod db;
mod webview_check;

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
    /// 游戏根目录 .doorstop_version 文件内容（BepInEx 6 的 Doorstop 引导器版本号）
    doorstop_version: Option<String>,
    /// 是否为 SFMMM 推荐版本（RECOMMENDED_DOORSTOP_VERSION），否则即使已安装也提示兼容性问题
    doorstop_compatible: bool,
    scanned_at: String,
}

/// SFMMM 实测推荐使用的 Doorstop 版本（BepInEx 6 内置引导器）。
/// 不同版本实测效果更好（见需求：非 4.3.0 时提示用户更换推荐版本）。
const RECOMMENDED_DOORSTOP_VERSION: &str = "4.3.0";

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

#[tauri::command(rename_all = "snake_case")]
fn open_folder(path: String, selected_items: Option<Vec<String>>) -> Result<(), String> {
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

/// 启动游戏：运行游戏根目录下的 SecretFlasherManaka.exe，不打开任何页面。
/// 工作目录设为游戏目录，保证游戏能按相对路径找到资源文件。
#[tauri::command]
fn launch_game(game_path: String) -> Result<(), String> {
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
        std::process::Command::new(&exe_path)
            .current_dir(&game_dir)
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
    // 读取 .doorstop_version 文件内容（BepInEx 6 引导器版本），判断是否为 SFMMM 推荐版本
    let doorstop_version = fs::read_to_string(game_path.join(".doorstop_version"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let doorstop_compatible = doorstop_version.as_deref() == Some(RECOMMENDED_DOORSTOP_VERSION);

    if !bepin_ex_installed {
        warnings.push("mod 前置未安装或不完整".into());
        return Ok(ScanModsResult {
            mods,
            checked_dirs,
            active_dirs,
            warnings,
            missing_core_files,
            bepin_ex_installed,
            doorstop_version,
            doorstop_compatible,
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
        doorstop_version,
        doorstop_compatible,
        scanned_at: current_timestamp(),
    })
}

// ─────────────────────────── 存档管理 ───────────────────────────
// 存档目录固定位于系统用户目录下：
//   C:\Users\<用户名>\AppData\LocalLow\SheableSoft\SecretFlasherManaka\SaveData
// 目录内文件约定：
//   - 0-x.sd（x 为数字）: 游戏存档文件
//   - s.sd              : 游戏设置文件
//   - <任意>.sd.bak     : 存档备份文件（由本应用备份生成）

fn save_data_dir() -> Result<PathBuf, String> {
    let profile = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法获取用户目录（USERPROFILE/HOME）".to_string())?;
    Ok(PathBuf::from(profile)
        .join("AppData")
        .join("LocalLow")
        .join("SheableSoft")
        .join("SecretFlasherManaka")
        .join("SaveData"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileInfo {
    name: String,
    path: String,
    size: u64,
    /// 最后修改时间，格式 yyyy-MM-dd HH:mm:ss（本地时区）
    modified: String,
    /// save=存档文件(0-x.sd) / settings=设置文件(s.sd) / backup=备份文件(*.sd.bak)
    kind: String,
}

fn format_local_time(time: SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Local> = time.into();
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 流式计算文件的 SHA-256（十六进制小写）。
fn sha256_hex_file(path: &PathBuf) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取文件失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    Ok(hex)
}

/// 读取文件的大小 / 修改时间 / SHA-256，构成备份校验指纹。
fn file_fingerprint(path: &PathBuf) -> Result<(u64, String, String), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("读取文件信息失败: {}", e))?;
    let size = metadata.len();
    let modified = metadata
        .modified()
        .map(format_local_time)
        .unwrap_or_default();
    let hash = sha256_hex_file(path)?;
    Ok((size, modified, hash))
}

/// 返回存档目录绝对路径（供前端"打开文件夹"使用）。
#[tauri::command]
fn get_save_dir() -> Result<String, String> {
    save_data_dir().map(|p| path_to_string(p))
}

/// 列出存档目录下的存档文件与备份文件。
/// 目录不存在时视为“没有存档”，返回空列表（不报错，方便首次运行展示空态）。
#[tauri::command]
fn list_save_files() -> Result<Vec<SaveFileInfo>, String> {
    let dir = save_data_dir()?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取存档目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取存档条目失败: {}", e))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // 只关心 .sd 存档/设置文件 与 .sd.bak 备份文件
        let lower = name.to_lowercase();
        let kind = if lower.ends_with(".sd.bak") {
            "backup"
        } else if lower.ends_with(".sd") {
            if lower == "s.sd" {
                "settings"
            } else {
                "save"
            }
        } else {
            continue;
        };

        let metadata = entry.metadata().map_err(|e| format!("读取文件信息失败: {}", e))?;
        files.push(SaveFileInfo {
            name,
            path: path_to_string(path),
            size: metadata.len(),
            modified: metadata
                .modified()
                .map(format_local_time)
                .unwrap_or_else(|_| String::new()),
            kind: kind.into(),
        });
    }

    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(files)
}

/// 备份存档：将 {name}.sd 复制为 {name}.sd.bak。
/// 若备份文件已存在则报错（前端 toast 提示），避免静默覆盖已有备份。
/// 备份成功后把备份文件的大小/修改时间/SHA-256 写入 save_backups 表，
/// 还原时逐项比对一致才允许还原（防止备份被篡改/损坏后误还原）。
#[tauri::command]
fn backup_save_file(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = save_data_dir()?;
    let src = dir.join(&name);
    if !src.is_file() {
        return Err(format!("存档文件不存在: {}", name));
    }
    let backup_name = format!("{}.bak", name);
    let dst = dir.join(&backup_name);
    if dst.exists() {
        return Err(format!("备份文件已存在: {}", backup_name));
    }
    fs::copy(&src, &dst).map_err(|e| format!("备份失败: {}", e))?;

    // 录入备份文件指纹（注意：以复制出的 .bak 文件本身为准，还原时比对的是它）
    // 指纹读取或记录写入失败时，删除刚复制的 .bak，避免留下无校验记录的残留备份
    // （残留备份既无法还原，又会因“备份文件已存在”阻塞重新备份）。
    let result = (|| -> Result<(), String> {
        let (size, modified, hash) = file_fingerprint(&dst)?;
        let conn = crate::db::subscribe::open_sqlite(&app)?;
        conn.execute(
            "INSERT INTO save_backups (backup_name, src_name, size, modified, hash)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(backup_name) DO UPDATE SET src_name = ?2, size = ?3, modified = ?4, hash = ?5",
            rusqlite::params![backup_name, name, size as i64, modified, hash],
        )
        .map_err(|e| format!("写入备份校验记录失败: {}", e))?;
        Ok(())
    })();

    if let Err(e) = result {
        let _ = fs::remove_file(&dst);
        return Err(e);
    }

    Ok(())
}

/// 还原备份：将 {name}.sd.bak 复制回 {name}.sd。
/// 校验规则：
///   - 备份文件的大小/修改时间/SHA-256 与备份时录入 save_backups 的记录
///     逐一比对，任何一项不一致（备份被篡改/损坏/无记录）都拒绝还原；
///   - 指纹校验通过后，若目标存档已存在：
///       overwrite=false → 返回带 `CONFLICT:` 前缀的错误码（前端弹窗询问用户）；
///       overwrite=true  → 直接覆盖还原。
#[tauri::command]
fn restore_save_file(app: tauri::AppHandle, name: String, overwrite: bool) -> Result<(), String> {
    if !name.to_lowercase().ends_with(".sd.bak") {
        return Err(format!("不是备份文件: {}", name));
    }
    let dir = save_data_dir()?;
    let src = dir.join(&name);
    if !src.is_file() {
        return Err(format!("备份文件不存在: {}", name));
    }

    // 指纹校验：与备份时录入的记录逐项比对（size / modified / hash）
    let (cur_size, cur_modified, cur_hash) = file_fingerprint(&src)?;
    let conn = crate::db::subscribe::open_sqlite(&app)?;
    let record = conn
        .query_row(
            "SELECT size, modified, hash FROM save_backups WHERE backup_name = ?",
            rusqlite::params![name],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
        )
        .optional()
        .map_err(|e| format!("读取备份校验记录失败: {}", e))?;

    let Some((rec_size, rec_modified, rec_hash)) = record else {
        return Err(format!("备份文件缺少校验记录，无法还原: {}", name));
    };

    if cur_size != rec_size as u64 || cur_modified != rec_modified || cur_hash != rec_hash {
        return Err(format!(
            "备份文件与备份时记录不一致（大小/时间/哈希校验未通过），可能已被修改或损坏，禁止还原: {}",
            name
        ));
    }

    // 去掉 .bak 后缀得到目标存档名（0-x.sd / s.sd）
    let target_name = name[..name.len() - 4].to_string();
    let dst = dir.join(&target_name);
    if dst.exists() && !overwrite {
        // 冲突错误码：前端据此弹窗询问是否覆盖，而不是直接 toast
        return Err(format!("CONFLICT:同名存档已存在，还原会产生命名冲突: {}", target_name));
    }

    // overwrite=true 或目标不存在时，直接复制（fs::copy 会覆盖已存在文件）
    fs::copy(&src, &dst).map_err(|e| format!("还原失败: {}", e))?;
    Ok(())
}

/// 重命名存档目录内的文件（存档 / 设置 / 备份均可）。
/// 校验：新文件名必须合法（非空、无路径分隔符）、且不与现有条目冲突。
/// 改名成功后同步更新 save_backups 表中的对应记录（backup_name / src_name），
/// 保证指纹校验记录始终指向当前文件名。
#[tauri::command]
fn rename_save_file(app: tauri::AppHandle, name: String, new_name: String) -> Result<(), String> {
    let dir = save_data_dir()?;
    let src = dir.join(&name);
    if !src.is_file() {
        return Err(format!("文件不存在: {}", name));
    }
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() {
        return Err("文件名不能为空".into());
    }
    if new_name.contains('/') || new_name.contains('\\') || new_name.contains(':') {
        return Err("文件名包含非法字符".into());
    }
    if new_name.eq_ignore_ascii_case(&name) {
        return Ok(());
    }

    // 扩展名类别校验：备份（.sd.bak）与存档/设置（.sd）不能互相改名，
    // 否则会破坏文件名分类与 save_backups 记录的一致性。
    let name_lower = name.to_lowercase();
    let new_lower = new_name.to_lowercase();
    let is_backup = name_lower.ends_with(".sd.bak");
    if is_backup && !new_lower.ends_with(".sd.bak") {
        return Err("备份文件改名后必须以 .sd.bak 结尾".into());
    }
    if !is_backup && name_lower.ends_with(".sd") && !new_lower.ends_with(".sd") {
        return Err("存档/设置文件改名后必须以 .sd 结尾".into());
    }

    let dst = dir.join(&new_name);
    if dst.exists() {
        return Err(format!("同名文件已存在: {}", new_name));
    }

    // 改名存档/设置时，若有同名备份文件需一并重命名；目标备份名已存在时
    // 拒绝改名（避免静默覆盖其他存档的备份），并在主文件改名后同步移动备份。
    let src_backup = dir.join(format!("{}.bak", name));
    let dst_backup = dir.join(format!("{}.bak", new_name));
    let has_backup = !is_backup && src_backup.exists();
    if has_backup && dst_backup.exists() {
        return Err(format!("同名备份文件已存在: {}", new_name));
    }

    fs::rename(&src, &dst).map_err(|e| format!("重命名失败: {}", e))?;
    if has_backup {
        fs::rename(&src_backup, &dst_backup).map_err(|e| format!("重命名备份文件失败: {}", e))?;
    }

    // 同步更新 save_backups 记录：
    //   - 改的是备份文件（xx.sd.bak → yy.sd.bak）：backup_name 与 src_name 都平移后缀；
    //   - 改的是存档/设置（xx.sd → yy.sd）：src_name 平移，backup_name（xx.sd.bak）跟随。
    let conn = crate::db::subscribe::open_sqlite(&app)?;
    if is_backup {
        let new_src = &new_name[..new_name.len() - 4]; // 去掉 .bak 后缀（类别校验已保证存在）
        conn.execute(
            "UPDATE save_backups
             SET backup_name = ?2, src_name = ?3
             WHERE backup_name = ?1",
            rusqlite::params![name, new_name, new_src],
        )
        .map_err(|e| format!("更新备份校验记录失败: {}", e))?;
    } else {
        conn.execute(
            "UPDATE save_backups
             SET src_name = ?2, backup_name = ?3
             WHERE src_name = ?1",
            rusqlite::params![name, new_name, format!("{}.bak", new_name)],
        )
        .map_err(|e| format!("更新备份校验记录失败: {}", e))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动前检测 WebView2 运行时；缺失则弹 Windows 原生 MessageBox
    // （按系统语言选择中/英/日文案），并用系统默认浏览器打开下载链接。
    if !webview_check::ensure_webview2() {
        std::process::exit(1);
    }

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
        Migration {
            version: 7,
            description: "add_file_hashes_to_installed_workshop_mods",
            sql: "ALTER TABLE installed_workshop_mods ADD COLUMN file_hashes TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "create_liked_workshop_mods_cache",
            sql: "CREATE TABLE IF NOT EXISTS liked_workshop_mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_id INTEGER NOT NULL UNIQUE,
                mod_key TEXT DEFAULT '',
                display_name TEXT DEFAULT '',
                description TEXT DEFAULT '',
                category TEXT DEFAULT '',
                author_id INTEGER DEFAULT 0,
                author_name TEXT DEFAULT '',
                author_avatar TEXT DEFAULT '',
                download_count INTEGER DEFAULT 0,
                like_count INTEGER DEFAULT 0,
                is_liked INTEGER DEFAULT 1,
                comment_count INTEGER DEFAULT 0,
                files TEXT DEFAULT '',
                translations TEXT DEFAULT '',
                created_at TEXT DEFAULT '',
                updated_at TEXT DEFAULT '',
                cached_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "create_rated_workshop_mods_cache",
            sql: "CREATE TABLE IF NOT EXISTS rated_workshop_mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_id INTEGER NOT NULL UNIQUE,
                mod_key TEXT DEFAULT '',
                my_rating REAL DEFAULT 0,
                rating_avg REAL DEFAULT 0,
                rating_count INTEGER DEFAULT 0,
                cached_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "add_full_snapshot_to_rated_workshop_mods",
            sql: "ALTER TABLE rated_workshop_mods ADD COLUMN display_name TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN description TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN category TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN author_id INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN author_name TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN author_avatar TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN download_count INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN like_count INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN is_liked INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN comment_count INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN files TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN translations TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN created_at TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN updated_at TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "create_subscription_tasks",
            sql: "CREATE TABLE IF NOT EXISTS subscription_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_key TEXT NOT NULL,
                mod_id INTEGER DEFAULT 0,
                category TEXT DEFAULT '',
                lang_code TEXT DEFAULT '',
                version TEXT DEFAULT '',
                file_url TEXT NOT NULL,
                file_hash TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                percent INTEGER DEFAULT 0,
                stage TEXT DEFAULT '',
                error TEXT DEFAULT '',
                target_dir TEXT DEFAULT '',
                manifest TEXT DEFAULT '',
                retry_of INTEGER DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT DEFAULT ''
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "add_subscription_tasks_meta_cols",
            // 订阅时冗余存一份工坊卡片的展示信息，让订阅记录页离线也能显示文件名+简介，
            // 与工坊/任务文件夹卡片语义一致；避免每条任务进页都回查 MySQL。
            sql: "ALTER TABLE subscription_tasks ADD COLUMN display_name TEXT DEFAULT '';
                ALTER TABLE subscription_tasks ADD COLUMN description TEXT DEFAULT '';
                ALTER TABLE subscription_tasks ADD COLUMN translations TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "create_bepinex_tasks",
            // BepInEx 前置一键安装的后台任务表：与 subscription_tasks 同款持久化，
            // 让 Rust 后台下载不依赖前端生命周期，重启可恢复进度/错误。
            sql: "CREATE TABLE IF NOT EXISTS bepinex_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                percent INTEGER DEFAULT 0,
                stage TEXT DEFAULT '',
                error TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT DEFAULT ''
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "create_update_tasks",
            // 应用自更新安装包下载的后台任务表：与 subscription_tasks / bepinex_tasks
            // 同款持久化，让 Rust 后台下载不依赖前端生命周期，离开设置页/重启后
            // 通过 db_get_update_status 查询恢复进度/错误/已就绪。
            sql: "CREATE TABLE IF NOT EXISTS update_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                percent INTEGER DEFAULT 0,
                stage TEXT DEFAULT '',
                error TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT DEFAULT ''
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "create_save_backups",
            // 存档备份校验表：备份存档时录入源存档的大小/修改时间/hash，
            // 还原时三项逐一比对一致才允许还原（防止备份文件被篡改/损坏后误还原）。
            sql: "CREATE TABLE IF NOT EXISTS save_backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                backup_name TEXT NOT NULL UNIQUE,
                src_name TEXT NOT NULL,
                size INTEGER DEFAULT 0,
                modified TEXT DEFAULT '',
                hash TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "add_version_to_update_tasks",
            // 记录下载任务对应的目标版本：静默自动更新时，前端据此判断 ready 安装包
            // 是否仍对应当前最新版（避免把过期/残留的旧版安装包自动提升为待应用，
            // 也避免对其他渠道下载的旧版安装包重复覆盖）。旧行默认空串，视为未知。
            sql: "ALTER TABLE update_tasks ADD COLUMN version TEXT DEFAULT ''",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "add_size_cols_to_bepinex_tasks",
            // BepInEx 前置下载任务记录已下载/总大小（字节），配合 db/download.rs 共享引擎
            // 的进度上报（downloaded/total/speed），前端可显示"已下载 X / Y · 速度"。
            sql: "ALTER TABLE bepinex_tasks ADD COLUMN downloaded INTEGER DEFAULT 0;
                  ALTER TABLE bepinex_tasks ADD COLUMN total INTEGER DEFAULT 0;",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            open_folder, launch_game, scan_mods, toggle_mod_enabled, batch_toggle_mod_enabled, http_request, download_and_extract_7z,
            list_save_files, backup_save_file, restore_save_file, rename_save_file, get_save_dir,
            db::db_login, db::db_register, db::db_update_profile,
            db::db_list_mods, db::db_list_my_mods, db::db_list_liked_mods, db::db_list_rated_mods,
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
            db::db_rate_mod, db::db_unrate_mod,
            db::db_check_updates,
            db::db_fetch_latest,
            db::gh::db_gh_latest_release,
            db::hash::db_preflight_mod,
            db::hash::db_set_mod_file_hashes,
            db::installer::db_prepare_update,
            db::installer::db_get_update_status,
            db::installer::db_apply_update,
            db::installer::db_clear_update,
            db::subscribe::db_subscribe_mod,
            db::subscribe::db_list_subscription_tasks,
            db::subscribe::db_cancel_subscription,
            db::bepinex::db_install_bepinex,
            db::bepinex::db_get_bepinex_task,
            // 权限系统
            db::db_set_mod_permissions,
            db::db_submit_application,
            db::db_list_applications,
            db::db_handle_application,
            db::db_get_unread_count,
            db::db_get_my_notifications,
            db::db_mark_read,
            db::db_get_user_public_profile,
            // 讨论区
            db::db_list_discussions, db::db_get_discussion_detail,
            db::db_create_discussion, db::db_update_discussion, db::db_delete_discussion,
            db::db_like_discussion, db::db_unlike_discussion,
            db::db_boost_discussion, db::db_unboost_discussion,
            db::db_vote_poll, db::db_get_poll_results,
            db::db_add_discussion_comment, db::db_get_discussion_comments,
            db::db_get_discussion_replies, db::db_edit_discussion_comment, db::db_delete_discussion_comment,
            db::db_list_my_discussions, db::db_list_my_discussion_comments,
        ])
        .plugin(
            Builder::default()
                .add_migrations("sqlite:config.db", migrations)
                .build(),
        )
        .manage(db::DbState::new().expect("failed to init MySQL pool"))
        .setup(|app| {
            // 清理旧版本残留的 .env 文件（以前被错误地打包进安装目录）
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let old_env = dir.join(".env");
                    if old_env.exists() {
                        let _ = std::fs::remove_file(&old_env);
                        log::info!("已清理旧版残留的 .env 文件: {:?}", old_env);
                    }
                }
            }

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
