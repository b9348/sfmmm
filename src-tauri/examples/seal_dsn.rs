//! 生成 MySQL 连接串的编码形式，用于填入 `src-tauri/.env` 的
//! `DB_URL` / `DB_URL2`。密钥由 `DB_ENC_KEY` 派生。
//!
//! 在 `src-tauri` 目录下运行：
//! ```sh
//! cargo run --example seal_dsn -- "mysql://user:pass@host:port/db"
//! ```
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use sha2::{Digest, Sha256};

const SALT: &[u8] = b"sfmmm-dsn-seal-v1";

fn db_enc_key() -> String {
    if let Ok(v) = std::env::var("DB_ENC_KEY") {
        return v;
    }
    let env_path = format!("{}/.env", env!("CARGO_MANIFEST_DIR"));
    let content = std::fs::read_to_string(&env_path).expect("读取 src-tauri/.env 失败");
    for line in content.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("DB_ENC_KEY=") {
            return v.trim().to_string();
        }
    }
    panic!("未找到 DB_ENC_KEY：请设置环境变量或在 src-tauri/.env 中配置");
}

fn main() {
    let plain = std::env::args()
        .nth(1)
        .expect("用法: cargo run --example seal_dsn -- \"mysql://user:pass@host:port/db\"");

    let raw_key = db_enc_key();
    let key_bytes = hex::decode(raw_key.trim()).expect("DB_ENC_KEY 必须是十六进制");
    assert_eq!(key_bytes.len(), 32, "DB_ENC_KEY 必须为 32 字节");

    let mut hasher = Sha256::new();
    hasher.update(&key_bytes);
    hasher.update(SALT);
    let key = hasher.finalize();

    let cipher = Aes256Gcm::new_from_slice(&key).expect("密钥初始化失败");
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .expect("加密失败");

    let mut blob = Vec::with_capacity(12 + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    println!("dsn1:{}", B64.encode(&blob));
}
