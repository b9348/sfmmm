mod api;
mod commands;
pub mod db;
mod fs_util;
mod migrations;
mod notify_ws;
mod webview_check;
#[cfg(desktop)]
mod window;
mod xport;

use tauri::Manager;
use tauri_plugin_sql::Builder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 离线开发模式（pnpm tauri dev:of 注入 SFMMM_OFFLINE=1）：只读本地缓存，不连云数据库
    if db::offline_dev() {
        println!("[offline] 离线开发模式：SFMMM_OFFLINE=1，不连接云数据库，仅使用本地缓存");
    }

    // 启动前检测 WebView2 运行时；缺失则弹 Windows 原生 MessageBox
    // （按系统语言选择中/英/日文案），并用系统默认浏览器打开下载链接。
    if !webview_check::ensure_webview2() {
        std::process::exit(1);
    }

    let sql_migrations = migrations::all();

    let builder = tauri::Builder::default();

    // 单实例守卫：crate 根带 `#![cfg(not(any(target_os = "android", target_os = "ios")))]`，
    // 只能在桌面构建注册，否则移动端编译直接失败。
    // 必须是链上第一个插件（官方要求）：二次启动要在其他插件初始化完之前就接管，
    // 直接把已有主窗口唤到前台后退出新进程，避免多开各自建 MySQL 连接池。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // 主窗口 visible:false，由前端 usePersistUI 在首帧渲染后自行 show()。
        // 因此这里不能无条件 show()，否则会破坏「首帧后再显示」的防白屏时序。
        let Some(window) = app.get_webview_window("main") else {
            log::warn!("[single-instance] 收到二次启动请求，但未找到主窗口，已忽略");
            return;
        };
        // 不可见 = 主实例仍在启动阶段（前端还没显示窗口），交给前端自己显示
        if !window.is_visible().unwrap_or(true) {
            log::info!("[single-instance] 收到二次启动请求，主窗口尚未显示，交由前端首帧后显示");
            return;
        }
        // 最小化时 is_visible 仍为 true，故与「正常可见」走同一分支恢复
        if window.is_minimized().unwrap_or(false) {
            if let Err(e) = window.unminimize() {
                log::warn!("[single-instance] unminimize 失败: {e}");
            }
        }
        if let Err(e) = window.show() {
            log::warn!("[single-instance] show 失败: {e}");
        }
        if let Err(e) = window.set_focus() {
            log::warn!("[single-instance] set_focus 失败: {e}");
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            commands::system::open_folder,
            commands::system::open_file,
            commands::system::launch_game,
            commands::system::path_has_non_ascii,
            commands::mods::scan_mods,
            commands::mods::check_game_version,
            commands::game_version::check_game_bundle_version,
            commands::v2_prereq::check_v2_prereq_version,
            commands::mods::toggle_mod_enabled,
            commands::mods::batch_toggle_mod_enabled,
            commands::system::http_request,
            commands::link_preview::fetch_link_preview,
            commands::system::download_and_extract_7z,
            commands::saves::list_save_files,
            commands::saves::backup_save_file,
            commands::saves::restore_save_file,
            commands::saves::rename_save_file,
            commands::saves::get_save_dir,
            db::db_login, db::db_legacy_login, db::db_register, db::db_update_profile,
            db::db_change_password,
            db::db_list_mods, db::db_list_my_mods, db::db_list_liked_mods, db::db_list_rated_mods,
            db::db_get_mod_detail, db::db_get_mod_for_edit,
            db::db_create_mod, db::db_update_mod, db::db_delete_mod,
            db::db_force_delete_mod,
            db::db_save_mod_file,
            db::db_check_mod_key,
            db::db_delete_mod_file,
            db::mod_edit_open_workspace,
            db::mod_edit_ensure_base,
            db::mod_edit_import_directory,
            db::mod_edit_auto_apply,
            db::mod_edit_rescan_local,
            db::mod_edit_stage_replace,
            db::mod_edit_unstage_replace,
            db::mod_edit_set_entry_excluded,
            db::mod_edit_set_entry_selected,
            db::mod_edit_add_files,
            db::mod_edit_remove_added_entry,
            db::mod_edit_build_package,
            db::mod_edit_publish_package,
            db::mod_edit_discard_workspace,
            db::db_imgbed_upload_file,
            db::db_cancel_imgbed_upload,
            db::db_delete_imgbed_file,
            db::db_cleanup_imgbed_images,
            db::db_get_version,
            db::db_add_comment, db::db_get_comments, db::db_get_replies, db::db_edit_comment, db::db_delete_comment,
            db::db_locate_mod_comment,
            db::db_like_mod, db::db_unlike_mod,
            db::db_rate_mod, db::db_unrate_mod, db::db_boost_mod, db::db_unboost_mod,
            db::db_check_updates,
            db::db_fetch_latest,
            db::gh::db_gh_latest_release,
            db::hash::db_preflight_mod,
            db::hash::db_hash_file,
            db::db_set_mod_file_hashes,
            db::installer::db_prepare_update,
            db::installer::db_get_update_status,
            db::installer::db_apply_update,
            db::installer::db_clear_update,
            db::installer::db_cancel_update,
            db::bepinex::db_cancel_bepinex,
            db::subscribe::db_subscribe_mod,
            db::subscribe::db_list_subscription_tasks,
            db::subscribe::db_cancel_subscription,
            db::subscribe::db_install_files_present,
            db::subscribe::db_check_mod_overwrite,
            db::archive::db_download_mod_archive,
            db::archive::db_list_archive_tasks,
            db::archive::db_cancel_archive_download,
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
            db::db_get_my_messages,
            db::db_mark_message_read,
            db::db_get_user_public_profile,
            db::db_list_game_masters,
            // 讨论区
            db::db_list_discussions, db::db_get_discussion_detail,
            db::db_create_discussion, db::db_update_discussion, db::db_delete_discussion,
            db::db_like_discussion, db::db_unlike_discussion,
            db::db_boost_discussion, db::db_unboost_discussion,
            db::db_vote_poll, db::db_get_poll_results,
            db::db_add_discussion_comment, db::db_get_discussion_comments,
            db::db_get_discussion_replies, db::db_edit_discussion_comment, db::db_delete_discussion_comment,
            db::db_locate_discussion_comment,
            db::db_list_my_discussions, db::db_list_my_discussion_comments,
            db::db_list_liked_discussions,
            db::db_pool_status,
            db::db_timeouts,
            db::db_conn_stats,
            db::db_ping,
            // 资源线路（图床双域名测速/切换）
            db::cdn::cdn_status,
            db::cdn::cdn_set_mode,
            // 数据库线路（直连云库 / 经香港中继）
            db::db_line_status,
            db::db_line_set,
            db::db_line_probe,
            // NDM（Neat Download Manager）集成：外部下载器接管
            commands::ndm::ndm_status,
            commands::ndm::ndm_send_download,
            // 云服务登录态
            db::db_logout,
            db::db_has_session,
            db::db_list_active_announcements,
            db::db_call_cached,
            // 通知长连接：网络恢复时提前结束退避
            notify_ws::notify_ws_wake,
        ])
        // 必须注册在 sql 插件之前：sql 插件在 setup 阶段执行 preload 迁移，
        // 历史草稿迁移记录会让校验和校验失败并直接中断整个 App 构建（无窗口）
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("sqlite-migration-compat")
                .setup(|app, _api| {
                    migrations::repair_legacy_sqlite_migrations(app);
                    Ok(())
                })
                .build(),
        )
        .plugin(
            Builder::default()
                .add_migrations("sqlite:config.db", sql_migrations)
                .build(),
        )
        .setup(|app| {
            // 云 API 客户端：恢复上次登录令牌（只存在应用配置目录，前端不可见）
            match app.path().app_config_dir() {
                Ok(dir) => api::init(dir),
                Err(e) => log::warn!("[api] 取配置目录失败，登录令牌无法持久化: {e}"),
            }

            // 通知长连接：令牌在 Rust 侧，进程启动有令牌就自动连（无令牌时等待登录）
            notify_ws::init(app.handle().clone());

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

            // 编辑页选择性替换的本地工作区：启动时清理过期草稿并执行磁盘配额
            let handle_for_prune = app.handle().clone();
            std::thread::spawn(move || db::prune_edit_workspaces(&handle_for_prune, None));

            // 上次进程被强杀时留下的订阅临时包（%TEMP%\sfmmm_subscribe_*.zip）
            // 与游戏目录下残留的 .part：此次启动后任务号重新计数，旧文件再也不会
            // 被引用，不清理只会一直堆积。放独立线程，不拖慢窗口出现时机。
            let handle_for_cleanup = app.handle().clone();
            std::thread::spawn(move || {
                db::subscribe::cleanup_stale_temp_zips();
                db::archive::cleanup_stale_parts_on_startup(&handle_for_cleanup);
            });

            // 图床双线路启动测速（后台异步，不阻塞启动；仅 auto 模式采信结果）
            tauri::async_runtime::spawn(db::cdn::probe());

            // 窗口几何恢复（窗口在 tauri.conf.json 中 visible:false）：
            // 此处先同步应用上次尺寸/位置，WebView 首帧渲染完成后由前端调用 show()，
            // 用户看到的第一个画面就是最终几何；4 秒兜底强制显示，防前端异常导致窗口不出现。
            // 桌面独占：APK 窗口由系统全屏管理，没有可恢复的尺寸/位置，也不需要兜底 show。
            #[cfg(desktop)]
            {
            if let Some(window) = app.get_webview_window("main") {
                let db_path = app.path().app_config_dir().ok().map(|d| d.join("config.db"));
                let (restored, maximized) = window::restore_window_geometry(&window, db_path.as_deref());
                if !restored {
                    log::info!("无可用窗口几何记录，按默认尺寸显示");
                }
                let win = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                        // maximize 必须在 show 之后：SW_MAXIMIZE 会显示隐藏窗口，不能提前调用
                        if maximized {
                            let _ = win.maximize();
                        }
                        log::warn!("前端未按时显示窗口，已兜底强制显示");
                    }
                });
            }
            }

            // 日志必须 release 也落盘：后端会在上抛错误前把原始详情（含数据库地址、
            // 表名等基础设施信息）写进 log::error!，返回给前端的只是脱敏摘要。
            // 若只在 debug 构建注册，线上出问题时将没有任何排查依据。
            // 落盘位置：%APPDATA%\com.sfmmm.app\logs\（由 tauri-plugin-log 按 identifier 决定）。
            // Info 级别只收业务日志；依赖库的 Detail 级噪声（tauri/wry 逐帧输出）不采。
            // 单文件限 2MB 且只保留最近 1 个滚动文件，避免长期运行堆积占满磁盘。
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .max_file_size(2 * 1024 * 1024)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                    .build(),
            )?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
