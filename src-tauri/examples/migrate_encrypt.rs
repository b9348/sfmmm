//! 存量数据加密迁移（一次性，幂等）。
//!
//! 把数据库中迁移前遗留的明文字段加密为 `enc1:...` 格式，
//! 与 Rust 端 db_* 命令的读写逻辑共用同一套 crypto 实现（格式严格一致）。
//! 已加密的行自动跳过，可重复执行。
//!
//! 运行方式（在 src-tauri 目录下）：
//! ```sh
//! cargo run --example migrate_encrypt
//! ```
//! 密钥与连接串来自 src-tauri/.env（构建期未注入时脚本会兜底读取）。
use app_lib::db::{crypto::migrate_legacy_encrypt, DbState};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 兜底：构建期未注入环境变量时，手动读取 src-tauri/.env（不引入额外依赖）
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
    let n = migrate_legacy_encrypt(&state).await?;
    println!("存量加密迁移完成，共加密 {n} 行");
    Ok(())
}
