---
name: version-bump
description: Document the auto version bump and GitHub Release workflow for this project. Use when user asks about version bumping, release process, CI/CD, or how to create a new release.
user_invocable: true
allowed_tools: Read, Glob, Grep, Bash
---

# Auto Version Bump & Release

**版本号由本地 pre-commit hook 自动更新**，push 到 `main` 分支后 GitHub Actions 自动构建 NSIS 安装包、上传到图床 CDN、创建 GitHub Release，并将版本号和下载链接写入云端数据库 `version_config` 表。

## 版本号更新机制

### 本地 pre-commit hook（自动 bump）

每次 commit 时，`.git/hooks/pre-commit` 会自动：
1. 从 `src-tauri/tauri.conf.json` 读取当前版本
2. 解析 semver，patch +1（例如 0.1.0 → 0.1.1）
3. 更新以下 3 个文件中的版本号：

   | 文件 | 字段 |
   |------|------|
   | `src-tauri/tauri.conf.json` | `version` |
   | `src-tauri/Cargo.toml` | `version` (package) |
   | `src/version.js` | `APP_VERSION` |

4. 将更新的文件加入 staging area

**跳过版本更新**：commit message 包含 `[skip version]` 即可跳过（适用于文档变更等无需发版的提交）。

## 工作流文件

`.github/workflows/release.yml`

## 触发条件

- `push` 到 `main` 分支

## 工作流概览

```
push → [Build NSIS installer] → [Create Release & Update Cloud]
                                 ↓
                       ImgBed CDN 上传 + MySQL 直连更新
```

### Job 1: Build NSIS installer (windows-latest)

1. 从 `src-tauri/tauri.conf.json` 读取当前版本
2. 创建 git tag（如不存在）
3. 安装 pnpm、Node.js、Rust
4. 注入 `DB_URL` 环境变量
5. 执行 `pnpm tauri build`
6. 产出的 `.exe` 上传为 artifact

### Job 2: Create Release & Update Cloud (ubuntu-latest)

1. 使用 `softprops/action-gh-release` 创建 GitHub Release
   - 标题: `v{x.y.z}`
   - 附件: NSIS 安装包
   - 自动生成 release notes
2. 将 `.exe` 上传到 **ImgBed 图床 CDN**（`img.b9349.dpdns.org`），通过 Telegram 渠道分发
   - 上传路径: `sfm/installer/v{x.y.z}/`
   - 授权方式: `Authorization: Bearer ${{ secrets.IMGBED_TOKEN }}`
3. 通过 **`DB_URL` 直连 MySQL**，更新 `version_config` 表：
   - 版本号 → `version` 字段
   - ImgBed 直链 → `update_url` 字段

> ⚠️ `sfm.b9349.dpdns.org` 从 GitHub Actions 网络不可达（ETIMEDOUT），
> 因此不通过 Cloud API 更新版本配置，改用 MySQL 直连。

## 跳过版本 Bump

在 commit 的 **subject 行（第一行）** 中包含 `[skip version]`：

```bash
git commit -m "docs: update readme [skip version]"
```

适用于：文档变更、CI 配置调整、注释修改等无需发版的提交。

## 手动触发

如果要手动创建一个 release 而不 push 到 main：
1. 本地修改版本号（3 个文件）
2. commit + tag: `git tag v{x.y.z}`
3. `git push origin main --tags`

## 版本号同步

由于版本号由本地 pre-commit hook 自动更新，本地和远程始终保持一致：
- 每次 commit 时自动 bump patch 版本号
- push 到 main 后 CI 直接构建发布
- 不会再有 CI 创建额外 commit 导致的版本差异

## 所需的 GitHub Secrets

| Secret | 用途 |
|--------|------|
| `DB_URL` | 构建时生成 `.env`；Release 时直连 MySQL 更新 `version_config` |
| `IMGBED_TOKEN` | 上传安装包到图床 CDN（`img.b9349.dpdns.org`） |

## 版本号位置

| 位置 | 用途 |
|------|------|
| `src-tauri/tauri.conf.json` | Tauri 应用版本（主版本来源） |
| `src-tauri/Cargo.toml` | Rust crate 版本 |
| `src/modules/settings/GameSettings.jsx:69` | 前台显示的版本号 |
| `package.json` | 当前为 `0.0.0`，未使用 |
| MySQL `version_config.version` | 云端最新版本（供桌面端检测更新） |

## 更新检测链路

```
桌面端 (用户)
  │  GET https://sfm.b9349.dpdns.org/api/admin/version  (公开接口，无需认证)
  │  返回 { version, update_url }
  ↓
比较本地 CURRENT_VERSION vs 云端 version
  │
  ├─ 无更新 → 提示"已是最新版"
  └─ 有新版本 → 显示"下载更新"按钮，链接到 ImgBed 直链

ImgBed 直链格式:
  https://img.b9349.dpdns.org/file/sfm/installer/v{x.y.z}/{timestamp}_sfmmm_{x.y.z}_x64-setup.exe
```

## 云端数据库 `version_config` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT PK | 始终为 1（只有一条记录） |
| `version` | VARCHAR(20) | 最新版本号，如 `0.1.7` |
| `update_url` | VARCHAR(500) | 安装包下载直链（ImgBed CDN） |
| `updated_at` | TIMESTAMP | 最后更新时间（自动） |

## 本地更新检测代码

- `src/services/updateApi.js` — `checkVersion(currentVersion)` 调云端 API 比较版本
- `src/modules/settings/GameSettings.jsx` — 显示更新面板和下载按钮

## gh CLI

已安装 `gh` CLI（v2.83.2），可用于：
- 查看 workflow 运行状态：`gh run list`
- 查看 workflow 日志：`gh run view <run-id> --log`
- 查看 releases：`gh release list`
