# 重构计划：移除 sfm-cloud 中间层，直连 MySQL (SQLPub)

## 状态：✅ 全部完成

## 架构变化
```
BEFORE:  前端 → workshopApi.js (HTTP fetch) → sfm-cloud (Next.js) → MySQL
AFTER:   前端 → workshopApi.js (Tauri invoke) → Rust 后端 (mysql crate) → MySQL
```

## 执行步骤

### ✅ Step 0: 创建分支
- [x] git checkout -b refactor/direct-mysql

### ✅ Step 1: Rust 依赖
- [x] Cargo.toml: 添加 mysql, sha2, hex, tokio

### ✅ Step 2: 新建 Rust 数据库模块
- [x] `src-tauri/src/db.rs`:
  - MySQL 连接池初始化 (`DbState`)
  - 所有数据库操作命令：
    - `db_login` — 验证用户登录 (SHA256 密码)
    - `db_register` — 注册新用户
    - `db_list_mods` — 列出 Mod (分页/搜索/多语言)
    - `db_get_mod_detail` — Mod 详情
    - `db_get_mod_for_edit` — 获取可编辑 Mod (含作者鉴权)
    - `db_create_mod` — 创建 Mod
    - `db_update_mod` — 更新 Mod
    - `db_delete_mod` — 删除 Mod
    - `db_list_my_mods` — 我的 Mod
    - `db_save_mod_file` — 保存文件 URL 到 MySQL
    - `db_get_imgbed_config` — ImgBed 配置
    - `db_get_version` — 应用版本信息

### ✅ Step 3: 更新 lib.rs
- [x] 添加 `mod db;`
- [x] 注册所有新命令到 `invoke_handler`
- [x] 初始化 MySQL 连接池并 `.manage()`
- [x] 保留旧命令 (http_request, test_network 等不变)

### ✅ Step 4: 更新前端 API 服务
- [x] `src/services/workshopApi.js`:
  - 移除所有 `fetch` 调用 → 替换为 `invoke()`
  - 移除 `API_BASE`, `authToken` 等无用逻辑
  - 添加 `getImgbedConfig()` + 直传 ImgBed 逻辑
  - 所有函数签名增加 `author_id` 参数
- [x] `src/services/updateApi.js`:
  - 替换为 `invoke('db_get_version')`

### ✅ Step 5: 更新认证上下文
- [x] `src/contexts/AuthContext.jsx`:
  - 移除 JWT token 管理
  - 只存储 `user_id` + `username`
  - 持久化到本地 SQLite config 表

### ✅ Step 6: 更新 UI 组件
- [x] `src/components/layout/TabNavigation.jsx`:
  - 兼容新返回格式 (无需改动)
- [x] `src/modules/workshop/MyMods.jsx`:
  - CreateModPage: +`useAuth()`, 传 `author_id`
  - EditModPage: +`useAuth()`, 传 `author_id`
  - MyMods: 传 `author_id` 给 `listMyMods` + `deleteMod`

### ✅ Step 7: 清理
- [x] 移除 `setAuthToken`/`getAuthToken` 引用 (已从 workshopApi 移除)
- [x] `API_BASE` 保留仅用于 ApiTestTab (诊断工具)
- [x] 所有模块导入正确

### 未改动
- `src/modules/workshop/ApiTestTab.jsx` — 保留原 HTTP 测试工具 (不影响业务)
- `src/modules/workshop/BrowseMods.jsx` — 使用 `listMods`/`installMod`, 兼容
- `src/services/installMod.js` — 不变 (已直连 ImgBed 下载)
