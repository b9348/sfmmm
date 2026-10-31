//! 更新云端 `version_config`（本地发版脚本 `pnpm release` 调用，替代 CI 里的
//! `mysql` 直连步骤）。连接串取自 `src-tauri/.env`，支持明文与编码值。
//!
//! 在 `src-tauri` 目录下运行：
//! ```sh
//! cargo run --release --example set_version_config -- 0.2.32 "https://.../sfmmm_0.2.32_x64-setup.exe"
//! ```
//!
//! 默认用线路 1（`DB_URL` / `DB_TLS1`），可加 `--line 2` 改用线路 2。

use mysql::prelude::*;
use mysql::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts};

fn env_file_value(key: &str) -> Option<String> {
    let path = format!("{}/.env", env!("CARGO_MANIFEST_DIR"));
    let content = std::fs::read_to_string(path).ok()?;
    content.lines().find_map(|line| {
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (k, v) = line.split_once('=')?;
        (k.trim() == key).then(|| v.trim().trim_matches('"').to_string())
    })
}

/// 环境变量优先（便于 CI/脚本覆盖），否则回落到 `src-tauri/.env`
fn cfg(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| env_file_value(key))
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut line = 1u8;
    let mut check = false;
    let mut version = None;
    let mut update_url = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--line" => line = args.next().and_then(|v| v.parse().ok()).unwrap_or(1),
            "--check" => check = true,
            _ if version.is_none() => version = Some(arg),
            _ => update_url = Some(arg),
        }
    }
    if check {
        version = Some(String::new());
        update_url = Some(String::new());
    }
    let version = version.expect("用法: set_version_config -- [--line 1|2] [--check] <version> <update_url>");
    let update_url = update_url.unwrap_or_default();

    // reveal() 优先用编译期注入的 DB_ENC_KEY，缺失时回落到环境变量
    if std::env::var("DB_ENC_KEY").is_err() {
        if let Some(key) = env_file_value("DB_ENC_KEY") {
            std::env::set_var("DB_ENC_KEY", key);
        }
    }

    let (url_key, tls_key) = if line == 2 {
        ("DB_URL2", "DB_TLS2")
    } else {
        ("DB_URL", "DB_TLS1")
    };
    let raw = cfg(url_key).unwrap_or_else(|| panic!("未配置 {url_key}：请检查 src-tauri/.env"));
    let dsn = app_lib::db::secret::reveal(&raw);

    let opts = Opts::from_url(&dsn).unwrap_or_else(|e| panic!("解析 {url_key} 失败: {e}"));
    let forced_tls = match cfg(tls_key).as_deref().map(str::trim) {
        Some("1") | Some("true") | Some("TRUE") => true,
        Some("0") | Some("false") | Some("FALSE") => false,
        _ => line == 2,
    };
    let opts = if forced_tls {
        OptsBuilder::from_opts(opts).ssl_opts(Some(SslOpts::default()))
    } else {
        OptsBuilder::from_opts(opts)
    };

    // 默认池约束是 min=10/max=100，而 Pool::new 会立刻预开 min 条连接；这里只需要一条。
    // 账号的 max_user_connections 按小时累计（30），留着默认值的话一次发版就烧掉三分之一额度。
    let opts = opts.pool_opts(PoolOpts::default().with_constraints(
        PoolConstraints::new(1, 1).expect("min <= max"),
    ));

    let pool = Pool::new(opts).expect("创建数据库连接池失败");
    let mut conn = pool.get_conn().expect("连接数据库失败");

    if check {
        let row: Option<(String, String)> = conn
            .query_first("SELECT version, update_url FROM version_config ORDER BY id DESC LIMIT 1")
            .expect("读取 version_config 失败");
        match row {
            Some((v, u)) => println!("version_config（线路{line}）: v{v} — {u}"),
            None => println!("version_config（线路{line}）: 空表"),
        }
        return;
    }

    conn.exec_drop(
        "INSERT INTO version_config (id, version, update_url) VALUES (1, ?, ?) \
         ON DUPLICATE KEY UPDATE version = VALUES(version), update_url = VALUES(update_url), \
         updated_at = CURRENT_TIMESTAMP",
        (&version, &update_url),
    )
    .expect("更新 version_config 失败");

    println!("version_config 已更新（线路{line}）: v{version} — {update_url}");
}
