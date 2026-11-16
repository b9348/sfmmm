// v2 前置（CMV2 / SFM_custom_mission_v2.dll）版本检测。
//
// 背景：本程序的 v2 mod 依赖 SFM_custom_mission_v2.dll 的 2.4.0 行为，旧版插件
// 会出现 mod 不兼容。检测方式改为直接读 dll 内嵌的 VS_VERSIONINFO（FileVersion，
// 形如 2.4.0.0）与 REQUIRED 逐位比较，不再依赖分发包的打包时间或文件哈希：
//   - mtime 会被拷贝/解压工具改写，哈希则会随无关改动（重编译）失效；
//   - 版本号是插件作者主动维护的语义信息，跨机器稳定。
//
// 前端两处（详情页「安装」、侧栏「启动游戏」）在动作前调用本命令，低于要求时
// 弹右下角 toast 引导更新。dll 缺失 → missing（由前置卡片负责引导安装）；
// 读不出版本（非标准改版/损坏）→ unknown，一律 fail-open 不打扰用户。

use std::path::Path;

use serde::Serialize;

/// 允许使用的最低 v2 前置版本。
const REQUIRED: [u64; 3] = [2, 4, 0];

/// 插件 dll 相对游戏根目录的路径。
const DLL_REL: &str = "BepInEx/plugins/SFM_custom_mission_v2.dll";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2PrereqVersionResult {
    /// "ok"=版本达标 | "outdated"=低于要求 | "missing"=未安装 | "unknown"=读不出版本（放行）
    pub status: String,
    /// 已安装插件的 FileVersion（取前三段，如 "2.4.0"）；缺失/读不出时为 None
    pub installed_version: Option<String>,
    /// 最低要求版本，前端文案插值用，避免双端硬编码漂移
    pub required: String,
}

fn required_str() -> String {
    format!("{}.{}.{}", REQUIRED[0], REQUIRED[1], REQUIRED[2])
}

fn result(status: &str, installed_version: Option<String>) -> V2PrereqVersionResult {
    V2PrereqVersionResult { status: status.into(), installed_version, required: required_str() }
}

/// 读游戏目录已安装的 v2 前置版本并与基准比较。
///
/// game_path 为空时回退到 config.db 里的 game_path；调用方（详情页/启动游戏）
/// 通常不传，让后端自己取最新配置，避免前端缓存了过期路径。
#[tauri::command]
pub fn check_v2_prereq_version(
    app: tauri::AppHandle,
    game_path: Option<String>,
) -> V2PrereqVersionResult {
    let root = match game_path.filter(|p| !p.trim().is_empty()) {
        Some(p) => p,
        None => match crate::db::subscribe::read_game_path(&app) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[v2_prereq] 读取 game_path 失败: {e}");
                return result("missing", None);
            }
        },
    };
    let dll = Path::new(root.trim_end_matches(|c| c == '/' || c == '\\')).join(DLL_REL);
    if !dll.is_file() {
        return result("missing", None);
    }
    match read_file_version(&dll) {
        Some(v) => {
            let installed = format!("{}.{}.{}", v.0, v.1, v.2);
            let status = if is_outdated(v) { "outdated" } else { "ok" };
            log::debug!("[v2_prereq] 已安装 {installed}，基准 {}，判定 {status}", required_str());
            result(status, Some(installed))
        }
        None => {
            log::warn!("[v2_prereq] 读取 {} 版本资源失败", dll.display());
            result("unknown", None)
        }
    }
}

fn is_outdated(v: (u16, u16, u16, u16)) -> bool {
    [v.0 as u64, v.1 as u64, v.2 as u64] < REQUIRED
}

// ── 读 VS_VERSIONINFO 的 FileVersion ─────────────────────

#[cfg(target_os = "windows")]
fn read_file_version(path: &Path) -> Option<(u16, u16, u16, u16)> {
    use std::ffi::c_void;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;

    #[link(name = "version")]
    extern "system" {
        fn GetFileVersionInfoSizeW(filename: *const u16, handle: *mut u32) -> u32;
        fn GetFileVersionInfoW(
            filename: *const u16,
            handle: u32,
            len: u32,
            data: *mut c_void,
        ) -> i32;
        fn VerQueryValueW(
            block: *const c_void,
            sub_block: *const u16,
            buffer: *mut *mut c_void,
            len: *mut u32,
        ) -> i32;
    }

    // VS_FIXEDFILEINFO：全为 u32，前 6 个字段即签名与两个版本号
    #[repr(C)]
    #[allow(dead_code)] // 只需前 6 个字段，其余按布局占位
    struct FixedFileInfo {
        signature: u32,
        struct_version: u32,
        file_version_ms: u32,
        file_version_ls: u32,
        product_version_ms: u32,
        product_version_ls: u32,
        file_flags_mask: u32,
        file_flags: u32,
        file_os: u32,
        file_type: u32,
        file_subtype: u32,
        file_date_ms: u32,
        file_date_ls: u32,
    }

    const VS_FFI_SIGNATURE: u32 = 0xFEEF04BD;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(once(0)).collect();
    let mut handle: u32 = 0;
    // SAFETY: wide 以 NUL 结尾且在整个调用期间存活
    let size = unsafe { GetFileVersionInfoSizeW(wide.as_ptr(), &mut handle) };
    if size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size as usize];
    // SAFETY: buf 长度按上一步返回的 size 分配，写入不越界
    if unsafe { GetFileVersionInfoW(wide.as_ptr(), 0, size, buf.as_mut_ptr() as *mut c_void) } == 0 {
        return None;
    }

    let sub: Vec<u16> = "\\".encode_utf16().chain(once(0)).collect();
    let mut ptr: *mut c_void = null_mut();
    let mut len: u32 = 0;
    // SAFETY: buf 仍是有效的版本资源块；sub 以 NUL 结尾
    if unsafe {
        VerQueryValueW(buf.as_ptr() as *const c_void, sub.as_ptr(), &mut ptr, &mut len)
    } == 0
        || ptr.is_null()
        || (len as usize) < std::mem::size_of::<FixedFileInfo>()
    {
        return None;
    }
    // SAFETY: VerQueryValueW 返回的指针指向 buf 内、长度至少为 FixedFileInfo
    let info = unsafe { &*(ptr as *const FixedFileInfo) };
    if info.signature != VS_FFI_SIGNATURE {
        return None;
    }
    let major = (info.file_version_ms >> 16) as u16;
    let minor = (info.file_version_ms & 0xFFFF) as u16;
    let build = (info.file_version_ls >> 16) as u16;
    let revision = (info.file_version_ls & 0xFFFF) as u16;
    Some((major, minor, build, revision))
}

#[cfg(not(target_os = "windows"))]
fn read_file_version(_path: &Path) -> Option<(u16, u16, u16, u16)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_versions_are_outdated() {
        assert!(is_outdated((2, 3, 8, 0)));
        assert!(is_outdated((2, 3, 99, 0)));
        assert!(is_outdated((1, 99, 0, 0)));
    }

    #[test]
    fn required_and_newer_are_ok() {
        assert!(!is_outdated((2, 4, 0, 0)));
        assert!(!is_outdated((2, 4, 0, 5))); // 只比较前三段，修订号不参与
        assert!(!is_outdated((2, 10, 0, 0))); // 逐位比较，非字典序
        assert!(!is_outdated((3, 0, 0, 0)));
    }

    #[test]
    fn required_string_matches_constant() {
        assert_eq!(required_str(), "2.4.0");
    }

    /// 对真实 dll 跑端到端读取（校验 version.dll FFI 与字段拼接）：
    /// V2_DLL=E:/.../SFM_custom_mission_v2.dll cargo test --lib real_dll -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_dll_reports_expected_version() {
        let p = std::env::var("V2_DLL").expect("需设置 V2_DLL");
        let v = read_file_version(Path::new(&p)).expect("读取 FileVersion 失败");
        let expected = std::env::var("EXPECT").unwrap_or_else(|_| "2.4.0".into());
        assert_eq!(format!("{}.{}.{}", v.0, v.1, v.2), expected, "V2_DLL={p}");
        assert!(!is_outdated(v), "本机 dll 应不低于基准");
    }
}
