//! 编辑页「选择性替换压缩包内文件」最小实现（P1）。
//!
//! 边界（刻意不做的事）：
//! - 只允许替换 zip 中**已存在**的条目，路径不变；不支持新增/删除/改路径。
//! - 发布仍是整包重新打包上传，不存在服务端文件级增量。
//! - 未替换条目用 `raw_copy_file_rename` 原样透传（数据与元信息不重压缩）。
//! - manifest 原样保留；仅当它与最终 zip 的文件集合不一致时才按 zip 重建。
//! - `file_hashes` 从最终 zip 重新计算（含嵌套 zip 递归，口径与前端
//!   `computeZipFileHashes` 一致：basename 键 + 安装根相对路径键双写，
//!   旧客户端仍按 basename 查询，新客户端用路径键区分同名不同目录）。
//! - 内容未变化时发布按幂等成功处理；内容变化则必须提升版本。
//! - 保存采用「上传 → 事务条件更新（file_hash 乐观锁）→ 删旧对象」的补偿流程。
//!   下载与上传期间不持有数据库连接。
//!
//! 工作区落在 `app_data_dir/edit_workspaces/<workspace_id>/`，包含：
//! `base.zip`（原包）、`staging/`（替换文件）、`package.zip`（打好的新包）、
//! `workspace.json`（元数据，即「本地草稿」）。7 天 TTL + 2GiB 总配额。
//!
//! 模块地图：meta 结构体底座 / workspace 锁与清理 / base 底包缓存 /
//! manifest 路径归一 / local_import 本地导入 / staging 暂存 / build 打包 /
//! publish 发布 / commands 薄壳命令。

mod base;
mod build;
mod commands;
mod local_import;
mod manifest;
mod meta;
mod publish;
mod staging;
mod workspace;

// 命令与发布：pub 上浮，db::mod_edit_* 与 lib.rs 注册继续成立
pub use commands::*;
pub use publish::*;

// 跨域与 tests 用的项：pub(crate) 上浮（cap 在 crate 内，不经 db:: 泄漏出 crate）
pub(crate) use base::*;
pub(crate) use build::*;
pub(crate) use local_import::*;
pub(crate) use manifest::*;
pub(crate) use meta::*;
pub(crate) use staging::*;
pub(crate) use workspace::*;

// 现状即 pub 的非命令项，显式 re-export 保持可见性逐位不变
pub use staging::{DraftFile, DraftSegments};
pub use workspace::prune_edit_workspaces;

#[cfg(test)]
mod tests;
