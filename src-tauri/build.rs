//! 构建脚本：从 `src-tauri/.env` 读取配置并通过 `cargo:rustc-env` 注入。
//!
//! 读取 `DB_URL` / `DB_URL2` / `IMGBED_URL` / `IMGBED_TOKEN` / `DB_ENC_KEY` /
//! `DB_TLS1` / `DB_TLS2`；缺少 `.env` 时不注入额外配置。

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const SALT: &[u8] = b"sfmmm-dsn-seal-v1";
const MASK_SALT: &[u8] = b"sfmmm-key-mask-v1";

fn main() {
    tauri_build::build();

    let env_path = std::path::Path::new(".env");
    println!("cargo:rerun-if-changed=.env");
    println!("cargo:rerun-if-env-changed=DB_ENC_KEY");

    let mut vars: HashMap<String, String> = HashMap::new();
    if let Ok(content) = std::fs::read_to_string(env_path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                vars.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }

    // 数据库连接与图床配置
    let enc_key = std::env::var("DB_ENC_KEY")
        .ok()
        .or_else(|| vars.get("DB_ENC_KEY").cloned());
    for (name, prefix) in [
        ("DB_URL", "dsn1:"),
        ("DB_URL2", "dsn1:"),
        ("IMGBED_URL", "sec1:"),
        ("IMGBED_TOKEN", "sec1:"),
    ] {
        if let Some(value) = vars.get(name) {
            let injected = if value.starts_with("dsn1:") || value.starts_with("sec1:") {
                value.clone()
            } else {
                let key = enc_key.as_deref().unwrap_or_else(|| {
                    panic!("{name} 需要同时配置 DB_ENC_KEY")
                });
                seal(value, key, prefix)
            };
            println!("cargo:rustc-env={name}={injected}");
        }
    }

    // 主密钥
    if let Some(raw) = enc_key.as_deref() {
        emit_obfuscated_key(raw);
    }

    // 其余配置直接透传
    for name in ["DB_TLS1", "DB_TLS2"] {
        if let Some(value) = vars.get(name) {
            println!("cargo:rustc-env={name}={value}");
        }
    }
}

/// 处理 64 位十六进制主密钥后注入。
fn emit_obfuscated_key(key_hex: &str) {
    let key = decode_key(key_hex);

    // 每次构建使用不同的随机种子
    let nonce1 = Aes256Gcm::generate_nonce(&mut OsRng);
    let nonce2 = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut seed_hasher = Sha256::new();
    seed_hasher.update(nonce1);
    seed_hasher.update(nonce2);
    let seed = seed_hasher.finalize();

    let mut mask_hasher = Sha256::new();
    mask_hasher.update(seed);
    mask_hasher.update(MASK_SALT);
    let mask = mask_hasher.finalize();

    let obf: Vec<u8> = key
        .iter()
        .zip(mask.iter())
        .map(|(k, m)| k ^ m)
        .collect();

    println!("cargo:rustc-env=DB_ENC_KEY_SEED={}", hex::encode(seed));
    println!("cargo:rustc-env=DB_ENC_KEY_OBF={}", hex::encode(&obf));
    // 运行时自检用
    println!(
        "cargo:rustc-env=DB_ENC_KEY_SHA256={}",
        hex::encode(Sha256::digest(&key))
    );
}

fn decode_key(key_hex: &str) -> [u8; 32] {
    let bytes = hex::decode(key_hex.trim()).expect("DB_ENC_KEY 必须是十六进制");
    assert_eq!(bytes.len(), 32, "DB_ENC_KEY 必须为 32 字节（64 位十六进制）");
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    key
}

fn seal(plain: &str, key_hex: &str, prefix: &str) -> String {
    let key_bytes = decode_key(key_hex);

    let mut hasher = Sha256::new();
    hasher.update(key_bytes);
    hasher.update(SALT);
    let key = hasher.finalize();

    let cipher = Aes256Gcm::new_from_slice(&key).expect("AES-256-GCM 密钥初始化失败");
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
        .expect("敏感配置封装失败");

    let mut blob = Vec::with_capacity(12 + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    format!("{prefix}{}", B64.encode(&blob))
}
