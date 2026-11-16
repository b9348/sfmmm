# APK 分支说明

这个分支（`apk`）只用于产出 Android APK，**桌面主线仍在 `main`**，两边互不影响：

- `main` 继续按 `release.yml` 出 NSIS 安装包，不包含任何移动端改动；
- `apk` 分支多了 Android 构建配置，并在移动端裁掉桌面独占能力；
- 需要同步主线更新时，把 `main` merge 进 `apk`，冲突基本只落在下面「改动清单」里的文件。

## 手机端保留什么

纯社区模式：

- 创意工坊：浏览 / 搜索 / 排序 / 模组详情 / 讨论区 / 我的模组（只读+删除）
- 通知：回复、申请、点赞、评分、私信
- 设置：语言、图床线路、数据库线路、关于
- 账号：登录 / 退出 / 改资料（**注册请在 PC 端完成**）

## 手机端去掉什么（桌面独占）

| 能力 | 说明 |
| --- | --- |
| 本地模组管理 / 存档 | 需要读写游戏目录，手机没有 |
| 导入 / 导出 | 依赖本地文件选择 |
| 下载安装 / 仅下载 / 退订 | 需要解压到游戏目录、写安装记录 |
| 订阅记录 | 桌面下载任务列表，手机不产生任务 |
| 启动游戏 | 只能拉起 PC 端 exe |
| 程序自更新 | APK 不走 PC 安装包更新管线，更新走发布页 |
| 发布 / 编辑 MOD | 编辑器依赖 PC 文件选择与本地打包 |
| 无边框标题栏 / 窗口几何持久化 | 移动端窗口由系统管理 |

判定统一走 `src/hooks/usePlatform.js`（按 UA 判断，不引入 `@tauri-apps/plugin-os`，
少一个原生插件和一条 capability 权限）。

## 构建

CI：`.github/workflows/android.yml`

- push 到 `apk` 分支 → 只产出 artifact
- 打 `android-v*` 标签或手动 dispatch → 构建 + 发布 Release
- 手动 dispatch 可填 `version_override`，否则取 `src-tauri/tauri.conf.json` 的版本

本地（需要 Android SDK、NDK、Java 17、`aarch64-linux-android` target）：

```bash
pnpm install
cp src-tauri/tauri.android.conf.json src-tauri/tauri.conf.json   # 用完记得 git checkout 还原
pnpm tauri android init                                          # 首次
pnpm tauri android build --apk --target aarch64
```

`tauri.android.conf.json` 与桌面配置的差异只在 bundle 目标（无 NSIS/Windows 段）和
`bundle.android`；其余键保持一致，避免两套配置漂移。

## 签名

CI 优先使用仓库 Secrets：

| Secret | 含义 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | keystore 文件的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | key 别名 |
| `ANDROID_KEY_PASSWORD` | key 口令（缺省同 keystore 口令） |

没配置时退回临时调试钥匙：**每次构建签名都不同，安装新 APK 前必须先卸载旧版**
（否则会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`）。

构建还需要仓库 Secrets（与桌面 release 同一套，均不写进仓库；**真实域名只放 Secrets**，
公开仓库的 Actions 日志会回显展开后的命令，放 Variables 等于公开）：

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `SFMMM_PUBLIC_BASE_URL` | Secret，必填 | 服务端基址；未单独配 `SFMMM_API_BASE` 时按 `<基址>/api/user` 推导 |
| `SFMMM_API_BASE` | Secret，可选 | 直接指定 `/api/user` 完整前缀 |
| `IMGBED_URL` | Secret | 更新清单与分发资源域名 |
| `DESKTOP_XPORT_KEY` | Secret，可选 | `/api/user/rpc` 传输加密；缺失时明文 |
| `VITE_LANZOU_BEPINEX` / `_V2` / `_FONT` / `_RMMOSAIC` | Secret，可选 | 前置包蓝奏云备用下载点，缺省则界面上不显示 |

`SFMMM_PUBLIC_BASE_URL` 缺失会直接构建失败并报 `::error::`，不会再退回任何写死的域名。

## 已知限制

- 外部链接（GitHub、网盘分享）走 `@tauri-apps/plugin-shell` 的 open，Android 上不一定能
  直接唤起浏览器；如果实测无效，后续换 `plugin-opener` 即可。
- 通知长连接（WebSocket）在手机端仍然启用，离线期间不会收推送，回到前台靠一次未读刷新补齐。
- 本机没有安装 Android SDK / NDK / `aarch64-linux-android` target，APK 编译只在 CI 上跑过；
  本地只验证了前端 lint/build 与桌面 `cargo check`。
- 顶部状态栏/刘海的安全区没有单独加 padding（桌面标题栏在手机端是整条去掉的），
  首次真机验证时如果内容贴边，在 `src/App.css` 给根容器补 `env(safe-area-inset-*)` 即可。

## 改动清单（合并 main 时重点看这里）

前端：

- `src/hooks/usePlatform.js`（新增）
- `src/App.jsx`：手机端标签集合、跳过欢迎屏/自更新/漫游引导、隐藏下载条
- `src/components/layout/TabNavigation.jsx`：去掉本地模组、启动游戏、订阅记录
- `src/components/TitleBar.jsx`：手机端不渲染
- `src/hooks/usePersistUI.js`：手机端跳过窗口几何读写
- `src/components/common/LoginForm.jsx`：手机端只登录
- `src/components/common/useGameVersionGuard.js`：手机端不查游戏版本
- `src/modules/settings/GameSettings.jsx`：隐藏游戏目录、程序更新
- `src/modules/workshop/Workshop.jsx`：去掉订阅记录页签
- `src/modules/workshop/BrowseMods.jsx`、`MyMods.jsx`：隐藏发布/编辑入口
- `src/modules/workshop/ModDetailPage.jsx`：手机端不查安装记录
- `src/modules/workshop/modDetail/ModFileRow.jsx`：隐藏安装/仅下载/退订
- `src/i18n/locales/{zh,en,ja}.json`：新增 `registerOnPc`、`mobileBrowseOnly`

Rust / 构建：

- `src-tauri/Cargo.toml`：TLS 统一 rustls（Android 无 native-tls 后端）、
  `tauri-plugin-single-instance` 移到桌面 target 依赖
- `src-tauri/src/lib.rs`：窗口几何恢复仅桌面执行
- `src-tauri/tauri.android.conf.json`（新增）
- `.github/workflows/android.yml`（新增）
