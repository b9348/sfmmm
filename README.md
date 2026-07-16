# SFMMM

一个基于 Tauri 2 的游戏模组管理桌面应用，支持模组浏览、安装、更新及创意工坊功能。

## 功能特性

- **模组管理** - 扫描和管理本地游戏模组
- **创意工坊** - 浏览、上传、下载社区模组
- **自定义任务** - 支持 v1/v2 版本的自定义任务文件夹
- **游戏设置** - 配置游戏路径和启动参数
- **多语言支持** - 支持中文、英文、日文

## 技术栈

- **前端**: React 19 + Vite + Fluent UI
- **框架**: Tauri 2 (跨平台桌面应用)
- **后端**: Rust + MySQL
- **数据库**: SQLite (本地) + MySQL (远程)
- **编辑器**: TipTap (富文本编辑器)
- **国际化**: i18next

## 快速开始

### 前置要求

- Node.js (>= 18)
- pnpm
- Rust (>= 1.75)

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
# 仅运行前端
pnpm dev

# 运行桌面应用
pnpm tauri dev
```

### 构建

```bash
# 构建前端
pnpm build

# 构建桌面应用安装包
pnpm tauri build
```

### 代码检查

```bash
pnpm lint
```

## 项目结构

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

## 环境变量

创建 `src-tauri/.env` 文件并配置以下变量：

```env
DB_URL=mysql://user:password@host:port/database
```

参考 `src-tauri/.env.example`。

## 许可证

MIT
