// 启动前检测 WebView2 运行时是否存在；缺失则弹 Windows 原生 MessageBox
// （按系统 UI 语言选择中/英/日文案），并用系统默认浏览器打开下载链接。
//
// 不引入 winapi crate，直接用 extern "system" 声明需要的几个 API。

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    // --- Win32 API 声明 ---
    type HKEY = isize;
    type DWORD = u32;
    type LPVOID = *mut std::ffi::c_void;
    type HANDLE = isize;
    type LPCWSTR = *const u16;

    const HKEY_LOCAL_MACHINE: HKEY = 0x80000002u32 as HKEY;
    const HKEY_CURRENT_USER: HKEY = 0x80000001u32 as HKEY;
    const KEY_READ: DWORD = 0x20019;
    const ERROR_SUCCESS: DWORD = 0;
    const MB_OK: DWORD = 0x00000000;
    const MB_ICONERROR: DWORD = 0x00000010;
    const SW_SHOWNORMAL: DWORD = 1;

    extern "system" {
        fn RegOpenKeyExW(hKey: HKEY, lpSubKey: LPCWSTR, ulOptions: DWORD, samDesired: DWORD, phkResult: *mut HKEY) -> i32;
        fn RegCloseKey(hKey: HKEY) -> i32;
        fn MessageBoxW(hWnd: HANDLE, lpText: LPCWSTR, lpCaption: LPCWSTR, uType: DWORD) -> i32;
        fn ShellExecuteW(hwnd: HANDLE, lpOperation: LPCWSTR, lpFile: LPCWSTR, lpParameters: LPCWSTR, lpDirectory: LPCWSTR, nShowCmd: DWORD) -> LPVOID;
        fn GetUserDefaultUILanguage() -> DWORD;
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    const WEBVIEW2_DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

    /// 检查注册表中是否登记了 WebView2 运行时。
    /// WebView2 的 Client Key 在 HKLM 的 WOW6432Node 下，
    /// 同时部分用户级安装会在 HKCU 下登记，两者都检查。
    fn webview2_registered() -> bool {
        const CLIENT_KEY: &str = r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
        const CLIENT_KEY_HKCU: &str = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

        let try_open = |root: HKEY, path: &str| -> bool {
            let wide = to_wide(path);
            let mut hkey: HKEY = 0;
            let rc = unsafe {
                RegOpenKeyExW(root, wide.as_ptr(), 0, KEY_READ, &mut hkey as *mut HKEY)
            };
            if rc == ERROR_SUCCESS as i32 {
                unsafe { RegCloseKey(hkey); }
                true
            } else {
                false
            }
        };

        try_open(HKEY_LOCAL_MACHINE, CLIENT_KEY)
            || try_open(HKEY_CURRENT_USER, CLIENT_KEY_HKCU)
    }

    /// 按系统默认 UI 语言选择提示文案。返回 (标题, 正文)。
    fn localized_texts() -> (&'static str, &'static str) {
        let lang = unsafe { GetUserDefaultUILanguage() } as u16;
        // 主语言 ID 匹配：0x04 zh，0x09 en，0x11 ja
        match lang & 0x3FF {
            0x04 => (
                "缺少 WebView2 运行时",
                "本程序需要 Microsoft Edge WebView2 运行时才能启动，但你的电脑尚未安装。\n\n点击「确定」后，我们会用系统默认浏览器打开 WebView2 官方下载页面，下载安装后重新启动本程序即可。\n\n不知道怎么安装？请用「豆包」提问。",
            ),
            0x11 => (
                "WebView2 ランタイムが見つかりません",
                "このアプリを起動するには Microsoft Edge WebView2 ランタイムが必要ですが、インストールされていません。\n\n「OK」をクリックすると、システムの既定のブラウザで WebView2 の公式ダウンロードページを開きます。インストール後、このアプリを再度起動してください。\n\nインストール方法がわからない場合は、ChatGPT でお尋ねください。",
            ),
            _ => (
                "WebView2 Runtime Not Found",
                "This app requires the Microsoft Edge WebView2 Runtime to launch, but it is not installed on your computer.\n\nClick OK to open the official WebView2 download page in your system default browser. After installing it, restart this app.\n\nNot sure how to install it? Ask ChatGPT.",
            ),
        }
    }

    /// 弹 MessageBox + 用系统默认浏览器打开下载链接。
    fn prompt_and_open_download() {
        let (title, body) = localized_texts();
        let title_w = to_wide(title);
        let body_w = to_wide(body);
        let open_w = to_wide("open");
        let url_w = to_wide(WEBVIEW2_DOWNLOAD_URL);

        unsafe {
            MessageBoxW(0, body_w.as_ptr(), title_w.as_ptr(), MB_OK | MB_ICONERROR);
            ShellExecuteW(
                0,
                open_w.as_ptr(),
                url_w.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }

    /// 入口：检测注册表确认 WebView2 是否安装。
    /// 已安装返回 true；缺失则弹 MessageBox + 用系统默认浏览器打开下载链接，返回 false。
    pub fn ensure_webview2() -> bool {
        if webview2_registered() {
            true
        } else {
            prompt_and_open_download();
            false
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn ensure_webview2() -> bool { true }
}

pub fn ensure_webview2() -> bool {
    imp::ensure_webview2()
}
