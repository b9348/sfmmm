//! 补录楼中楼被回复人的历史漏发通知（一次性，幂等）。
//!
//! 旧版通知逻辑只发层主与楼主，"回复楼中楼中的某条消息"时被 @ 的人未入库。
//! 本脚本解密评论内容中的 `@用户名 ` 前缀定位被回复人，按评论发送时间补录
//! 未读通知（从最新开始插入），已有同 (user_id, comment_id) 通知的跳过。
//!
//! 运行方式（在 src-tauri 目录下）：
//! ```sh
//! cargo run --example backfill_reply_notifications
//! ```
use app_lib::db::{backfill_reply_notifications, DbState};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 兜底：构建期未注入环境变量时，手动读取 src-tauri/.env（与 decrypt_rollback 同模式）
    let env_path = format!("{}/.env", env!("CARGO_MANIFEST_DIR"));
    if std::env::var("DB_URL").is_err() || std::env::var("DB_ENC_KEY").is_err() {
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                if let Some((k, v)) = line.split_once('=') {
                    let key = k.trim();
                    let val = v.trim().to_string();
                    if key == "DB_URL" && std::env::var("DB_URL").is_err() {
                        std::env::set_var("DB_URL", val);
                    } else if key == "DB_ENC_KEY" && std::env::var("DB_ENC_KEY").is_err() {
                        std::env::set_var("DB_ENC_KEY", val);
                    }
                }
            }
        }
    }

    let state = DbState::new()?;
    let summary = backfill_reply_notifications(&state).await?;
    println!("{summary}");
    Ok(())
}
