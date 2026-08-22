# AGENTS.md

Tauri 2 桌面应用（游戏 Mod 管理器）：React 19 + Fluent UI v9 前端（`src/`）+ Rust 后端（`src-tauri/`），包管理器用 pnpm。

## 环境变量与构建陷阱

- `src-tauri/.env`（参考 `.env.example`）含 `DB_URL`、`DB_ENC_KEY`、`IMGBED_URL`、`IMGBED_TOKEN`。这些值由 **build.rs 在编译期嵌入二进制**（`cargo:rustc-env`），改完必须重新编译 Rust 端才生效。
- 缺少 `DB_ENC_KEY` 或图床配置时程序运行期会直接 panic（见 `db/crypto.rs`、`db/image.rs` 的 expect）。没有有效的 `src-tauri/.env` 就无法正常跑起来。
- `DB_ENC_KEY` 用于 MySQL 敏感字段的 AES-256-GCM 加密；**更换密钥会导致已有加密数据永久不可解密**。
- 根目录 `.env` 是另一回事：放 `VITE_LATEST_URL`（前端更新检查用）。
- vite dev server 固定端口 5173（strictPort），端口被占会直接失败。

## 架构要点

- 所有特权操作走 Tauri command（前端 `invoke`）。命令分散在 `src-tauri/src/lib.rs` 和 `src-tauri/src/db/*.rs`（由 `db.rs` 统一 re-export）。**新增命令必须登记到 lib.rs 尾部的 `generate_handler![...]` 列表**，否则运行时报 unknown command。
- 双数据库：
  - 远程 MySQL（用户/工坊数据），连接池在 `db::DbState`，代码在 `src-tauri/src/db/`
  - 本地 SQLite `config.db`（应用设置），走 tauri-plugin-sql，migration 定义在 lib.rs；前端统一经 `src/services/dbHelper.js` 读写
- 页面级功能在 `src/modules/<feature>/`，统一从 `src/modules/index.js` 导出
- i18n：`src/i18n/locales/{zh,en,ja}.json` 三份都要加 key
- 窗口无边框（`decorations: false`），标题栏是自定义组件 `src/components/TitleBar.jsx`

## 版本号同步

发版时需手动保持一致（package.json 恒为 0.0.0 不参与）：

- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`（updater 按此比较版本）
- `src/version.js`（注释标注由 CI 自动更新）
