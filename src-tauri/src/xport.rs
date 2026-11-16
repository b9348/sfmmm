//! 传输信封加解密（`/api/user/rpc` 双向，与服务端 `server/src/admin/xport.rs` 桌面域对应）。
//!
//! - 密钥 `DESKTOP_XPORT_KEY`（64 位十六进制）由 `build.rs` 从 `src-tauri/.env`
//!   经 `cargo:rustc-env` 注入；未注入时全部直通（明文请求，服务端也不加密响应）。
//! - 信封：`{"__enc":"a1v1","k":"k1","n":"<b64 12字节nonce>","p":"<b64 密文+tag>"}`
//!   整个请求/响应 JSON body 作为一条消息；AAD 域分隔串 `sfmmm-desktop-xport-v1`
//!   （与管理后台域、`enc1:` 字段加密互不相通）。
//! - 请求封装即「新版客户端」能力标记：服务端据此决定是否加密响应，
//!   旧版客户端（无密钥）永远收到明文。

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::OnceCell;
use serde_json::{json, Value};

const AAD: &[u8] = b"sfmmm-desktop-xport-v1";
const KEY_ID: &str = "k1";
pub const ENVELOPE_TAG: &str = "__enc";
pub const ENVELOPE_VER: &str = "a1v1";

/// 编译期注入的密钥（64 位十六进制）；未注入为 None。
fn key_hex() -> Option<&'static str> {
    static KEY: OnceCell<Option<&'static str>> = OnceCell::new();
    let stored: &'static Option<&'static str> = KEY.get_or_init(|| {
        // option_env! 只接受字面量；ENV_NAME 仅作文档说明用途
        let raw = option_env!("DESKTOP_XPORT_KEY").unwrap_or("").trim();
        if raw.is_empty() {
            None
        } else {
            Some(raw)
        }
    });
    *stored
}

fn cipher() -> Option<&'static Aes256Gcm> {
    static CIPHER: OnceCell<Option<Aes256Gcm>> = OnceCell::new();
    CIPHER
        .get_or_init(|| {
            let raw = key_hex()?;
            let bytes = match hex::decode(raw) {
                Ok(b) => b,
                Err(_) => {
                    log::warn!("[xport] DESKTOP_XPORT_KEY 不是合法十六进制，传输加密已禁用");
                    return None;
                }
            };
            if bytes.len() != 32 {
                log::warn!("[xport] DESKTOP_XPORT_KEY 必须为 32 字节，传输加密已禁用");
                return None;
            }
            Some(Aes256Gcm::new_from_slice(&bytes).expect("AES-256-GCM 密钥初始化失败"))
        })
        .as_ref()
}

/// 传输加密是否可用（决定请求是否封装；未配置时全程明文）。
pub fn enabled() -> bool {
    cipher().is_some()
}

fn is_envelope(v: &Value) -> bool {
    v.get(ENVELOPE_TAG).and_then(|s| s.as_str()) == Some(ENVELOPE_VER)
}

/// 封装 RPC 请求体；密钥不可用时返回 None（调用方直接发明文）。
pub fn seal_args(args: &Value) -> Option<Value> {
    let c = cipher()?;
    let plain = serde_json::to_vec(args).ok()?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = c
        .encrypt(&nonce, Payload { msg: &plain, aad: AAD })
        .expect("AES-GCM 加密不会失败（密钥长度已在构造时校验）");
    Some(json!({
        ENVELOPE_TAG: ENVELOPE_VER,
        "k": KEY_ID,
        "n": B64.encode(nonce),
        "p": B64.encode(ct),
    }))
}

/// 解开 RPC 响应信封；不是信封时原样返回（旧服务端 / 未配置密钥的服务端）。
pub fn unwrap_response(value: Value) -> Result<Value, String> {
    if !is_envelope(&value) {
        return Ok(value);
    }
    let c = cipher().ok_or_else(|| "收到信封响应但本端未配置传输密钥".to_string())?;
    let n = value
        .get("n")
        .and_then(|v| v.as_str())
        .and_then(|s| B64.decode(s).ok())
        .ok_or_else(|| "信封 nonce 缺失或非法".to_string())?;
    if n.len() != 12 {
        return Err("信封 nonce 长度异常".to_string());
    }
    let p = value
        .get("p")
        .and_then(|v| v.as_str())
        .and_then(|s| B64.decode(s).ok())
        .ok_or_else(|| "信封密文缺失或非法".to_string())?;
    let plain = c
        .decrypt(Nonce::from_slice(&n), Payload { msg: &p, aad: AAD })
        .map_err(|_| "信封解密失败（密钥不匹配或数据被篡改）".to_string())?;
    serde_json::from_slice(&plain).map_err(|e| format!("信封明文不是合法 JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用：以固定密钥构造与生产相同的信封流程。
    fn seal_with(hex_key: &str, plain: &Value) -> Value {
        let bytes = hex::decode(hex_key).unwrap();
        let c = Aes256Gcm::new_from_slice(&bytes).unwrap();
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ct = c
            .encrypt(
                &nonce,
                Payload {
                    msg: serde_json::to_vec(plain).unwrap().as_slice(),
                    aad: AAD,
                },
            )
            .unwrap();
        json!({ ENVELOPE_TAG: ENVELOPE_VER, "k": KEY_ID, "n": B64.encode(nonce), "p": B64.encode(ct) })
    }

    #[test]
    fn envelope_shape_and_version() {
        // 生产构造路径：密钥存在时 seal_args 必产信封
        if enabled() {
            let sealed = seal_args(&json!({ "ping": 1 })).unwrap();
            assert_eq!(sealed[ENVELOPE_TAG], ENVELOPE_VER);
            assert_eq!(sealed["k"], KEY_ID);
        }
    }

    #[test]
    fn unwrap_rejects_wrong_key() {
        // 用「错钥」密文构造信封：unwrap_response 应报错而不是 panic
        let env = seal_with(&"3".repeat(64), &json!({ "success": true }));
        // 本端密钥（若配置）与错钥不同 → 解密失败；未配置 → 报未配置
        assert!(unwrap_response(env).is_err());
    }

    #[test]
    fn non_envelope_passthrough() {
        let v = json!({ "success": true, "data": { "a": 1 } });
        let out = unwrap_response(v.clone()).unwrap();
        assert_eq!(out, v);
    }
}
