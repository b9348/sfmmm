fn main() {
    tauri_build::build();

    // 编译时读取 .env 中的 DB_URL，嵌入到二进制中
    // 这样 .env 不会被打包进安装包，且源码中不硬编码数据库连接
    let env_path = std::path::Path::new(".env");
    if let Ok(content) = std::fs::read_to_string(env_path) {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with("DB_URL=") {
                if let Some(value) = line.strip_prefix("DB_URL=") {
                    println!("cargo:rustc-env=DB_URL={}", value);
                    break;
                }
            }
        }
    }
}
