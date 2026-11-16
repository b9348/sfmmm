# SFMMM

A Tauri 2 based game mod management desktop application with support for mod browsing, installation, updates, and workshop features.

一个基于 Tauri 2 的游戏模组管理桌面应用，支持模组浏览、安装、更新及创意工坊功能。

SFMMM ワークショップ Mod マネージャー - Tauri 2 ベースのゲーム Mod 管理デスクトップアプリケーションです。

## Features / 功能特性 / 機能

- **Mod Management** - Scan and manage local game mods
- **Workshop** - Browse, upload, and download community mods
- **Custom Missions** - Support for v1/v2 custom mission folders
- **Game Settings** - Configure game path and launch parameters
- **Multi-language Support** - Chinese, English, Japanese

- **模组管理** - 扫描和管理本地游戏模组
- **创意工坊** - 浏览、上传、下载社区模组
- **自定义任务** - 支持 v1/v2 版本的自定义任务文件夹
- **游戏设置** - 配置游戏路径和启动参数
- **多语言支持** - 支持中文、英文、日文

- **Mod管理** - ローカルゲームModのスキャンと管理
- **ワークショップ** - コミュニティModの閲覧、アップロード、ダウンロード
- **カスタム任務** - v1/v2 カスタム任務フォルダのサポート
- **ゲーム設定** - ゲームパスと起動パラメータの設定
- **多言語サポート** - 中国語、英語、日本語

## Tech Stack / 技术栈 / 技術スタック

- **Frontend**: React 19 + Vite + Fluent UI
- **Framework**: Tauri 2 (cross-platform desktop app)
- **Backend**: Rust + Axum (`server/`) + Valkey cache
- **Database**: SQLite (local) + MySQL (server-side, field-level encryption)
- **Editor**: TipTap (rich text editor)
- **Internationalization**: i18next

- **前端**: React 19 + Vite + Fluent UI
- **框架**: Tauri 2 (跨平台桌面应用)
- **后端**: Rust + Axum (`server/`) + Valkey 缓存
- **数据库**: SQLite (本地) + MySQL (服务端，字段级加密)
- **编辑器**: TipTap (富文本编辑器)
- **国际化**: i18next

- **フロントエンド**: React 19 + Vite + Fluent UI
- **フレームワーク**: Tauri 2 (クロスプラットフォームデスクトップアプリ)
- **バックエンド**: Rust + Axum (`server/`) + Valkey キャッシュ
- **データベース**: SQLite (ローカル) + MySQL (サーバー側、フィールド暗号化)
- **エディタ**: TipTap (リッチテキストエディタ)
- **国際化**: i18next

## Quick Start / 快速开始 / クイックスタート

### Prerequisites / 前置要求 / 前提条件

- Node.js (>= 18)
- pnpm
- Rust (>= 1.90)
- MySQL 8 + Valkey/Redis 6+ (server side, see `server/README.md`)

### Install Dependencies / 安装依赖 / 依存関係のインストール

```bash
pnpm install
```

### Development / 开发模式 / 開発モード

```bash
# Frontend only
pnpm dev

# Desktop app
pnpm tauri dev
```

```bash
# 仅运行前端
pnpm dev

# 运行桌面应用
pnpm tauri dev
```

```bash
# フロントエンドのみ
pnpm dev

# デスクトップアプリ
pnpm tauri dev
```

### Build / 构建 / ビルド

```bash
# Build frontend
pnpm build

# Build desktop app installer
pnpm tauri build
```

```bash
# 构建前端
pnpm build

# 构建桌面应用安装包
pnpm tauri build
```

```bash
# フロントエンドをビルド
pnpm build

# デスクトップアプリのインストーラーをビルド
pnpm tauri build
```

### Lint / 代码检查 / コードチェック

```bash
pnpm lint
```

## Project Structure / 项目结构 / プロジェクト構造

```
├── src/                    # Frontend source
│   ├── components/         # Common components
│   ├── contexts/           # React Context
│   ├── hooks/              # Custom Hooks
│   ├── i18n/               # Internationalization
│   ├── modules/            # Feature modules
│   ├── services/           # API services
│   ├── App.jsx             # App entry
│   └── main.jsx            # React entry
├── src-tauri/              # Tauri Rust source
│   ├── src/
│   │   ├── main.rs         # Tauri entry
│   │   ├── lib.rs          # Plugin registration
│   │   ├── api.rs          # Cloud API client (token, RPC, upload)
│   │   └── db.rs           # Cloud command proxies + local file modules
│   └── tauri.conf.json     # Tauri config
├── server/                 # Axum cloud backend (MySQL + Valkey + storage)
│   ├── src/main.rs         # HTTP/TLS entry
│   ├── src/rpc.rs          # RPC dispatch / auth / cache
│   ├── src/db/             # MySQL business logic
│   └── examples/           # DB maintenance scripts
├── public/                 # Static assets
└── package.json            # Frontend dependencies
```

```
├── src/                    # 前端源码
│   ├── components/         # 通用组件
│   ├── contexts/           # React Context
│   ├── hooks/              # 自定义 Hooks
│   ├── i18n/               # 国际化配置
│   ├── modules/            # 功能模块
│   ├── services/           # API 服务
│   ├── App.jsx             # 应用入口
│   └── main.jsx            # React 渲染入口
├── src-tauri/              # Tauri Rust 源码
│   ├── src/
│   │   ├── main.rs         # Tauri 入口
│   │   ├── lib.rs          # 插件注册和命令定义
│   │   ├── api.rs          # 云 API 客户端（令牌 / RPC / 上传）
│   │   └── db.rs           # 云命令代理 + 本地文件模块
│   └── tauri.conf.json     # Tauri 配置
├── server/                 # Axum 云后端（MySQL + Valkey + 文件存储）
│   ├── src/main.rs         # HTTP/TLS 入口
│   ├── src/rpc.rs          # RPC 分发 / 鉴权 / 缓存
│   ├── src/db/             # MySQL 业务逻辑
│   └── examples/           # 数据库维护脚本
├── public/                 # 静态资源
└── package.json            # 前端依赖
```

```
├── src/                    # フロントエンドソース
│   ├── components/         # 共通コンポーネント
│   ├── contexts/           # React Context
│   ├── hooks/              # カスタム Hooks
│   ├── i18n/               # 国際化設定
│   ├── modules/            # 機能モジュール
│   ├── services/           # API サービス
│   ├── App.jsx             # アプリケーションエントリ
│   └── main.jsx            # React レンダリングエントリ
├── src-tauri/              # Tauri Rust ソース
│   ├── src/
│   │   ├── main.rs         # Tauri エントリ
│   │   ├── lib.rs          # プラグイン登録とコマンド定義
│   │   ├── api.rs          # クラウド API クライアント（トークン / RPC / アップロード）
│   │   └── db.rs           # クラウドコマンド代理 + ローカルファイルモジュール
│   └── tauri.conf.json     # Tauri 設定
├── server/                 # Axum クラウドバックエンド（MySQL + Valkey + ストレージ）
│   ├── src/main.rs         # HTTP/TLS エントリ
│   ├── src/rpc.rs          # RPC ディスパッチ / 認証 / キャッシュ
│   ├── src/db/             # MySQL ビジネスロジック
│   └── examples/           # データベース保守スクリプト
├── public/                 # 静的アセット
└── package.json            # フロントエンド依存関係
```

## Environment Variables / 环境变量 / 環境変数

Server side（服务端）: copy `server/.env.example` to `server/.env` and fill in:

```env
DB_URL=mysql://user:password@127.0.0.1:3306/sfmmm
DB_ENC_KEY=<64 hex chars, same as existing data>
API_TOKEN_SECRET=<random long string>
ADMIN_TOKEN=<random long string>
VALKEY_URL=redis://127.0.0.1:6379/0
DATA_DIR=/var/lib/sfmmm/data
PUBLIC_BASE_URL=https://api.example.com
```

Desktop side（桌面端）: `src-tauri/.env` only contains public config such as the
legacy image-bed host, mirror, release-script credentials and `GITHUB_REPO`.
See `src-tauri/.env.example`.

服务端配置见 `server/.env.example`；桌面端 `src-tauri/.env` 只保留公开/发布脚本配置，
不再包含数据库密码与字段加密密钥。部署与数据库迁移详见 `server/README.md`。

`src-tauri/.env.example` を参照してください。

## License / 许可证 / ライセンス

MIT


---

高风险：zip 条目名 GBK 乱码
db/subscribe.rs:198 / db/bepinex.rs:54(zip crate = "2"):ZIP 规范对无 UTF-8 标志的条目名默认按 CP437 解码(刚用 context7 核实过 zip2 的行为，且提供 name_raw() 正是为此场景)。中文作者用 WinRAR/7-Zip 旧版打的包是 GBK 文件名、通常不带 UTF-8 标志 → 订阅 mod 解压到游戏目录后文件名全部乱码，游戏加载不到、指纹比对也基于乱码名。影响面：订阅下载(subscribe.rs)、v1/v2 分发包(bepinex.rs);官方 BepInEx 包是 ASCII 名所以 bepinex 风险低。修法:name_raw() 拿原始字节，UTF-8 校验失败时用 encoding_rs 按 GBK 解码。