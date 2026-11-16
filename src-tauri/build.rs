//! 构建脚本：从 `src-tauri/.env` 读取公开配置并通过 `cargo:rustc-env` 注入。
//!
//! hk 架构下桌面端不再持有任何数据库 / 图床凭据：
//! - 数据库、字段加密、Valkey 缓存全部在服务端；
//! - 新上传文件直传 hk 服务器；
//! - 这里只保留公开的旧图床域名（读取历史图片/安装包）与仓库地址（UA）。

fn main() {
    tauri_build::build();

    let env_path = std::path::Path::new(".env");
    println!("cargo:rerun-if-changed=.env");

    let mut vars: std::collections::HashMap<String, String> = std::collections::HashMap::new();
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

    // 全部为公开配置，直接注入（不含任何密钥/个人域名）
    for name in [
        "IMGBED_URL",
        "IMGBED_MIRROR_URL",
        "IMGBED_LINE3_URL",
        "GITHUB_REPO",
        "SFMMM_API_BASE",
    ] {
        if let Some(value) = vars.get(name) {
            println!("cargo:rustc-env={name}={value}");
        }
    }

    // 传输信封密钥（/api/user/rpc 双向加密）：与 server/.env 的 DESKTOP_XPORT_KEY 一致。
    // 与 admin 前端的传输密钥同属「随客户端分发」的传输层密钥，不是数据库密钥——
    // 桌面端依旧不持有 DB_ENC_KEY，也不直连数据库。
    if let Some(value) = vars.get("DESKTOP_XPORT_KEY") {
        println!("cargo:rustc-env=DESKTOP_XPORT_KEY={value}");
    }
}
