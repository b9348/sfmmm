# AGENTS.md

Tauri 2 桌面应用（游戏 Mod 管理器）：React 19 + Fluent UI v9 前端（`src/`）+ Rust 本地层（`src-tauri/`），包管理器用 pnpm。

云端（Axum 服务端 + Vue 管理后台）已拆到独立仓库 `your_name/AxumVue`。本仓只含客户端，不再有 `server/`、`admin/`、`docs/` 目录，也没有本地 MySQL 直连。

## 架构

```
Tauri 前端 (React, src/)
   │ invoke
Tauri 本地命令 (src-tauri：文件/下载/安装/编辑工作区)
   │ HTTPS  POST /api/user/rpc/<command>（Bearer 令牌）
Axum 服务端（另一个仓库）
```

- `src-tauri/src/api.rs` 是云 API 客户端：base URL、令牌持久化、错误映射、流式上传。
- `src-tauri/src/db.rs` 里的代理命令用宏 `rpc_command!` 定义，命令名与参数签名必须与服务端 `server/src/rpc.rs` 的 `dispatch` 一致。**改契约要两边各提交一次**：本仓改 `rpc_command!` + `src-tauri/src/lib.rs` 尾部的 `generate_handler![...]`，AxumVue 仓改 `dispatch` 与 `PUBLIC_COMMANDS`。
- 纯本地命令（保存文件、扫描游戏目录、下载、安装、订阅任务、编辑工作区）只在 Tauri 侧，不走服务端。
- 前端统一经 `src/services/dbCall.js` 调用；只读命令有本地 SQLite 缓存回退。

## 环境变量

客户端只放公开/发布脚本配置，任何密钥都不进本仓：

- `src-tauri/.env`（参考 `.env.example`）：`IMGBED_URL`、`IMGBED_MIRROR_URL`、`QUARK_CLIENT_ID`/`QUARK_SIGN_KEY`、`GITHUB_REPO`、`DESKTOP_XPORT_KEY`（`/api/user/rpc` 传输信封密钥，构建期经 `build.rs` 以 `cargo:rustc-env` 注入二进制）。缺失时 `src-tauri/src/xport.rs` 会 warn 并禁用传输加密，服务端对明文请求仍兼容。
- 根目录 `.env`：`VITE_LATEST_URL`（前端更新检查）。
- `SFMMM_API_BASE` 可在运行时覆盖服务端基址；`SFMMM_OFFLINE=1` 让所有云调用直接失败并回退本地缓存。
- 数据库、图床令牌、加密密钥只属于 AxumVue 仓的 `server/.env`，本仓不应出现。

## 开发与构建

- `pnpm tauri dev`：正常启动（需要可用的云 API 服务端）。
- `pnpm tauri dev:of`：注入 `SFMMM_OFFLINE=1`，云调用返回 `[DBERR:OFFLINE_DEV]`，纯本地功能不受影响。
- vite dev server 固定端口 5173（strictPort），端口被占会直接失败。
- dev 与安装版共用同一个 bundle identifier，因此 `pnpm tauri dev` 与已安装版本不能同时运行：后启动者会被单实例插件静默退出（vite dev server 仍在跑，别误判为 dev 启动失败）。
- `pnpm lint` / `pnpm test` / `pnpm build`。
- 桌面端不需要 MySQL 驱动；`src-tauri/Cargo.toml` 不应引入 `mysql`/`aes-gcm` 等数据库依赖。

## 发版

- `.github/workflows/release.yml` 由 `main` 分支 push 触发，只构建客户端安装包。
- 本地 `pnpm release` 默认写服务端 `version_config`（`admin_set_version`）。服务端配置拆库后由 `SFMMM_CLOUD_ENV` 指向 AxumVue 仓的 `server/.env`，或直接用 `SFMMM_PUBLIC_BASE_URL` / `SFMMM_ADMIN_TOKEN` / `R2_*` 环境变量；`--no-db` 可跳过。
- 构建产物指纹见 `scripts/build-meta.mjs`：`pnpm release --skip-build` 复用本地包前会比对 HEAD 与 `.env` 哈希，不匹配直接拒绝，不要绕过。
- 版本号需手动保持一致（`package.json` 恒为 0.0.0 不参与）：`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src/version.js`。

## 其他约定

- i18n：`src/i18n/locales/{zh,en,ja}.json` 三份都要加 key。
- 窗口无边框（`decorations: false`），标题栏是自定义组件 `src/components/TitleBar.jsx`。
- 本地 SQLite `config.db` 走 tauri-plugin-sql，migration 定义在 `src-tauri/src/lib.rs`；前端统一经 `src/services/dbHelper.js` 读写。
- 解压不可信归档：zip 条目走 `safe_zip_path` 校验后再落盘；7z 必须走 `extract_safely`，不要直接调用 `sevenz_rust::decompress_file`，禁止 `zip::ZipStreamReader::extract` / `ZipArchive::extract` / `shallow_copy_file`（CVE-2026-115905 及 symlink/SUID 系列公告；`zip` 固定在 2.x）。
