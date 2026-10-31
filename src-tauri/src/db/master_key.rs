//! 主密钥 `DB_ENC_KEY` 的运行时载入。
//!
//! 优先使用构建期注入的值，缺失时回退到环境变量（本地调试/示例）。
//! 中间缓冲用 zeroize 清理。

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const MASK_SALT: &[u8] = b"sfmmm-key-mask-v1";

/// 构建期是否注入了密钥。测试据此决定是否回退到环境变量。
#[cfg(test)]
pub(crate) fn injected() -> bool {
    option_env!("DB_ENC_KEY_OBF").is_some() && option_env!("DB_ENC_KEY_SEED").is_some()
}

/// 载入 32 字节主密钥：优先构建期注入，其次运行期环境变量（本地调试/示例）。
pub(crate) fn load() -> [u8; 32] {
    if let Some(key) = from_injected() {
        return key;
    }

    let raw = std::env::var("DB_ENC_KEY")
        .expect("DB_ENC_KEY 未设置：请在 src-tauri/.env 配置 64 位十六进制密钥，然后重新构建");
    let bytes =
        Zeroizing::new(hex::decode(raw.trim()).expect("DB_ENC_KEY 必须是合法的十六进制字符串"));
    assert_eq!(
        bytes.len(),
        32,
        "DB_ENC_KEY 必须为 32 字节（64 位十六进制）"
    );
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    key
}

fn from_injected() -> Option<[u8; 32]> {
    let seed_hex = option_env!("DB_ENC_KEY_SEED")?;
    let obf_hex = option_env!("DB_ENC_KEY_OBF")?;

    let seed = Zeroizing::new(
        hex::decode(seed_hex.trim()).expect("构建期注入的密钥 seed 损坏，请重新构建"),
    );
    let obf =
        Zeroizing::new(hex::decode(obf_hex.trim()).expect("构建期注入的密钥数据损坏，请重新构建"));
    assert!(!seed.is_empty(), "构建期注入的密钥 seed 为空，请重新构建");
    assert_eq!(obf.len(), 32, "构建期注入的密钥长度非法，请重新构建");

    let mut hasher = Sha256::new();
    hasher.update(&seed[..]);
    hasher.update(MASK_SALT);
    let digest = hasher.finalize();
    let mut mask = Zeroizing::new([0u8; 32]);
    mask.copy_from_slice(&digest);

    let mut key = [0u8; 32];
    for i in 0..32 {
        key[i] = obf[i] ^ mask[i];
    }
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 载入结果必须与构建期记录的哈希一致，防止派生逻辑日后漂移。
    #[test]
    fn injected_key_matches_build_hash() {
        let Some(expected) = option_env!("DB_ENC_KEY_SHA256") else {
            return;
        };
        let key = from_injected().expect("已注入密钥哈希但缺少密钥数据");
        assert_eq!(hex::encode(Sha256::digest(key)), expected);
    }
}
