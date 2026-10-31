//! 配置值解码：读取构建期写入的 `sec1:`（图床）/ `dsn1:`（数据库）值并还原。
//!
//! 密钥由 `DB_ENC_KEY` 经 SHA-256 派生（域分离标签 `sfmmm-dsn-seal-v1`）；
//! 更换 `DB_ENC_KEY` 后重新构建即可。
//!
//! 格式：`<prefix>` + base64( 12 字节 nonce || AES-GCM 密文+tag )

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use sha2::{Digest, Sha256};

/// 支持的前缀；两种都接受，便于旧值兼容。
const PREFIXES: [&str; 2] = ["sec1:", "dsn1:"];
const SALT: &[u8] = b"sfmmm-dsn-seal-v1";

fn seal_key() -> [u8; 32] {
    let master = zeroize::Zeroizing::new(super::master_key::load());

    let mut hasher = Sha256::new();
    hasher.update(&master[..]);
    hasher.update(SALT);
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// 解码构建期注入的配置；无前缀的值视为明文（便于本地调试）原样返回。
pub fn reveal(stored: &str) -> String {
    let Some(b64) = PREFIXES
        .iter()
        .find_map(|p| stored.strip_prefix(p))
    else {
        return stored.to_string();
    };
    let blob = B64
        .decode(b64)
        .expect("敏感配置密文损坏：请重新构建");
    assert!(
        blob.len() > 12,
        "敏感配置密文长度非法：请重新构建"
    );

    let (nonce, ciphertext) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(&seal_key()).expect("AES-256-GCM 密钥初始化失败");
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .expect("敏感配置解密失败：构建时 DB_ENC_KEY 与数据不匹配");

    String::from_utf8(plain).expect("敏感配置不是合法 UTF-8")
}

#[cfg(test)]
mod tests {
    /// 构建期注入的敏感配置必须是编码值，且能还原为原值形态。
    /// 干净克隆没有 `src-tauri/.env` 时没有任何注入值，此时跳过而不是 panic。
    #[test]
    fn build_time_secrets_are_sealed() {
        let mut checked = 0;
        for (name, raw) in [
            ("DB_URL", option_env!("DB_URL")),
            ("DB_URL2", option_env!("DB_URL2")),
            ("IMGBED_URL", option_env!("IMGBED_URL")),
            ("IMGBED_TOKEN", option_env!("IMGBED_TOKEN")),
        ] {
            let Some(raw) = raw else { continue };
            checked += 1;
            assert!(
                super::PREFIXES.iter().any(|p| raw.starts_with(p)),
                "{name} 必须使用编码值"
            );
            assert!(!super::reveal(raw).is_empty(), "{name} 解密结果为空");
        }

        if let Some(db) = option_env!("DB_URL") {
            let db = super::reveal(db);
            assert!(db.starts_with("mysql://") && db.contains('@'));
        }

        if let Some(img) = option_env!("IMGBED_URL") {
            let img = super::reveal(img);
            assert!(img.starts_with("http://") || img.starts_with("https://"));
        }

        if checked == 0 {
            eprintln!("跳过：构建期未注入任何敏感配置（缺少 src-tauri/.env）");
        }
    }
}
