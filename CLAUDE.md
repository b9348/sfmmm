# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

- 安装依赖：`pnpm install`
- 仅运行 Vite 前端：`pnpm dev`
- 构建 Vite 前端：`pnpm build`
- 检查 JavaScript/JSX 代码：`pnpm lint`
- 预览构建后的前端：`pnpm preview`
- 运行 Tauri CLI 命令：`pnpm tauri <command>`
- 以开发模式运行桌面应用：`pnpm tauri dev`
- 构建桌面应用安装包：`pnpm tauri build`
- 检查 Tauri Rust crate：`cargo check --manifest-path src-tauri/Cargo.toml`


## 架构概览

这是一个 Tauri 2 桌面应用，前端使用 React 19 + Vite，宿主层是 `src-tauri` 下的轻量 Rust 代码。

- 前端入口是 `src/main.jsx`，它在 React `StrictMode` 中渲染 `src/App.jsx`。
- `App.jsx` 持有顶层 UI 状态：通过 `@tauri-apps/plugin-sql` 读取 `sqlite:config.db`，判断是否进入首次运行流程，然后用 Fluent UI 主题渲染主界面。
- 主界面由顶部标题栏和 Fluent UI 标签页组成。`src/components/layout/TabNavigation.jsx` 定义标签页 key，`src/App.jsx` 根据这些 key 渲染 `src/modules/index.js` 导出的功能模块。
- 功能区位于 `src/modules/*`：模组、存档、导入/导出、游戏设置。当前多个模块仍使用 mock/静态数据；首次设置和游戏设置会通过 Tauri SQL 持久化配置。
- `src/components/WelcomeScreen.jsx` 是首次运行设置界面。它使用 Tauri dialog 插件选择游戏目录，使用 fs 插件检查 `SecretFlasherManaka.exe`，并把 `game_path`、`exe_path`、`initialized` 写入 SQLite 的 `config` 表。
- `src/modules/settings/GameSettings.jsx` 读取从 `App.jsx` 传入的配置，并直接向同一个 SQLite `config` 表写入更新。
- Rust 启动逻辑在 `src-tauri/src/main.rs` 和 `src-tauri/src/lib.rs`。`lib.rs` 注册 dialog、fs、sql 插件，并定义 `config` 和 `mods` 表的初始 SQL migration。
- Tauri 权限声明在 `src-tauri/capabilities/default.json`；当前端需要新的 Tauri API 时，需要在这里补充相应插件权限。
- Tauri 构建配置在 `src-tauri/tauri.conf.json`；它要求 Vite 开发服务器运行在 5173 端口，生产前端产物位于 `dist`。

## 注意事项

- 本项目使用 pnpm；依赖变更时保持 `pnpm-lock.yaml` 同步。
- ESLint 使用 `eslint.config.js` 中的 flat config，并忽略 `dist` 和 `src-tauri/target`。
- Vite 配置了 `strictPort: true` 且端口为 5173，因为 Tauri 的 `devUrl` 指向这个固定地址。
