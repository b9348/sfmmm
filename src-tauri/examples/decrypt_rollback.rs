//! 回滚存量加密（一次性，幂等）：把 `enc1:...` 密文解密回明文。
//!
//! 与正向迁移共用同一套 crypto 实现（格式严格一致），非 `enc1:` 前缀的值跳过。
//! 适用于发版前回滚：程序尚未发版、避免影响仍在用旧版本的线上用户时执行。
//!
//! 运行方式（在 src-tauri 目录下）：
//! ```sh
//! cargo run --example decrypt_rollback
//! ```
use app_lib::db::{crypto::decrypt_legacy_encryption, DbState};

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
    let n = decrypt_legacy_encryption(&state).await?;
    println!("存量加密回滚完成，共解密 {n} 行");
    Ok(())
}
