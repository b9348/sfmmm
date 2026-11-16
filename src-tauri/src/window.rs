/// 从 config.db 同步读取上次窗口几何并应用（尺寸/位置）。
/// 仅恢复，不负责 show/maximize——窗口在 tauri.conf.json 中 visible:false，
/// 由前端 WebView 首帧渲染后调用 show()，消除「默认尺寸白屏 → 跳变上次尺寸」的闪变。
/// maximize 不能在此调用：Windows 上 SW_MAXIMIZE 会显示隐藏窗口，提前调用会破坏防闪变设计，
/// 正常路径由前端在 show() 之后执行，兜底路径由调用处的兜底线程处理。
/// 返回 (是否成功读到配置, 上次是否处于最大化)。
pub fn restore_window_geometry(
    window: &tauri::WebviewWindow,
    db_path: Option<&std::path::Path>,
) -> (bool, bool) {
    let Some(db_path) = db_path else { return (false, false) };
    if !db_path.exists() {
        return (false, false);
    }
    let Ok(conn) = rusqlite::Connection::open(db_path) else { return (false, false) };
    let read = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM config WHERE `key` = ?1",
            [key],
            |r| r.get::<_, String>(0),
        )
        .ok()
    };
    let maximized = read("window_maximized").as_deref() == Some("true");
    let w: i32 = read("window_width").and_then(|v| v.parse().ok()).unwrap_or(0);
    let h: i32 = read("window_height").and_then(|v| v.parse().ok()).unwrap_or(0);
    let x: i32 = read("window_x").and_then(|v| v.parse().ok()).unwrap_or(-32000);
    let y: i32 = read("window_y").and_then(|v| v.parse().ok()).unwrap_or(-32000);

    if w > 100 && h > 100 {
        let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    }
    // 位置合法性：排除最小化残留值（Windows 约 -32000），且窗口矩形须与任一显示器相交（防离屏）
    if x > -30000 && y > -30000 {
        // 尺寸无效（如解析失败默认 0）时用 tauri.conf.json 默认尺寸参与校验，避免退化值导致校验失真
        let (vw, vh) = if w > 100 && h > 100 { (w, h) } else { (800, 600) };
        let on_screen = window
            .available_monitors()
            .map(|monitors| {
                monitors.iter().any(|m| {
                    let mp = m.position();
                    let ms = m.size();
                    let (mx, my) = (mp.x, mp.y);
                    let (mw, mh) = (ms.width as i32, ms.height as i32);
                    x < mx + mw && x + vw > mx && y < my + mh && y + vh > my
                })
            })
            .unwrap_or(false);
        if on_screen {
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    (true, maximized)
}
