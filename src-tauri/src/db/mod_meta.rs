use mysql::prelude::*;
use mysql::*;

// ── 幂等 schema 兜底（兼容旧库/服务端未迁移）──────────────────────

/// 幂等确保 mods 含 is_original 列（原创标，兼容旧库/服务端未迁移）。
/// 已存在时忽略 "Duplicate column" 错误；其余错误向上传播。
///
/// 注意：`SELECT m.is_original` 在列不存在时会直接报 "Unknown column"（并非返回 NULL），
/// COALESCE 兜不住，所以所有读写该列的入口都必须先执行本函数。
pub(crate) fn ensure_mod_is_original_column<C: Queryable>(conn: &mut C) -> Result<(), String> {
    match conn.exec_drop(
        "ALTER TABLE mods ADD COLUMN is_original TINYINT(1) NOT NULL DEFAULT 0",
        (),
    ) {
        Ok(_) => {}
        Err(e) => {
            let msg = e.to_string();
            if msg.to_lowercase().contains("duplicate column") {
                return Ok(());
            }
            return Err(format!("无法确保 mods.is_original 列: {}", msg));
        }
    }
    Ok(())
}
