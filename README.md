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
- **Backend**: Rust + MySQL
- **Database**: SQLite (local) + MySQL (remote)
- **Editor**: TipTap (rich text editor)
- **Internationalization**: i18next

- **前端**: React 19 + Vite + Fluent UI
- **框架**: Tauri 2 (跨平台桌面应用)
- **后端**: Rust + MySQL
- **数据库**: SQLite (本地) + MySQL (远程)
- **编辑器**: TipTap (富文本编辑器)
- **国际化**: i18next

- **フロントエンド**: React 19 + Vite + Fluent UI
- **フレームワーク**: Tauri 2 (クロスプラットフォームデスクトップアプリ)
- **バックエンド**: Rust + MySQL
- **データベース**: SQLite (ローカル) + MySQL (リモート)
- **エディタ**: TipTap (リッチテキストエディタ)
- **国際化**: i18next

## Quick Start / 快速开始 / クイックスタート

### Prerequisites / 前置要求 / 前提条件

- Node.js (>= 18)
- pnpm
- Rust (>= 1.75)

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
│   │   └── db.rs           # MySQL operations
│   └── tauri.conf.json     # Tauri config
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
│   │   └── db.rs           # MySQL 数据库操作
│   └── tauri.conf.json     # Tauri 配置
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
│   │   └── db.rs           # MySQL データベース操作
│   └── tauri.conf.json     # Tauri 設定
├── public/                 # 静的アセット
└── package.json            # フロントエンド依存関係
```

## Environment Variables / 环境变量 / 環境変数

Create `src-tauri/.env` file with the following variables:

创建 `src-tauri/.env` 文件并配置以下变量：

`src-tauri/.env` ファイルを作成し、以下の変数を設定します：

```env
DB_URL=mysql://user:password@host:port/database
```

See `src-tauri/.env.example` for reference.

参考 `src-tauri/.env.example`。

`src-tauri/.env.example` を参照してください。

## License / 许可证 / ライセンス

MIT
