//! 字段级加密：写 MySQL 前加密、读回后解密，前端始终拿到明文（无感知）。
//!
//! 方案：AES-256-GCM（`aes-gcm` crate），密钥来自环境变量 `DB_ENC_KEY`（64 位十六进制 = 32 字节），
//! 与 `DB_URL` 同一注入机制（构建时经 tauri-build 从 `.env` 读取，运行时也可注入）。
//!
//! 密文格式：`enc1:` + base64( 12 字节 nonce || AES-GCM 密文+tag )
//! - [`encrypt_str`]：随机 nonce（每个值独立随机），用于只按主键读回的文本（评论、模组说明、理由等）
//! - [`encrypt_det`]：确定性加密（nonce = HMAC-SHA256(派生密钥, 明文) 前 12 字节，密钥化 PRF），
//!   同一明文 → 同一密文，用于需要 `WHERE col = ?` 等值查询的列（如 `users.username` 登录/唯一性校验）
//! - [`decrypt_str`]：带 `enc1:` 前缀才解密；解密失败或为迁移前遗留明文时原样返回
//! - [`is_encrypted`]：存量数据迁移时用于跳过已加密行

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use mysql::prelude::*;
use mysql::*;
use once_cell::sync::OnceCell;
use sha2::{Digest, Sha256};

use crate::db::{val_to_i64, val_to_string};

/// 密文前缀：迁移脚本据此识别已加密值
const PREFIX: &str = "enc1:";

fn key_bytes() -> &'static [u8; 32] {
    static KEY: OnceCell<[u8; 32]> = OnceCell::new();
    KEY.get_or_init(|| {
        let raw = option_env!("DB_ENC_KEY")
            .map(|s| s.to_string())
            .or_else(|| std::env::var("DB_ENC_KEY").ok())
            .expect("DB_ENC_KEY 未设置：请在 src-tauri/.env 配置 64 位十六进制密钥（openssl rand -hex 32 生成），然后重新构建");
        let bytes = hex::decode(raw.trim()).expect("DB_ENC_KEY 必须是合法的十六进制字符串");
        assert_eq!(bytes.len(), 32, "DB_ENC_KEY 必须为 32 字节（64 位十六进制）");
        let mut k = [0u8; 32];
        k.copy_from_slice(&bytes);
        k
    })
}

fn cipher() -> &'static Aes256Gcm {
    static CIPHER: OnceCell<Aes256Gcm> = OnceCell::new();
    CIPHER.get_or_init(|| {
        Aes256Gcm::new_from_slice(key_bytes()).expect("AES-256-GCM 密钥初始化失败")
    })
}

fn seal(plain: &[u8], nonce: &[u8]) -> Result<String, String> {
    let ct = cipher()
        .encrypt(Nonce::from_slice(nonce), plain)
        .map_err(|e| format!("加密失败: {e}"))?;
    let mut blob = Vec::with_capacity(12 + ct.len());
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(&ct);
    Ok(format!("{PREFIX}{}", B64.encode(&blob)))
}

/// 随机 nonce 加密（推荐用于一般用户文本：评论、模组说明、理由等）
pub fn encrypt_str(s: &str) -> Result<String, String> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    seal(s.as_bytes(), &nonce)
}

/// 确定性加密：nonce 由密钥化 PRF（HMAC-SHA256，nonce 密钥从主密钥派生）生成，
/// 避免无密钥哈希的 96 位前缀碰撞导致 AES-GCM nonce 复用；同一明文得到同一密文（支持等值查询）
pub fn encrypt_det(s: &str) -> Result<String, String> {
    let mut mac = det_nonce_hmac();
    mac.update(s.as_bytes());
    let h = mac.finalize().into_bytes();
    seal(s.as_bytes(), &h[..12])
}

/// 确定性加密专用 nonce 密钥：由主密钥派生（与数据加密密钥隔离，密钥化 PRF）
fn det_nonce_hmac() -> Hmac<Sha256> {
    let mut salt = Vec::with_capacity(key_bytes().len() + 20);
    salt.extend_from_slice(key_bytes());
    salt.extend_from_slice(b"enc1-det-nonce-v1");
    let derived = Sha256::digest(&salt);
    <Hmac<Sha256> as Mac>::new_from_slice(&derived).expect("HMAC 密钥初始化失败")
}

/// 解密：带 `enc1:` 前缀才解密；解密失败或为迁移前遗留明文时原样返回
pub fn decrypt_str(s: &str) -> String {
    let Some(b64) = s.strip_prefix(PREFIX) else {
        return s.to_string();
    };
    let Ok(blob) = B64.decode(b64) else {
        return s.to_string();
    };
    if blob.len() <= 12 {
        return s.to_string();
    }
    let (nonce, ct) = blob.split_at(12);
    match cipher().decrypt(Nonce::from_slice(nonce), ct) {
        Ok(pt) => String::from_utf8_lossy(&pt).to_string(),
        Err(_) => s.to_string(),
    }
}

/// 是否为已加密值（存量数据迁移时跳过已加密行）
pub fn is_encrypted(s: &str) -> bool {
    s.starts_with(PREFIX)
}

/// 存量数据加密迁移（幂等）：把迁移前遗留的明文字段加密为 `enc1:...` 格式。
/// 已加密（`enc1:` 前缀）或空值/NULL 跳过，可重复执行。返回实际加密的行数。
/// 由 `cargo run --example migrate_encrypt` 触发执行（新版本发布前运行一次）。
pub async fn migrate_legacy_encrypt(state: &crate::db::DbState) -> Result<usize, String> {
    crate::db::with_conn(state, move |conn| {
        let mut total: usize = 0;

        // 扩列容纳密文：密文长度 = 5 + ⌈(28 + 明文字节数)/3⌉×4 ≈ 42 + 1.34×n（n 为明文 UTF-8 字节数）。
        // 目标宽度按"旧列上限字符数 × 4 字节/字符 + 28 + base64 膨胀"的保守值选取
        macro_rules! ensure_width {
            ($table:expr, $col:expr, $target:expr, $comment:expr) => {{
                let cur: Option<(Option<i64>,)> = conn
                    .exec_first(
                        &format!(
                            "SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
                             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{0}' AND COLUMN_NAME = '{1}'",
                            $table, $col
                        ),
                        (),
                    )
                    .map_err(|e| e.to_string())?;
                if matches!(cur, Some((Some(l),)) if l < $target) {
                    conn.exec_drop(
                        &format!(
                            "ALTER TABLE `{0}` MODIFY `{1}` varchar({2}) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '{3}'",
                            $table, $col, $target, $comment
                        ),
                        (),
                    )
                    .map_err(|e| e.to_string())?;
                }
            }};
        }
        ensure_width!("users", "username", 255, "用户名，字母数字");
        ensure_width!("mods", "mod_id", 400, "Mod唯一标识符");
        ensure_width!("mod_translations", "name", 1500, "Mod名称");
        ensure_width!("mod_files", "file_name", 1200, "文件名");

        // users.username 双列迁移：username 存原样密文（显示保真），
        // username_key 存小写密文（登录/查重用，允许任意大小写登录；唯一索引兜底）
        {
            let has_col: Option<(i64,)> = conn
                .exec_first(
                    "SELECT COUNT(*) FROM information_schema.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username_key'",
                    (),
                )
                .map_err(|e| e.to_string())?;
            if matches!(has_col, Some((0,))) {
                conn.exec_drop(
                    "ALTER TABLE users ADD COLUMN username_key varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL COMMENT '登录查找键(小写密文)'",
                    (),
                )
                .map_err(|e| e.to_string())?;
            }
            let has_idx: Option<(i64,)> = conn
                .exec_first(
                    "SELECT COUNT(*) FROM information_schema.STATISTICS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uk_username_key'",
                    (),
                )
                .map_err(|e| e.to_string())?;
            if matches!(has_idx, Some((0,))) {
                conn.exec_drop("ALTER TABLE users ADD UNIQUE KEY uk_username_key (username_key)", ())
                    .map_err(|e| e.to_string())?;
            }
            let mut rows: Vec<(u64, String)> = Vec::new();
            conn.exec_map("SELECT id, username FROM users", (), |row: Row| {
                let r: Vec<Value> = row.unwrap();
                rows.push((val_to_i64(&r[0]) as u64, val_to_string(r[1].clone())));
            })
            .map_err(|e| e.to_string())?;
            for (id, v) in rows {
                if v.is_empty() || is_encrypted(&v) {
                    continue;
                }
                conn.exec_drop(
                    "UPDATE users SET username = ?, username_key = ? WHERE id = ?",
                    (encrypt_det(&v)?, encrypt_det(&v.to_lowercase())?, id),
                )
                .map_err(|e| e.to_string())?;
                total += 1;
            }
        }

        macro_rules! migrate_col {
            ($table:expr, $col:expr, $enc:expr) => {{
                let sql = format!("SELECT id, {} FROM {}", $col, $table);
                let mut rows: Vec<(u64, String)> = Vec::new();
                conn.exec_map(&sql, (), |row: Row| {
                    let r: Vec<Value> = row.unwrap();
                    rows.push((val_to_i64(&r[0]) as u64, val_to_string(r[1].clone())));
                })
                .map_err(|e| e.to_string())?;
                for (id, v) in rows {
                    if v.is_empty() || is_encrypted(&v) {
                        continue;
                    }
                    let enc = $enc(&v).map_err(|e| e.to_string())?;
                    conn.exec_drop(
                        &format!("UPDATE {} SET {} = ? WHERE id = ?", $table, $col),
                        (enc, id),
                    )
                    .map_err(|e| e.to_string())?;
                    total += 1;
                }
            }};
        }
        migrate_col!("mods", "mod_id", encrypt_det);
        migrate_col!("mod_comments", "content", encrypt_str);
        migrate_col!("mod_translations", "name", encrypt_str);
        migrate_col!("mod_translations", "description", encrypt_str);
        migrate_col!("mod_translations", "instructions", encrypt_str);
        migrate_col!("mod_translations", "changelog", encrypt_str);
        migrate_col!("mod_files", "file_name", encrypt_str);
        migrate_col!("mod_files", "manifest", encrypt_str);
        migrate_col!("edit_applications", "reason", encrypt_str);
        Ok(total)
    })
    .await
}

/// 回滚存量加密（幂等）：把 `enc1:...` 密文解密回明文。
/// 非 `enc1:` 前缀的值跳过，可重复执行。返回实际解密的行数。
/// users.username 有大小写不敏感的唯一索引，解密后与其他行冲突的将跳过并报告。
/// 由 `cargo run --example decrypt_rollback` 触发执行（发版前回滚用）。
pub async fn decrypt_legacy_encryption(state: &crate::db::DbState) -> Result<usize, String> {
    crate::db::with_conn(state, move |conn| {
        let mut total: usize = 0;
        let mut conflicts: Vec<(u64, String)> = Vec::new();

        // users.username：唯一索引 utf8mb4_unicode_ci（大小写不敏感、忽略尾部空格）。
        // 加密窗口期内旧客户端可能注册了与原名大小写变体重名的账号，解密前需查重。
        {
            let mut rows: Vec<(u64, String)> = Vec::new();
            conn.exec_map("SELECT id, username FROM users", (), |row: Row| {
                let r: Vec<Value> = row.unwrap();
                rows.push((val_to_i64(&r[0]) as u64, val_to_string(r[1].clone())));
            })
            .map_err(|e| e.to_string())?;
            for (id, v) in rows {
                if !is_encrypted(&v) {
                    continue;
                }
                let plain = decrypt_str(&v);
                let clash: Option<(u64,)> = conn
                    .exec_first(
                        "SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ? LIMIT 1",
                        (&plain, id),
                    )
                    .map_err(|e| e.to_string())?;
                if clash.is_some() {
                    conflicts.push((id, plain));
                    continue;
                }
                conn.exec_drop("UPDATE users SET username = ? WHERE id = ?", (plain, id))
                    .map_err(|e| e.to_string())?;
                total += 1;
            }
        }

        // 还原后移除 username_key 查找列（恢复迁移前 schema；幂等：列不存在则跳过）
        let has_key_col: Option<(i64,)> = conn
            .exec_first(
                "SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username_key'",
                (),
            )
            .map_err(|e| e.to_string())?;
        if matches!(has_key_col, Some((1,))) {
            conn.exec_drop("ALTER TABLE users DROP COLUMN username_key", ())
                .map_err(|e| e.to_string())?;
        }

        // mods.mod_id：唯一索引 utf8mb4_unicode_ci（大小写不敏感），回滚时同样查重
        {
            let mut rows: Vec<(u64, String)> = Vec::new();
            conn.exec_map("SELECT id, mod_id FROM mods", (), |row: Row| {
                let r: Vec<Value> = row.unwrap();
                rows.push((val_to_i64(&r[0]) as u64, val_to_string(r[1].clone())));
            })
            .map_err(|e| e.to_string())?;
            for (id, v) in rows {
                if !is_encrypted(&v) {
                    continue;
                }
                let plain = decrypt_str(&v);
                let clash: Option<(u64,)> = conn
                    .exec_first(
                        "SELECT id FROM mods WHERE LOWER(mod_id) = LOWER(?) AND id != ? LIMIT 1",
                        (&plain, id),
                    )
                    .map_err(|e| e.to_string())?;
                if clash.is_some() {
                    conflicts.push((id, plain));
                    continue;
                }
                conn.exec_drop("UPDATE mods SET mod_id = ? WHERE id = ?", (plain, id))
                    .map_err(|e| e.to_string())?;
                total += 1;
            }
        }

        // 其余列无唯一索引冲突，直接解密
        macro_rules! decrypt_col {
            ($table:expr, $col:expr) => {{
                let sql = format!("SELECT id, {} FROM {}", $col, $table);
                let mut rows: Vec<(u64, String)> = Vec::new();
                conn.exec_map(&sql, (), |row: Row| {
                    let r: Vec<Value> = row.unwrap();
                    rows.push((val_to_i64(&r[0]) as u64, val_to_string(r[1].clone())));
                })
                .map_err(|e| e.to_string())?;
                for (id, v) in rows {
                    if !is_encrypted(&v) {
                        continue;
                    }
                    let plain = decrypt_str(&v);
                    conn.exec_drop(
                        &format!("UPDATE {} SET {} = ? WHERE id = ?", $table, $col),
                        (plain, id),
                    )
                    .map_err(|e| e.to_string())?;
                    total += 1;
                }
            }};
        }
        decrypt_col!("mod_comments", "content");
        decrypt_col!("mod_translations", "name");
        decrypt_col!("mod_translations", "description");
        decrypt_col!("mod_translations", "instructions");
        decrypt_col!("mod_translations", "changelog");
        decrypt_col!("mod_files", "file_name");
        decrypt_col!("mod_files", "manifest");
        decrypt_col!("edit_applications", "reason");

        if !conflicts.is_empty() {
            eprintln!(
                "[冲突] {} 个用户名解密后与现有行重名（大小写不敏感），已跳过、仍为密文：",
                conflicts.len()
            );
            for (id, name) in &conflicts {
                eprintln!("  [冲突] users.id={id} 原用户名解密为 {name:?}");
            }
        }
        Ok(total)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_KEY: &str =
        "d074166ef15714149428815d92b7715c91a0b514bc351565c54f89a9f1705e32";

    fn ensure_key() {
        // 构建期未注入密钥时，测试内设置运行时密钥（幂等）
        std::env::set_var("DB_ENC_KEY", TEST_KEY);
    }

    #[test]
    fn roundtrip_random_nonce() {
        ensure_key();
        let s = "这是一条测试评论 @某某 #tag\n第二行";
        let enc = encrypt_str(s).unwrap();
        assert!(is_encrypted(&enc));
        assert_eq!(decrypt_str(&enc), s);
        // 随机 nonce：同一明文两次加密结果不同
        assert_ne!(enc, encrypt_str(s).unwrap());
    }

    #[test]
    fn roundtrip_deterministic() {
        ensure_key();
        let s = "用户名ABC_123";
        let a = encrypt_det(s).unwrap();
        let b = encrypt_det(s).unwrap();
        assert_eq!(a, b); // 确定性：同一明文 → 同一密文（支持等值查询）
        assert_eq!(decrypt_str(&a), s);
    }

    #[test]
    fn legacy_plaintext_passthrough() {
        // 迁移前的遗留明文/空值：解密时原样返回，不报错
        assert_eq!(decrypt_str("遗留明文"), "遗留明文");
        assert_eq!(decrypt_str(""), "");
        assert!(!is_encrypted("明文"));
        assert!(!is_encrypted(""));
    }

    #[test]
    fn det_keyed_nonce_case_variants_differ() {
        ensure_key();
        // 原样加密：大小写变体得到不同密文（显示保真）；nonce 密钥化后无哈希前缀碰撞隐患
        let a = encrypt_det("Kichi Azusa").unwrap();
        let b = encrypt_det("kichi azusa").unwrap();
        assert_ne!(a, b);
        assert_eq!(decrypt_str(&a), "Kichi Azusa");
        assert_eq!(decrypt_str(&b), "kichi azusa");
    }

    #[test]
    fn corrupted_ciphertext_fails_gracefully() {
        // 损坏密文：原样返回，不 panic
        let enc = "enc1:AAAA";
        assert_eq!(decrypt_str(enc), enc);
        let enc2 = "enc1:!!!not-base64!!!";
        assert_eq!(decrypt_str(enc2), enc2);
    }
}
