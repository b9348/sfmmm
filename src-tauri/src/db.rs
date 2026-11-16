//! 桌面端数据层：
//! - 云数据库操作全部经 [`crate::api`] 代理到 Axum 服务端，本地不再连接 MySQL；
//! - 本地文件相关模块（下载、安装、编辑工作区、订阅任务、图床上传）保留在这里。

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod archive;
pub mod bepinex;
pub mod cdn;
pub mod download;
pub mod gh;
pub mod hash;
pub mod image;
pub mod installer;
pub mod lanzou;
pub mod mod_edit;
pub mod sevenz;
pub mod subscribe;
pub mod update;

pub use archive::*;
pub use bepinex::*;
pub use cdn::*;
pub use download::*;
pub use gh::*;
pub use hash::*;
pub use image::*;
pub use installer::*;
pub use lanzou::*;
pub use mod_edit::*;
pub use subscribe::*;
pub use update::*;

/// 统一的 HTTP User-Agent：`sfmmm/<版本> (<仓库地址>)`。
pub fn user_agent() -> String {
    match option_env!("GITHUB_REPO").filter(|s| !s.is_empty()) {
        Some(repo) => format!(
            "sfmmm/{} (https://github.com/{repo})",
            env!("CARGO_PKG_VERSION")
        ),
        None => format!("sfmmm/{}", env!("CARGO_PKG_VERSION")),
    }
}

/// 离线开发模式开关（`pnpm tauri dev:of` 以 `SFMMM_OFFLINE=1` 启动应用）：
/// 所有云 API 调用直接失败，前端回退到本地 SQLite 缓存。
pub(crate) fn offline_dev() -> bool {
    static OFFLINE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OFFLINE.get_or_init(|| {
        std::env::var("SFMMM_OFFLINE")
            .map(|v| is_truthy(&v))
            .unwrap_or(false)
    })
}

fn is_truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub(crate) fn offline_dev_err() -> String {
    db_err(
        DbErrorKind::OfflineDev,
        "离线开发模式（pnpm tauri dev:of）：未连接云服务，仅使用本地缓存",
    )
}

/// 错误类别：与旧版 `[DBERR:*]` 协议保持一致，前端 i18n 无需改动。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DbErrorKind {
    TooManyConnections,
    QueueTimeout,
    QueryTimeout,
    PoolBusy,
    AuthFailed,
    OfflineDev,
    Network,
}

impl DbErrorKind {
    pub(crate) fn code(self) -> &'static str {
        match self {
            DbErrorKind::TooManyConnections => "TOO_MANY_CONNECTIONS",
            DbErrorKind::QueueTimeout => "QUEUE_TIMEOUT",
            DbErrorKind::QueryTimeout => "QUERY_TIMEOUT",
            DbErrorKind::PoolBusy => "POOL_BUSY",
            DbErrorKind::AuthFailed => "AUTH_FAILED",
            DbErrorKind::OfflineDev => "OFFLINE_DEV",
            DbErrorKind::Network => "NETWORK",
        }
    }
}

pub(crate) fn db_err(kind: DbErrorKind, msg: impl std::fmt::Display) -> String {
    format!("[DBERR:{}] {}", kind.code(), msg)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mods: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub page: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub page_size: Option<u64>,
}

impl ApiResponse {
    pub(crate) fn ok_val(data: serde_json::Value, msg: &str) -> Self {
        Self {
            success: true,
            message: msg.into(),
            data: Some(data),
            mods: None,
            total: None,
            page: None,
            page_size: None,
        }
    }
    pub(crate) fn ok_msg(msg: &str) -> Self {
        Self {
            success: true,
            message: msg.into(),
            data: None,
            mods: None,
            total: None,
            page: None,
            page_size: None,
        }
    }
    pub(crate) fn err(msg: &str) -> Self {
        Self {
            success: false,
            message: msg.into(),
            data: None,
            mods: None,
            total: None,
            page: None,
            page_size: None,
        }
    }
    pub(crate) fn ok_list(
        mods: Vec<serde_json::Value>,
        total: i64,
        page: u64,
        page_size: u64,
    ) -> Self {
        Self {
            success: true,
            message: "OK".into(),
            data: None,
            mods: Some(mods),
            total: Some(total),
            page: Some(page),
            page_size: Some(page_size),
        }
    }
}

pub(crate) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn semver_cmp(a: &str, b: &str) -> i32 {
    let parse = |s: &str| -> Vec<u32> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| p.parse::<u32>().ok())
            .collect()
    };
    let pa = parse(a);
    let pb = parse(b);
    for i in 0..pa.len().max(pb.len()) {
        let va = pa.get(i).copied().unwrap_or(0);
        let vb = pb.get(i).copied().unwrap_or(0);
        if va < vb {
            return -1;
        }
        if va > vb {
            return 1;
        }
    }
    0
}

// ── 云 API 代理命令 ────────────────────────────────────────────
//
// 每个宏展开为与旧 Tauri 命令完全相同的参数签名；前端无需改动。

macro_rules! rpc_command {
    ($name:ident { $($arg:ident : $ty:ty),* $(,)? }) => {
        #[tauri::command(rename_all = "snake_case")]
        pub async fn $name($($arg: $ty),*) -> Result<ApiResponse, String> {
            let mut map = serde_json::Map::new();
            $(
                map.insert(
                    stringify!($arg).to_string(),
                    serde_json::to_value($arg).unwrap_or(serde_json::Value::Null),
                );
            )*
            crate::api::rpc_command(stringify!($name), serde_json::Value::Object(map)).await
        }
    };
}

// 健康探针
rpc_command!(db_ping {});
rpc_command!(db_list_active_announcements {});

// 用户
rpc_command!(db_login { username: String, password: String });
rpc_command!(db_legacy_login { user_id: u64, username: String });
rpc_command!(db_register { username: String, password: String, avatar: Option<String> });
rpc_command!(db_update_profile {
    user_id: u64,
    username: Option<String>,
    avatar: Option<String>,
});
rpc_command!(db_change_password {
    user_id: u64,
    old_password: String,
    new_password: String,
});
rpc_command!(db_list_game_masters {});
rpc_command!(db_get_user_public_profile { user_id: u64 });

// 工坊列表 / 详情
rpc_command!(db_list_mods {
    lang: Option<String>,
    search: Option<String>,
    page: Option<u64>,
    limit: Option<u64>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    device_id: Option<String>,
    category: Option<String>,
});
rpc_command!(db_list_my_mods {
    author_id: u64,
    lang: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
    device_id: Option<String>,
});
rpc_command!(db_list_liked_mods {
    device_id: Option<String>,
    lang: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
});
rpc_command!(db_list_rated_mods {
    user_id: u64,
    lang: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
});
rpc_command!(db_get_mod_detail {
    id: u64,
    mod_key: Option<String>,
    lang: Option<String>,
    user_id: Option<u64>,
    device_id: Option<String>,
});
rpc_command!(db_get_mod_for_edit {
    id: u64,
    user_id: u64,
    force: Option<bool>,
});
rpc_command!(db_create_mod {
    author_id: u64,
    mod_key: String,
    translations: Vec<serde_json::Value>,
    category: Option<String>,
    is_original: Option<bool>,
});
rpc_command!(db_update_mod {
    mod_id: u64,
    author_id: u64,
    category: Option<String>,
    translations: Vec<serde_json::Value>,
    is_original: Option<bool>,
    mod_key: Option<String>,
    force: Option<bool>,
});
rpc_command!(db_check_mod_key { mod_key: String });
rpc_command!(db_delete_mod { mod_id: u64, author_id: u64 });
rpc_command!(db_force_delete_mod { mod_id: u64 });

// 文件记录
rpc_command!(db_save_mod_file {
    mod_id: u64,
    author_id: u64,
    lang_code: String,
    file_url: String,
    file_name: String,
    file_size: i64,
    file_hash: String,
    version: Option<String>,
    manifest: Option<String>,
    file_hashes: Option<String>,
});
rpc_command!(db_delete_mod_file {
    mod_id: u64,
    author_id: u64,
    lang_code: String,
    expected_file_url: Option<String>,
});

// 评论
rpc_command!(db_add_comment {
    mod_id: u64,
    author_id: u64,
    content: String,
    parent_id: Option<u64>,
    reply_to_id: Option<u64>,
});
rpc_command!(db_get_comments {
    mod_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
    sort_order: Option<String>,
    reply_order: Option<String>,
});
rpc_command!(db_get_replies {
    comment_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
    sort_order: Option<String>,
});
rpc_command!(db_locate_mod_comment {
    comment_id: u64,
    top_sort_order: Option<String>,
    reply_sort_order: Option<String>,
});
rpc_command!(db_edit_comment {
    comment_id: u64,
    author_id: u64,
    content: String,
});
rpc_command!(db_delete_comment { comment_id: u64, author_id: u64 });

// 互动
rpc_command!(db_like_mod { mod_id: u64, device_id: String });
rpc_command!(db_unlike_mod { mod_id: u64, device_id: String });
rpc_command!(db_rate_mod { mod_id: u64, user_id: u64, rating: f64 });
rpc_command!(db_unrate_mod { mod_id: u64, user_id: u64 });

// 权限 / 申请
rpc_command!(db_set_mod_permissions {
    author_id: u64,
    mod_id: u64,
    mode: String,
    open_langs: Option<Vec<String>>,
    allow_mod_info: Option<bool>,
    allow_lang: Option<bool>,
    apply_langs: Option<Vec<String>>,
});
rpc_command!(db_submit_application {
    mod_id: u64,
    user_id: u64,
    scope: String,
    target_lang: Option<String>,
    reason: Option<String>,
});
rpc_command!(db_list_applications {
    mod_id: Option<u64>,
    user_id: Option<u64>,
    role: Option<String>,
    status: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
});
rpc_command!(db_handle_application {
    author_id: u64,
    app_id: u64,
    action: String,
});

// 通知
rpc_command!(db_get_unread_count { user_id: u64 });
rpc_command!(db_get_my_notifications {
    user_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
});
rpc_command!(db_mark_read {
    user_id: u64,
    target_type: Option<String>,
    entity: Option<String>,
    ids: Option<Vec<u64>>,
});
rpc_command!(db_get_my_messages {
    user_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
});
rpc_command!(db_mark_message_read {
    user_id: u64,
    ids: Option<Vec<u64>>,
});

// 讨论区
rpc_command!(db_list_discussions {
    page: Option<u64>,
    limit: Option<u64>,
    search: Option<String>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    d_type: Option<String>,
    user_id: Option<u64>,
});
rpc_command!(db_get_discussion_detail {
    id: u64,
    user_id: Option<u64>,
});
rpc_command!(db_create_discussion {
    author_id: u64,
    title: String,
    content: String,
    content_format: Option<String>,
    d_type: Option<String>,
    poll: Option<serde_json::Value>,
});
rpc_command!(db_update_discussion {
    author_id: u64,
    discussion_id: u64,
    title: Option<String>,
    content: Option<String>,
    content_format: Option<String>,
});
rpc_command!(db_delete_discussion {
    author_id: u64,
    discussion_id: u64,
});
rpc_command!(db_like_discussion {
    discussion_id: u64,
    user_id: u64,
});
rpc_command!(db_unlike_discussion {
    discussion_id: u64,
    user_id: u64,
});
rpc_command!(db_boost_discussion {
    discussion_id: u64,
    user_id: u64,
    content: String,
});
rpc_command!(db_unboost_discussion {
    discussion_id: u64,
    user_id: u64,
});
rpc_command!(db_vote_poll {
    poll_id: u64,
    discussion_id: u64,
    user_id: u64,
    option_ids: Option<Vec<u64>>,
    value: Option<i64>,
});
rpc_command!(db_get_poll_results {
    poll_id: u64,
    user_id: Option<u64>,
});
rpc_command!(db_add_discussion_comment {
    discussion_id: u64,
    author_id: u64,
    content: String,
    parent_id: Option<u64>,
    reply_to_id: Option<u64>,
});
rpc_command!(db_get_discussion_comments {
    discussion_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
    sort_order: Option<String>,
    reply_order: Option<String>,
});
rpc_command!(db_get_discussion_replies {
    comment_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
    sort_order: Option<String>,
});
rpc_command!(db_locate_discussion_comment {
    comment_id: u64,
    top_sort_order: Option<String>,
    reply_sort_order: Option<String>,
});
rpc_command!(db_edit_discussion_comment {
    comment_id: u64,
    author_id: u64,
    content: String,
});
rpc_command!(db_delete_discussion_comment {
    comment_id: u64,
    author_id: u64,
});
rpc_command!(db_list_liked_discussions {
    user_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
});
rpc_command!(db_list_my_discussions {
    author_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
    user_id: Option<u64>,
});
rpc_command!(db_list_my_discussion_comments {
    author_id: u64,
    page: Option<u64>,
    page_size: Option<u64>,
});

// 图片清理 / 删除（上传由 image.rs 直接调 api::upload_file）
rpc_command!(db_cleanup_imgbed_images { file_urls: Vec<String> });
rpc_command!(db_delete_imgbed_file { file_url: String });

// 版本
rpc_command!(db_check_updates { installed: Vec<serde_json::Value> });
rpc_command!(db_get_version {});

// 云端逐文件指纹
rpc_command!(db_set_mod_file_hashes {
    mod_key: String,
    lang_code: String,
    file_hashes: String,
    expected_file_hash: Option<String>,
});

// ── 本地诊断命令（保留旧前端接口，语义改为云 API 状态）────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTimeouts {
    pub io_timeout_ms: Option<u64>,
    pub call_soft_timeout_ms: u64,
    pub queue_wait_timeout_ms: u64,
    pub pool_acquire_timeout_ms: u64,
    pub connect_timeout_ms: u64,
}

/// 前端 `dbCall` 兜底超时参数：HTTP 请求 125s，与服务端 60s 处理超时留余量。
#[tauri::command]
pub async fn db_timeouts() -> DbTimeouts {
    DbTimeouts {
        io_timeout_ms: None,
        call_soft_timeout_ms: 120_000,
        queue_wait_timeout_ms: 0,
        pool_acquire_timeout_ms: 5_000,
        connect_timeout_ms: 15_000,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatus {
    pub recent_failure: bool,
    pub pool_ready: bool,
    pub idle_released: bool,
    pub idle_release_at_ms: Option<u64>,
    pub idle_timeout_secs: u64,
    pub server_now_ms: u64,
}

/// 网络信号灯数据源：服务端架构下不再有本机连接池与空闲释放倒计时。
#[tauri::command]
pub async fn db_pool_status() -> Result<PoolStatus, String> {
    Ok(PoolStatus {
        recent_failure: crate::api::recent_failure(),
        pool_ready: true,
        idle_released: false,
        idle_release_at_ms: None,
        idle_timeout_secs: 0,
        server_now_ms: unix_ms(),
    })
}

/// 服务端架构下不再暴露单机 MySQL 连接统计；改为返回云服务健康快照。
#[tauri::command]
pub async fn db_conn_stats() -> Result<serde_json::Value, String> {
    crate::api::health().await
}

/// 线路状态（旧 UI 兼容）：桌面端不再直连云库，固定为「直连云服务」。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStatus {
    pub mode: &'static str,
    pub effective: &'static str,
    pub since_ms: u64,
    pub server_now_ms: u64,
    pub relay_configured: bool,
    pub relay_available: Option<bool>,
    pub relay_latency_ms: Option<u64>,
    pub relay_cooling_down: bool,
    pub relay_max_conns: u64,
    pub last_reason: Option<String>,
}

fn line_status_stub() -> LineStatus {
    LineStatus {
        mode: "auto",
        effective: "direct",
        since_ms: 0,
        server_now_ms: unix_ms(),
        relay_configured: false,
        relay_available: None,
        relay_latency_ms: None,
        relay_cooling_down: false,
        relay_max_conns: 0,
        last_reason: None,
    }
}

#[tauri::command]
pub async fn db_line_status() -> LineStatus {
    line_status_stub()
}

#[tauri::command]
pub async fn db_line_set(mode: String) -> Result<LineStatus, String> {
    let _ = mode;
    Ok(line_status_stub())
}

#[tauri::command]
pub async fn db_line_probe() -> Result<LineStatus, String> {
    Ok(line_status_stub())
}

/// 退出登录：清除本地保存的云服务令牌。
#[tauri::command]
pub async fn db_logout() -> Result<ApiResponse, String> {
    crate::api::clear_token();
    Ok(ApiResponse::ok_msg("logged out"))
}

/// 当前是否存在有效的云服务登录令牌（启动时校验本地缓存的用户是否还能用）。
#[tauri::command]
pub async fn db_has_session() -> bool {
    crate::api::has_token() || offline_dev()
}

/// 供本地流程标记 API 健康状态（信号灯用）。
#[allow(dead_code)]
pub(crate) fn mark_api_failure() {
    crate::api::mark_failure();
}

#[allow(dead_code)]
pub(crate) fn mark_api_success() {
    crate::api::mark_success();
}

/// 带 ETag 的通用 RPC：前端只读缓存刷新时调用。
/// 返回 `{ not_modified, etag, result }`；`not_modified` 为真时 `result` 为空，
/// 前端直接复用本地缓存的 payload。
#[tauri::command(rename_all = "snake_case")]
pub async fn db_call_cached(
    command: String,
    args: serde_json::Value,
    etag: Option<String>,
) -> Result<serde_json::Value, String> {
    let out = crate::api::rpc_raw_etag(&command, args, etag).await?;
    Ok(serde_json::json!({
        "not_modified": out.not_modified,
        "etag": out.etag,
        "result": out.value,
    }))
}
