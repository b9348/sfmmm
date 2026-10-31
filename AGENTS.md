# AGENTS.md

Tauri 2 桌面应用（游戏 Mod 管理器）：React 19 + Fluent UI v9 前端（`src/`）+ Rust 后端（`src-tauri/`），包管理器用 pnpm。

## 环境变量与构建陷阱

- `src-tauri/.env`（参考 `.env.example`）配置数据库连接、加密密钥与图床凭据，由 `build.rs` 在构建时读取；改完必须重新编译 Rust 端才生效。
- 缺少必要的配置项时程序启动会直接报错（见 `db/crypto.rs`、`db/image.rs` 的 expect）。没有有效的 `src-tauri/.env` 就无法正常跑起来。
- `DB_ENC_KEY` 用于 MySQL 敏感字段加密；**更换密钥会导致已有数据无法解密**。
- 根目录 `.env` 是另一回事：放 `VITE_LATEST_URL`（前端更新检查用）。
- vite dev server 固定端口 5173（strictPort），端口被占会直接失败。
- 只调前端、不想连云数据库（或没有有效 `src-tauri/.env`）时用 `pnpm tauri dev:of`：`scripts/tauri.mjs` 注入 `SFMMM_OFFLINE=1`，后端在排队/取连接前直接返回 `[DBERR:OFFLINE_DEV]`（`db.rs` 的 `offline_dev`），前端 `dbCall` 回退到本地 SQLite 缓存。`pnpm tauri` 的其余子命令（如 `build`）仍原样透传给 Tauri CLI。

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

## 发版产物指纹

`pnpm tauri build` 成功后会在安装包旁落一个 `<exe>.meta.json`（记 HEAD、工作区是否干净、两个 `.env` 的哈希，逻辑在 `scripts/build-meta.mjs`）。`pnpm release --skip-build` 复用本地包前必须比对指纹：包名里的版本号只能证明它「声称」是哪个版本，证明不了它是用当前源码编的。

- 没有指纹、HEAD 不符或 `.env` 变过都会被拒——重新构建即可，不要绕过校验。
- 旧的本地安装包没有指纹，第一次需 `pnpm tauri build` 重编一次补上。
