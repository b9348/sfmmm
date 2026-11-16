use rusqlite::OptionalExtension;
use sha2::{Digest, Sha384};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

pub fn all() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_config_table",
            sql: "CREATE TABLE IF NOT EXISTS config (
                id INTEGER PRIMARY KEY,
                `key` TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                installed_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "ensure_tables_exist",
            sql: "CREATE TABLE IF NOT EXISTS config (
                id INTEGER PRIMARY KEY,
                `key` TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_installed_workshop_mods",
            sql: "CREATE TABLE IF NOT EXISTS installed_workshop_mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_key TEXT NOT NULL UNIQUE,
                mod_id INTEGER DEFAULT 0,
                category TEXT NOT NULL,
                installed_version TEXT NOT NULL,
                file_hash TEXT DEFAULT '',
                installed_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add_lang_code_to_installed_workshop_mods",
            sql: "ALTER TABLE installed_workshop_mods ADD COLUMN lang_code TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_manifest_to_installed_workshop_mods",
            sql: "ALTER TABLE installed_workshop_mods ADD COLUMN manifest TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "create_installed_workshop_mod_files",
            sql: "CREATE TABLE IF NOT EXISTS installed_workshop_mod_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_key TEXT NOT NULL,
                lang_code TEXT NOT NULL,
                installed_version TEXT NOT NULL,
                file_hash TEXT DEFAULT '',
                manifest TEXT DEFAULT '',
                installed_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(mod_key, lang_code)
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add_file_hashes_to_installed_workshop_mods",
            sql: "ALTER TABLE installed_workshop_mods ADD COLUMN file_hashes TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "create_liked_workshop_mods_cache",
            sql: "CREATE TABLE IF NOT EXISTS liked_workshop_mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_id INTEGER NOT NULL UNIQUE,
                mod_key TEXT DEFAULT '',
                display_name TEXT DEFAULT '',
                description TEXT DEFAULT '',
                category TEXT DEFAULT '',
                author_id INTEGER DEFAULT 0,
                author_name TEXT DEFAULT '',
                author_avatar TEXT DEFAULT '',
                download_count INTEGER DEFAULT 0,
                like_count INTEGER DEFAULT 0,
                is_liked INTEGER DEFAULT 1,
                comment_count INTEGER DEFAULT 0,
                files TEXT DEFAULT '',
                translations TEXT DEFAULT '',
                created_at TEXT DEFAULT '',
                updated_at TEXT DEFAULT '',
                cached_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "create_rated_workshop_mods_cache",
            sql: "CREATE TABLE IF NOT EXISTS rated_workshop_mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_id INTEGER NOT NULL UNIQUE,
                mod_key TEXT DEFAULT '',
                my_rating REAL DEFAULT 0,
                rating_avg REAL DEFAULT 0,
                rating_count INTEGER DEFAULT 0,
                cached_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "add_full_snapshot_to_rated_workshop_mods",
            sql: "ALTER TABLE rated_workshop_mods ADD COLUMN display_name TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN description TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN category TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN author_id INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN author_name TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN author_avatar TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN download_count INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN like_count INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN is_liked INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN comment_count INTEGER DEFAULT 0;
            ALTER TABLE rated_workshop_mods ADD COLUMN files TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN translations TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN created_at TEXT DEFAULT '';
            ALTER TABLE rated_workshop_mods ADD COLUMN updated_at TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "create_subscription_tasks",
            sql: "CREATE TABLE IF NOT EXISTS subscription_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_key TEXT NOT NULL,
                mod_id INTEGER DEFAULT 0,
                category TEXT DEFAULT '',
                lang_code TEXT DEFAULT '',
                version TEXT DEFAULT '',
                file_url TEXT NOT NULL,
                file_hash TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                percent INTEGER DEFAULT 0,
                stage TEXT DEFAULT '',
                error TEXT DEFAULT '',
                target_dir TEXT DEFAULT '',
                manifest TEXT DEFAULT '',
                retry_of INTEGER DEFAULT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT DEFAULT ''
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "add_subscription_tasks_meta_cols",
            // 订阅时冗余存一份工坊卡片的展示信息，让订阅记录页离线也能显示文件名+简介，
            // 与工坊/任务文件夹卡片语义一致；避免每条任务进页都回查 MySQL。
            sql: "ALTER TABLE subscription_tasks ADD COLUMN display_name TEXT DEFAULT '';
                ALTER TABLE subscription_tasks ADD COLUMN description TEXT DEFAULT '';
                ALTER TABLE subscription_tasks ADD COLUMN translations TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "create_bepinex_tasks",
            // BepInEx 前置一键安装的后台任务表：与 subscription_tasks 同款持久化，
            // 让 Rust 后台下载不依赖前端生命周期，重启可恢复进度/错误。
            sql: "CREATE TABLE IF NOT EXISTS bepinex_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                percent INTEGER DEFAULT 0,
                stage TEXT DEFAULT '',
                error TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT DEFAULT ''
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "create_update_tasks",
            // 应用自更新安装包下载的后台任务表：与 subscription_tasks / bepinex_tasks
            // 同款持久化，让 Rust 后台下载不依赖前端生命周期，离开设置页/重启后
            // 通过 db_get_update_status 查询恢复进度/错误/已就绪。
            sql: "CREATE TABLE IF NOT EXISTS update_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                percent INTEGER DEFAULT 0,
                stage TEXT DEFAULT '',
                error TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT DEFAULT ''
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "create_save_backups",
            // 存档备份校验表：备份存档时录入源存档的大小/修改时间/hash，
            // 还原时三项逐一比对一致才允许还原（防止备份文件被篡改/损坏后误还原）。
            sql: "CREATE TABLE IF NOT EXISTS save_backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                backup_name TEXT NOT NULL UNIQUE,
                src_name TEXT NOT NULL,
                size INTEGER DEFAULT 0,
                modified TEXT DEFAULT '',
                hash TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "add_version_to_update_tasks",
            // 记录下载任务对应的目标版本：静默自动更新时，前端据此判断 ready 安装包
            // 是否仍对应当前最新版（避免把过期/残留的旧版安装包自动提升为待应用，
            // 也避免对其他渠道下载的旧版安装包重复覆盖）。旧行默认空串，视为未知。
            sql: "ALTER TABLE update_tasks ADD COLUMN version TEXT DEFAULT ''",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "add_size_cols_to_bepinex_tasks",
            // BepInEx 前置下载任务记录已下载/总大小（字节），配合 db/download.rs 共享引擎
            // 的进度上报（downloaded/total/speed），前端可显示"已下载 X / Y · 速度"。
            sql: "ALTER TABLE bepinex_tasks ADD COLUMN downloaded INTEGER DEFAULT 0;
                  ALTER TABLE bepinex_tasks ADD COLUMN total INTEGER DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "add_size_cols_to_update_tasks",
            // 程序更新下载任务记录已下载/总大小（字节），与 bepinex_tasks(migration 17) 同款：
            // 配合 db/download.rs 共享引擎的进度上报（downloaded/total/speed），前端设置页
            // 可像 BepInEx 前置一样显示"已下载 X / Y · 速度"，离开页面再回来也能恢复。
            sql: "ALTER TABLE update_tasks ADD COLUMN downloaded INTEGER DEFAULT 0;
                  ALTER TABLE update_tasks ADD COLUMN total INTEGER DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "create_request_cache",
            // 工坊云/讨论区只读查询的 SQLite 本地缓存：断连时仍可浏览看过的历史内容。
            // payload 是后端返回的完整 JSON（DTO 原样），cache_key = 命令名 + 排序后参数。
            // 由前端负责写入/清理（按 UTF-8 字节预算淘汰），Rust 侧只管建表。
            sql: "CREATE TABLE IF NOT EXISTS request_cache (
                cache_key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                cached_at INTEGER NOT NULL
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "create_user_notifications_cache",
            // 评论/回复/点赞通知的 SQLite 本地缓存：远程库连接数打满时仍能查看历史通知。
            // 按 (user_id, entity, notif_id) 唯一，前端拉取成功后按页 upsert 合并，
            // 标记已读时同步回写缓存，失败时回退展示。
            sql: "CREATE TABLE IF NOT EXISTS user_notifications_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                entity TEXT NOT NULL DEFAULT 'mod',
                notif_id INTEGER NOT NULL,
                type TEXT DEFAULT '',
                target_id INTEGER DEFAULT 0,
                comment_id INTEGER DEFAULT 0,
                is_read INTEGER DEFAULT 0,
                created_at TEXT DEFAULT '',
                content TEXT DEFAULT '',
                display_key TEXT DEFAULT '',
                author_id INTEGER DEFAULT 0,
                author_name TEXT DEFAULT '',
                author_avatar TEXT DEFAULT '',
                cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, entity, notif_id)
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "add_recipient_role_to_notifications_cache",
            // 收件人相对该条内容的身份（作者/协作者/层主），与远程库 db_get_my_notifications
            // 返回的 is_author/is_collab/is_parent_author 一并缓存，回退展示时文案仍能按角色区分
            sql: "ALTER TABLE user_notifications_cache ADD COLUMN is_author INTEGER DEFAULT 0;
            ALTER TABLE user_notifications_cache ADD COLUMN is_collab INTEGER DEFAULT 0;
            ALTER TABLE user_notifications_cache ADD COLUMN is_parent_author INTEGER DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "create_request_cache_entities",
            // 列表/详情快照里出现过的 mod/讨论实体索引：通知跳转时按实体定位 cache_key，
            // 避免为了补详情而 JSON.parse 所有列表快照。行随 request_cache 清理一起删除。
            sql: "CREATE TABLE IF NOT EXISTS request_cache_entities (
                cache_key TEXT NOT NULL,
                command TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER NOT NULL DEFAULT 0,
                entity_key TEXT NOT NULL DEFAULT '',
                cached_at INTEGER NOT NULL,
                PRIMARY KEY (cache_key, entity_type, entity_id, entity_key)
            );
            CREATE INDEX IF NOT EXISTS idx_request_cache_entities_lookup
            ON request_cache_entities (entity_type, entity_id, entity_key);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 23,
            description: "rebuild_rated_workshop_mods_with_user_id",
            // 评分记录缓存按账号归属：换账号后不能把上一个账号的评分当作本人评分
            // （离线详情回退的 my_rating 也读这张表）。原表 mod_id 上是 UNIQUE，
            // 两个账号评同一个 mod 会互相覆盖，故重建为 UNIQUE(mod_id, user_id)。
            // 纯缓存数据，直接重建；前端也会按版本号清空一次。
            // 注意：本迁移开发期曾以草稿形式（description = add_user_id_to_rated_workshop_mods，
            // SQL 仅 ALTER TABLE ADD COLUMN user_id）落到过本地开发库；sqlx 会因校验和不匹配
            // 拒绝启动，因此启动时先由 repair_legacy_sqlite_migrations 清掉那条草稿记录，
            // 让本迁移重新执行。已应用的迁移不可再改 SQL，否则同样会启动失败。
            sql: "DROP TABLE IF EXISTS rated_workshop_mods;
            CREATE TABLE rated_workshop_mods (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mod_id INTEGER NOT NULL,
                mod_key TEXT DEFAULT '',
                my_rating REAL DEFAULT 0,
                rating_avg REAL DEFAULT 0,
                rating_count INTEGER DEFAULT 0,
                cached_at TEXT DEFAULT CURRENT_TIMESTAMP,
                display_name TEXT DEFAULT '',
                description TEXT DEFAULT '',
                category TEXT DEFAULT '',
                author_id INTEGER DEFAULT 0,
                author_name TEXT DEFAULT '',
                author_avatar TEXT DEFAULT '',
                download_count INTEGER DEFAULT 0,
                like_count INTEGER DEFAULT 0,
                is_liked INTEGER DEFAULT 0,
                comment_count INTEGER DEFAULT 0,
                files TEXT DEFAULT '',
                translations TEXT DEFAULT '',
                created_at TEXT DEFAULT '',
                updated_at TEXT DEFAULT '',
                user_id INTEGER NOT NULL DEFAULT 0,
                UNIQUE (mod_id, user_id)
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 24,
            description: "add_entity_key_index",
            // 按 mod_key 定位时（复合索引里 entity_key 是第三列）用不上原索引，
            // 补一个 (entity_type, entity_key) 前缀索引；前端 ensureEntityTable 也会兜底创建。
            sql: "CREATE INDEX IF NOT EXISTS idx_request_cache_entities_key
            ON request_cache_entities (entity_type, entity_key);",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 25,
            description: "create_announcement_reads",
            // 只记录已读/已展示的公告 ID；按设备记录，同一台电脑换账号共享。
            sql: "CREATE TABLE IF NOT EXISTS announcement_reads (
                announcement_id INTEGER PRIMARY KEY,
                read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 26,
            description: "create_legacy_accounts",
            // 0.3.x → 1.0.x 升级时本地只留有 user_id/username，没有服务端令牌。
            // 1.0 启动时会在清理旧登录态前把账号落到这张表，供「旧版账号」弹窗恢复。
            sql: "CREATE TABLE IF NOT EXISTS legacy_accounts (
                user_id INTEGER PRIMARY KEY,
                username TEXT NOT NULL,
                avatar TEXT DEFAULT '',
                r2_enabled INTEGER DEFAULT 0,
                detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
    ]
}

/// 清理开发期遗留的 SQLite 迁移记录（必须在 tauri-plugin-sql 初始化之前执行）。
///
/// migration 23 开发过程中曾以草稿形式落到本地库：`ALTER TABLE rated_workshop_mods
/// ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;`（description 为
/// add_user_id_to_rated_workshop_mods）。正式提交时该迁移被改成了「重建表」，而 sqlx
/// 会记录每条迁移 SQL 的校验和，一旦发现「已应用但内容被改过」就直接报错：
/// `migration 23 was previously applied but has been modified`。
///
/// 由于 tauri.conf.json 用 `plugins.sql.preload` 在 sql 插件 setup 阶段执行迁移，
/// 这个错误会让整个 App 构建失败：表现为启动后没有窗口、进程退出码 101。
///
/// 草稿只存在于开发机（从未随发布版下发），所以这里删掉那条记录，让正式版
/// migration 23 重新执行——它本身是 DROP + CREATE rated_workshop_mods，该表是
/// 纯缓存，无数据损失。仅当记录的 checksum 与草稿 SQL 完全一致时才删除，
/// 避免误伤已经应用了正式版 migration 23 的库。
pub fn repair_legacy_sqlite_migrations(app: &tauri::AppHandle) {
    const LEGACY_M23_SQL: &str =
        "ALTER TABLE rated_workshop_mods ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;";

    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let path = dir.join("config.db");
    if !path.is_file() {
        return;
    }
    let Ok(conn) = rusqlite::Connection::open(&path) else {
        return;
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));

    // 还没执行过任何迁移（没有 _sqlx_migrations 表）时无需处理
    let has_migrations_table = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some();
    if !has_migrations_table {
        return;
    }

    let applied: Option<Vec<u8>> = conn
        .query_row(
            "SELECT checksum FROM _sqlx_migrations WHERE version = 23",
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    let expected = Sha384::digest(LEGACY_M23_SQL.as_bytes());
    if applied.as_deref() != Some(expected.as_slice()) {
        return;
    }

    match conn.execute("DELETE FROM _sqlx_migrations WHERE version = 23", []) {
        Ok(_) => {
            eprintln!("[sqlite] 已删除草稿 migration 23 记录，正式版将重建 rated_workshop_mods")
        }
        Err(e) => eprintln!("[sqlite] 删除草稿 migration 23 记录失败: {e}"),
    }
}
