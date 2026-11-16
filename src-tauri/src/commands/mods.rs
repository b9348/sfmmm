use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::fs_util::{current_timestamp, path_to_string, sha256_hex_file};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
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
pub struct ScanModsResult {
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
/// 不同版本实测效果更好（见需求：非 4.5.0 时提示用户更换推荐版本）。
const RECOMMENDED_DOORSTOP_VERSION: &str = "4.5.0";

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

/// 官方最新版（v1.1.3）游戏主程序的 SHA-256，本地游戏版本校验基准。
const OFFICIAL_GAME_EXE_SHA256: &str =
    "01d0b5f4b7a727432b23fd556753ecf543bd612698dd7a1cdd5687875b4de300";
/// 游戏主程序文件名（版本校验对象）。
const GAME_EXE_NAME: &str = "SecretFlasherManaka.exe";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersionCheckResult {
    /// 游戏目录下是否存在主程序
    exe_exists: bool,
    /// 主程序 hash 是否与官方最新版一致
    hash_matches: bool,
}

/// 校验所选游戏目录的主程序 SHA-256 是否与官方最新版（v1.1.3）一致。
/// 主程序缺失时返回 exe_exists=false（不视为错误，前端据此跳过版本提示）。
#[tauri::command]
pub fn check_game_version(game_path: String) -> Result<GameVersionCheckResult, String> {
    let exe_path = PathBuf::from(game_path).join(GAME_EXE_NAME);
    if !exe_path.is_file() {
        return Ok(GameVersionCheckResult { exe_exists: false, hash_matches: false });
    }
    let hash = sha256_hex_file(&exe_path)?;
    Ok(GameVersionCheckResult { exe_exists: true, hash_matches: hash == OFFICIAL_GAME_EXE_SHA256 })
}

#[tauri::command]
pub fn scan_mods(game_path: String) -> Result<ScanModsResult, String> {
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

// 通用禁用/启用改名规则：{stem}.{ext} ⇄ {stem}[ban]{ext}（[ban] 直接替代原扩展名的
// 点号，游戏按扩展名扫描时即不再识别该文件）。不限 dll/json —— v2 任务脚本 (.code)
// 等任意带扩展名的文件都需要可禁用。返回 (新文件名, 改名后是否为禁用名)。
fn toggle_target_name(file_name: &str) -> Option<(String, bool)> {
    let lower = file_name.to_lowercase();
    // 已禁用：末尾为 [ban]<ext>（ext 非空、纯字母数字且不含点）
    if let Some(pos) = lower.rfind("[ban]") {
        let ext = &lower[pos + 5..];
        if !ext.is_empty()
            && !ext.contains('.')
            && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            // to_lowercase 对个别非 ASCII 字符可能改变字节长度，get 保证下标落在字符边界
            let stem = file_name.get(..pos)?;
            return Some((format!("{}.{}", stem, ext), false));
        }
    }
    // 未禁用：取最后一个点号后的扩展名挂上 [ban] 标记
    // （rfind 用 lower 而非 file_name：to_lowercase 极少数情况下会改变字节长度，
    //   统一在 lower 上取下标，stem 再用 get 安全切原串）
    let dot = lower.rfind('.')?;
    if dot == 0 {
        return None; // 点开头的隐藏文件没有可挂标记的扩展名
    }
    let ext = &lower[dot + 1..];
    if ext.is_empty() || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let stem = file_name.get(..dot)?;
    Some((format!("{}[ban]{}", stem, ext), true))
}

#[cfg(test)]
mod toggle_target_name_tests {
    use super::toggle_target_name;

    #[test]
    fn ban_restore_roundtrip() {
        // v2 任务脚本 .code（本次修复的目标场景）
        assert_eq!(toggle_target_name("actions.code"), Some(("actions[ban]code".into(), true)));
        assert_eq!(toggle_target_name("actions[ban]code"), Some(("actions.code".into(), false)));
        // 原有 dll/json 行为不变
        assert_eq!(toggle_target_name("Foo.dll"), Some(("Foo[ban]dll".into(), true)));
        assert_eq!(toggle_target_name("Foo[ban]json"), Some(("Foo.json".into(), false)));
        // 多段点号的 stem 保留完整
        assert_eq!(toggle_target_name("my.mod.code"), Some(("my.mod[ban]code".into(), true)));
        assert_eq!(toggle_target_name("my.mod[ban]code"), Some(("my.mod.code".into(), false)));
        // 大写扩展名统一转小写
        assert_eq!(toggle_target_name("README.CODE"), Some(("README[ban]code".into(), true)));
        // 无扩展名 / 点开头的隐藏文件不可禁用
        assert_eq!(toggle_target_name("LICENSE"), None);
        assert_eq!(toggle_target_name(".gitkeep"), None);
        assert_eq!(toggle_target_name("readme"), None);
    }
}

#[tauri::command]
pub fn toggle_mod_enabled(path: String) -> Result<(bool, String), String> {
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

    let (new_name, is_banned) = toggle_target_name(&file_name)
        .ok_or("无法识别的文件格式")?;

    let new_path = parent.join(&new_name);
    fs::rename(&path, &new_path).map_err(|e| format!("重命名失败: {}", e))?;

    Ok((is_banned, path_to_string(new_path)))
}

#[tauri::command]
pub fn batch_toggle_mod_enabled(dir: String, ban: bool) -> Result<(usize, usize), String> {
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
        // 通用规则（同 toggle_mod_enabled / toggle_target_name）：
        // 禁用只处理未禁用的文件，启用只处理已禁用的，
        // 其余（已处于目标状态、无扩展名等无法识别的文件）原样跳过
        if let Some((new_name, is_banned)) = toggle_target_name(&file_name) {
            if is_banned == ban {
                let new_path = dir.join(&new_name);
                match fs::rename(&path, &new_path) {
                    Ok(_) => success += 1,
                    Err(_) => failed += 1,
                }
            }
        }
    }

    Ok((success, failed))
}
