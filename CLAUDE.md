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

这是一个 **Tauri 2 桌面应用**，前端使用 React 19 + Vite + Fluent UI，Rust 宿主层采用 **双数据库架构**（本地 SQLite + 远程 MySQL）。

```
┌─────────────────────────────────────────────────┐
│  前端 (React 19 + Vite + Fluent UI)               │
│                                                   │
│  @tauri-apps/plugin-sql ──直连── sqlite:config.db  │
│  ├─ App.jsx         → 加载配置、判断首次运行      │
│  ├─ WelcomeScreen   → 写入 game_path/exe_path    │
│  ├─ GameSettings    → 读写 config 表              │
│  ├─ AuthContext     → 持久化 cloud_user_id/name   │
│  ├─ usePersistUI    → 持久化窗口位置/侧栏折叠状态   │
│  ├─ useInstalledMods→ 读取 installed_workshop_mods │
│  └─ installMod     → 保存安装记录                │
│                                                   │
│  invoke() ──调用── Rust Tauri 命令                 │
│  ├─ 本地功能: open_folder, scan_mods,             │
│  │  toggle_mod_enabled                            │
│  ├─ HTTP: http_request, test_network              │
│  ├─ MySQL后端: db_login, db_list_mods, ...        │
│  └─ 更新: db_check_updates, db_install_update     │
└──────────────────────┬──────────────────────────────┘
                       ↕ Tauri IPC
┌──────────────────────┴──────────────────────────────┐
│  Rust 层 (src-tauri)                                 │
│                                                      │
│  src-tauri/src/lib.rs                                │
│  ├─ 注册插件: dialog, fs, shell, http, process, log │
│  ├─ tauri_plugin_sql: 3 个 migration                 │
│  │   (config, mods, installed_workshop_mods 表)      │
│  ├─ 本地 Tauri 命令:                                 │
│  │   open_folder, scan_mods, toggle_mod_enabled      │
│  ├─ HTTP 网络命令: http_request, test_network        │
│  └─ 注册所有 db_* 命令 (委托给 db.rs)               │
│                                                      │
│  src-tauri/src/db.rs (MySQL 后端, ~1036 行)          │
│  ├─ 连接: 通过 DB_URL 环境变量连接远程 MySQL         │
│  ├─ 用户系统: login, register                        │
│  ├─ 工坊模组: list, my_list, detail, create,         │
│  │   update, delete, save_mod_file                   │
│  ├─ 评论系统: add_comment, get_comments,             │
│  │   get_replies, delete_comment                     │
│  ├─ 更新系统: check_updates, install_update          │
│  └─ 图床配置: get_imgbed_config                      │
└──────────────────────────────────────────────────────┘
```

### 前端结构

- **入口**: `src/main.jsx` → 在 React `StrictMode` 中渲染 `src/App.jsx`。
- **状态管理**: `App.jsx` 使用 `useReducer` 管理 `isFirstRun` / `config` 状态。
- **标签页**: `src/components/layout/TabNavigation.jsx` 定义侧边栏标签页 key 列表。当前标签页为：
  - `mods` → 模组列表 (`src/modules/mods/ModList.jsx`)
  - `v1` → 自定义任务文件夹 v1 (`src/modules/missions/MissionFolder.jsx`, subfolder=`CustomMissions`)
  - `v2` → 自定义任务文件夹 v2 (`src/modules/missions/MissionFolder.jsx`, subfolder=`CustomMissions2`)
  - `workshop` → 创意工坊 (`src/modules/workshop/Workshop.jsx`)
  - `settings` → 游戏设置 (`src/modules/settings/GameSettings.jsx`)
  - `saves`、`import-export` → 已注释暂不显示
- **模块导出**: `src/modules/index.js` 导出所有功能模块，`App.jsx` 按标签页选择渲染。
- **i18n**: `src/i18n/index.js` 使用 `i18next` + `react-i18next`，支持 `zh` / `en` / `ja`，默认中文。
- **认证上下文**: `src/contexts/AuthContext.jsx` 提供 `loginSuccess` / `logout` / `isLoggedIn`，用户信息持久化在 SQLite `config` 表。
- **自定义 Hooks**:
  - `usePersistUI` — 持久化窗口位置/大小、侧边栏折叠状态到 SQLite
  - `useInstalledMods` — 读取 SQLite 中已安装的工坊模组列表，调用 Rust `db_check_updates` 检测更新
- **服务层** (`src/services/`):
  - `workshopApi.js` — 封装所有 `invoke('db_*')` 调用（登录、注册、模组 CRUD、评论、文件上传）
  - `updateApi.js` — 从服务器检测新版本、调用 `invoke('db_install_update')` 静默安装
  - `installMod.js` — 从图床下载 zip 包、解压到游戏目录、写入安装记录

### Rust 后端结构

- `src-tauri/src/main.rs` — 标准 Tauri 入口，调用 `app_lib::run()`
- `src-tauri/src/lib.rs`:
  - 声明 `mod db` 引入 `db.rs`
  - 定义 3 个 SQLite migration（`config`、`mods`、`installed_workshop_mods` 表）
  - 注册插件: dialog, fs, shell, http, process, log
  - 注册本地 Tauri 命令: `open_folder`, `scan_mods`, `toggle_mod_enabled`, `http_request`, `test_network`
  - 注册 MySQL 后端命令: 所有 `db::db_*` 函数
  - 通过 `manage()` 注入 MySQL 连接池 `DbState`
- `src-tauri/src/db.rs`:
  - 使用 `mysql` crate 通过 `DB_URL` 环境变量连接远程 MySQL
  - 密码使用 SHA-256 哈希存储
  - 所有函数都是异步 Tauri 命令，使用 `tokio::task::spawn_blocking` 执行同步 MySQL 查询
  - 数据库连接池在启动时初始化（`DbState::new()`），通过 Tauri State 共享

## 数据库

### 本地 SQLite (`sqlite:config.db`)
`@tauri-apps/plugin-sql` 前端直连，由 Rust `tauri_plugin_sql` migration 自动建表。

**表 `/ config`**
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| key | TEXT UNIQUE | 配置键名 |
| value | TEXT | 配置值 |

常用 key: `game_path`, `exe_path`, `initialized`, `selected_tab`, `sidebar_collapsed`, `window_*`, `cloud_user_id`, `cloud_username`

**表 `mods`** — 本地模组记录（当前部分使用中）

**表 `installed_workshop_mods`** — 已安装的工坊模组
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| mod_key | TEXT UNIQUE | 模组唯一标识 |
| mod_id | INTEGER | MySQL 中的模组 ID |
| category | TEXT | 分类 (v1/v2/dll/folder) |
| installed_version | TEXT | 已安装版本 |
| file_hash | TEXT | 文件哈希 |
| installed_at | TEXT | 安装时间 |

### 远程 MySQL
通过 `DB_URL` 环境变量连接，Rust `mysql` crate 直连。包含 `users`、`mods`、`mod_translations`、`mod_files`、`mod_comments` 等表。schema 在服务端维护，不在代码仓库中。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DB_URL` | MySQL 连接字符串（格式: `mysql://user:pass@host:port/db`） |
| `.env` 文件位置 | 运行时: exe 同目录；开发时: `src-tauri/` 下 |

参考 `src-tauri/.env.example`。

## Tauri 配置

- 权限声明: `src-tauri/capabilities/default.json` — 需要新 Tauri API 时在此补充。
- 构建配置: `src-tauri/tauri.conf.json` — Vite 开发服务器需运行在 5173 端口，生产前端产物位于 `dist`。
- Vite 配置: `strictPort: true`, 端口 5173 (Tauri `devUrl` 指向此地址)。

## 注意事项

- 本项目使用 `pnpm`；依赖变更时保持 `pnpm-lock.yaml` 同步。
- ESLint 使用 `eslint.config.js` 中的 flat config，并忽略 `dist` 和 `src-tauri/target`。
- `src-tauri/Cargo.toml` 依赖: `tauri-plugin-sql` (SQLite)、`mysql` (远程数据库)、`reqwest` (HTTP)、`sha2` (密码哈希)、`tokio` (异步运行时)、`dotenvy` (环境变量加载)。
