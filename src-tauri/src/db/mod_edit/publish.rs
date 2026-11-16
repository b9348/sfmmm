//! 发布：上传（幂等复用）、事务条件更新、删旧对象与重试补偿。

use super::*;

use std::fs;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;

use crate::db::image::{upload_file_streaming, ProgressFn as UploadProgressFn};
use crate::db::{semver_cmp, ApiResponse};

const MAX_ZIP_SIZE: u64 = 20 * 1024 * 1024;
const PROGRESS_EVENT: &str = "mod-edit-publish-progress";

/// 发布失败时的自动重试次数上限（不含首次尝试）与退避基数。
/// 只对「数据库暂时不可用」类错误重试；权限/版本冲突/内容非法不重试。
const PUBLISH_RETRY_MAX: u8 = 3;
const PUBLISH_RETRY_BASE_MS: u64 = 600;

/// 本次发布的幂等标识：同一工作区 + 同一新包内容始终得到同一 op_id，
/// 重试或重新点保存都能据此复用已上传的 staging 对象。
pub(crate) fn publish_op_id(workspace_id: &str, file_hash: &str) -> String {
    let mut h = Sha256::new();
    h.update(workspace_id.as_bytes());
    h.update(b":");
    h.update(file_hash.as_bytes());
    hex::encode(h.finalize())
}

/// 可重试判定：只认「连接/服务端暂时不可用」，不认业务性失败。
/// - POOL_BUSY / QUEUE_TIMEOUT / QUERY_TIMEOUT：本地串行池忙或等待超时
/// - TOO_MANY_CONNECTIONS：云端 30 连接上限挤掉
/// - NETWORK：连接被服务端断开、网络读写中断
/// - DEADLOCK：服务器死锁（1213）
pub(crate) fn is_retryable_publish_error(e: &str) -> bool {
    ["POOL_BUSY", "QUEUE_TIMEOUT", "QUERY_TIMEOUT", "TOO_MANY_CONNECTIONS", "NETWORK", "DEADLOCK"]
        .iter()
        .any(|code| e.contains(&format!("[DBERR:{code}]")))
}

/// 事务内错误统一带上可判别前缀（服务端已经分类；这里保留常量给旧逻辑）。
fn publish_call_error(e: String) -> String {
    e
}

/// 删除服务端存储的文件（失败只记日志，不阻断发布补偿流程）。
async fn delete_remote_file(file_url: &str) {
    let _ = crate::api::rpc_raw(
        "db_delete_imgbed_file",
        serde_json::json!({ "file_url": file_url }),
    )
    .await;
}

/// 调用一次服务端事务提交，并把业务失败转成 Err。
async fn call_commit(command: &str, args: serde_json::Value) -> Result<(), String> {
    match crate::api::rpc_command(command, args).await {
        Ok(resp) if resp.success => Ok(()),
        Ok(resp) => Err(publish_call_error(resp.message)),
        Err(e) => Err(publish_call_error(e)),
    }
}

/// 重试间隔递增：600ms → 1.2s（第 3 次尝试前），不无限拉长。
fn publish_retry_backoff(failed_attempt: u8) -> Duration {
    let factor = 1u64 << u64::from(failed_attempt.saturating_sub(1).min(4));
    Duration::from_millis(PUBLISH_RETRY_BASE_MS * factor)
}

fn emit_publish_retry(app: &tauri::AppHandle, workspace_id: &str, attempt: u8, err: &str) {
    log::warn!(
        "[mod_edit] 发布期间数据库暂时不可用，第 {}/{} 次尝试失败，准备重试: {}",
        attempt,
        PUBLISH_RETRY_MAX,
        err
    );
    let _ = app.emit(
        PROGRESS_EVENT,
        PublishProgress {
            workspace_id: workspace_id.to_string(),
            stage: "retrying".into(),
            loaded: u64::from(attempt),
            total: u64::from(PUBLISH_RETRY_MAX),
            attempt,
            max_attempts: PUBLISH_RETRY_MAX,
        },
    );
}

#[derive(Clone, Serialize)]
struct PublishProgress {
    workspace_id: String,
    stage: String,
    loaded: u64,
    total: u64,
    /// stage=retrying 时的当前尝试序号与上限，前端据此显示 (n/3)
    #[serde(default)]
    attempt: u8,
    #[serde(default)]
    max_attempts: u8,
}

/// 发布整包：先上传到唯一 staging 目录，再事务条件更新；
/// 失败按原因删除新对象（超时类错误除外：后台可能已提交，宁可留下孤儿对象
/// 也不能让 DB 指向一个已被删掉的文件）。
#[tauri::command(rename_all = "snake_case")]
pub async fn mod_edit_publish_package(
    app: tauri::AppHandle,
    workspace_id: String,
    author_id: u64,
    version: String,
    force: Option<bool>,
) -> Result<ApiResponse, String> {
    if !is_valid_workspace_id(&workspace_id) {
        return Err("工作区标识无效".to_string());
    }
    let dir = workspace_root(&app)?.join(&workspace_id);
    if !dir.is_dir() {
        return Err("工作区不存在或已过期，请重新打开".to_string());
    }
    // 发布也走工作区锁：API 层与 stage/unstage/build/discard 互斥，避免上传期间
    // 草稿被改写或删除。上传耗时较长，UI 本身也是串行操作，可以接受。
    let _guard = lock_workspace(&workspace_id).await;
    let mut meta = load_meta(&dir)?;
    if meta.user_id != author_id {
        return Err("工作区不属于当前用户，请重新打开".to_string());
    }
    let built = meta
        .built
        .clone()
        .ok_or_else(|| "请先打包预览，再发布".to_string())?;

    // 发布端兜底：构建产物记录的 mod 类型必须与工作区当前类型一致。
    // 改类型后若没有重新构建，旧产物是按旧类型的条目归一/落盘规则生成的，
    // 直接发布会让清单和安装端按新类型平铺的结果对不上。
    if !built.category.is_empty() && built.category != meta.category {
        return Err("文件类型已变更，请重新打包后再发布".to_string());
    }

    // 后端第二道空清单拦截：即使前端按钮被绕过，也不能发布「没有任何文件」的包。
    // manifest 可能含目录条目，按文件条目口径统计。
    let built_files = normalized_manifest_files(&built.manifest, &meta.category, &meta.mod_key)?;
    if built_files.is_empty() {
        return Err("EMPTY_MANIFEST".to_string());
    }

    // 版本号只在内容有变化时参与远端对象路径；此时先做字符收敛，
    // 避免 semver_cmp 放行 `1.0.1/../x` 之类的值被原样拼进 CDN 目录。
    if built.changed && !is_valid_version(&version) {
        return Err("VERSION_INVALID".to_string());
    }

    // 先做权限 / 版本校验，再决定是否删除工作区：避免未授权或版本非法时
    // 幂等分支已经把草稿删掉。权限校验由服务端执行。
    if !force.unwrap_or(false) {
        let pre_mod_id = meta.mod_id;
        let pre_user = author_id;
        let pre_lang = meta.lang_code.clone();
        let mut attempt = 0u8;
        let allowed = loop {
            attempt += 1;
            match crate::api::rpc_data::<serde_json::Value>(
                "db_check_lang_edit",
                serde_json::json!({
                    "mod_id": pre_mod_id,
                    "author_id": pre_user,
                    "lang_code": pre_lang,
                    "force": false,
                }),
            )
            .await
            {
                Ok(v) => break v.get("allowed").and_then(|b| b.as_bool()).unwrap_or(false),
                Err(e) => {
                    if !is_retryable_publish_error(&e) || attempt > PUBLISH_RETRY_MAX {
                        return Err(format!("校验编辑权限失败: {e}"));
                    }
                    emit_publish_retry(&app, &workspace_id, attempt, &e);
                    tokio::time::sleep(publish_retry_backoff(attempt)).await;
                }
            }
        };
        if !allowed {
            return Err("没有该语言的文件编辑权限".to_string());
        }
    }
    if built.changed && semver_cmp(&version, &meta.base_version) <= 0 {
        return Err(format!(
            "内容有变化，版本必须高于当前版本 v{}",
            meta.base_version
        ));
    }

    // 发布端再校验一次「底包条目是否已归一」：构建产物可能来自旧版代码/旧工作区，
    // 不能只信 `built` 里的标志。以打开或下载底包时按原始条目名持久化的事实为准；
    // 未知（None）或未归一（false）一律走重打包，绝不允许只改清单。
    let base_paths_normalized =
        built.base_paths_normalized && meta.base_paths_normalized == Some(true);

    // 仅清单需要纠正（例如旧数据把目录条目写进了 manifest）：文件内容与库里
    // 完全一致，不重新上传、不要求提升版本，只按 file_hash 乐观锁条件更新清单。
    // 前提是底包条目名本身已经归一：若底包还是历史前缀（`BepInEx/plugins/x`），
    // 单独把归一后的清单写回会让「云端清单」和「实际包内条目」脱节
    // （安装端按清单检查落点会查不到真实文件），这种情况必须走下面的重打包路径。
    if !built.changed && built.manifest_dirty && base_paths_normalized {
        let mod_id = meta.mod_id;
        let lang = meta.lang_code.clone();
        let base_hash = meta.base_file_hash.clone();
        let force = force.unwrap_or(false);
        let mut attempt = 0u8;
        let commit: Result<(), String> = loop {
            attempt += 1;
            let r = call_commit(
                "db_publish_commit_manifest",
                serde_json::json!({
                    "mod_id": mod_id,
                    "author_id": author_id,
                    "lang_code": lang.clone(),
                    "manifest": built.manifest.clone(),
                    "expected_file_hash": base_hash.clone(),
                    "force": force,
                }),
            )
            .await;
            match r {
                Ok(()) => break Ok(()),
                Err(e) => {
                    if is_retryable_publish_error(&e) && attempt <= PUBLISH_RETRY_MAX {
                        emit_publish_retry(&app, &workspace_id, attempt, &e);
                        tokio::time::sleep(publish_retry_backoff(attempt)).await;
                        continue;
                    }
                    break Err(e);
                }
            }
        };
        commit?;
        let _ = fs::remove_dir_all(&dir);
        return Ok(ApiResponse::ok_val(
            serde_json::json!({
                "idempotent": true,
                "changed": false,
                // 本次没有重新上传对象，只纠正了文件清单
                "manifestFixed": true,
                "lang_code": meta.lang_code,
                "file_url": meta.base_file_url,
                "file_name": meta.base_file_name,
                "file_size": meta.base_size,
                "file_hash": meta.base_file_hash,
                "version": meta.base_version,
                "manifest": built.manifest,
                "file_hashes": meta.base_file_hashes,
            }),
            "文件清单已归一，未重新上传",
        ));
    }

    // 内容未变化且底包条目名已归一：按幂等成功处理，不产生新对象、也不改版本；
    // 工作区一并清理。调用方必须据 idempotent=true 向用户明确提示「版本不会更新」，
    // 不能静默处理。
    // 底包条目未归一时不能在这里停下：否则历史前缀包会永远保持旧形态，
    // 继续走下面的上传路径把同一批文件按归一后的条目名重打一次并同步更新清单。
    if !built.changed && base_paths_normalized {
        let _ = fs::remove_dir_all(&dir);
        return Ok(ApiResponse::ok_val(
            serde_json::json!({
                "idempotent": true,
                "changed": false,
                "lang_code": meta.lang_code,
                "file_url": meta.base_file_url,
                "file_name": meta.base_file_name,
                "file_size": meta.base_size,
                "file_hash": meta.base_file_hash,
                "version": meta.base_version,
                "manifest": meta.manifest,
                "file_hashes": meta.base_file_hashes,
            }),
            "内容未变化，已按幂等成功处理",
        ));
    }

    // 上传前确认 package.zip 与打包记录一致，避免并发替换/外部改动导致 DB 记录错 hash
    let package_path = dir.join("package.zip");
    let built_for_verify = built.clone();
    let package_for_verify = package_path.clone();
    tokio::task::spawn_blocking(move || verify_built_package(&package_for_verify, &built_for_verify))
        .await
        .map_err(|e| format!("校验打包文件任务失败: {e}"))??;

    // 新包统一走服务端 Telegram 图床；`channel` 仅为兼容旧上传参数保留。
    let channel = "telegram";
    if built.file_size > MAX_ZIP_SIZE {
        return Err(format!(
            "新压缩包超过 {}MB 限制",
            MAX_ZIP_SIZE / 1024 / 1024
        ));
    }

    // 远端对象路径里的版本：内容有变化时用作者填写的新版本；内容未变化
    // （仅因底包条目名未归一而重打包）必须落回基线版本，绝不能借重打包
    // 把版本悄悄改掉——最终写库的版本必须等于实际发布的版本。
    let effective_version = if built.changed {
        version.clone()
    } else {
        meta.base_version.clone()
    };

    // 本次发布的幂等标识：同一工作区 + 同一新包内容 → 同一 op_id 与同一对象路径。
    // 自动重试或重新点保存都不会产生第二份 staging 对象。
    let op_id = publish_op_id(&workspace_id, &built.file_hash);
    let folder = format!(
        "sfm/{}/{}/{}/op_{}",
        meta.mod_id, meta.lang_code, effective_version, op_id
    );

    // 上次发布已上传但未提交成功时，这里直接复用已有地址，跳过重复上传。
    let reusable = meta
        .pending_upload
        .as_ref()
        .filter(|p| {
            // 必须连版本目录一起匹配：提交阶段失败后作者可能改版本号再保存，
            // 此时 op_id/hash/size 都可能相同，但对象应该在新的版本目录下。
            p.op_id == op_id
                && p.file_hash == built.file_hash
                && p.file_size == built.file_size
                && p.folder == folder
                && !p.file_url.is_empty()
        })
        .cloned();

    let new_url = match reusable {
        Some(p) => {
            log::info!("[mod_edit] 复用已上传的发布产物（op_id={op_id}），跳过重复上传");
            p.file_url
        }
        None => {
            let app_for_progress = app.clone();
            let ws_for_progress = workspace_id.clone();
            let on_progress: UploadProgressFn = Arc::new(move |loaded, total| {
                let _ = app_for_progress.emit(
                    PROGRESS_EVENT,
                    PublishProgress {
                        workspace_id: ws_for_progress.clone(),
                        stage: "uploading".into(),
                        loaded,
                        total,
                        attempt: 0,
                        max_attempts: 0,
                    },
                );
            });

            let upload = upload_file_streaming(
                package_path.to_string_lossy().to_string(),
                built.file_name.clone(),
                folder.clone(),
                Some(channel.to_string()),
                None,
                Some(on_progress),
            )
            .await?;
            if !upload.success {
                return Err(upload.message);
            }
            let data = upload.data.ok_or_else(|| "上传返回缺少地址".to_string())?;
            let url = data
                .get("public_url")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| data.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
                .or_else(|| data.get("src").and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
                .ok_or_else(|| "上传返回缺少文件地址".to_string())?
                .to_string();
            // 上传成功即落盘登记：后续提交失败时，重新点保存可据此跳过上传
            meta.pending_upload = Some(PendingUploadMeta {
                op_id: op_id.clone(),
                file_hash: built.file_hash.clone(),
                file_name: built.file_name.clone(),
                file_size: built.file_size,
                file_url: url.clone(),
                folder: folder.clone(),
            });
            save_meta(&dir, &meta)?;
            url
        }
    };

    let _ = app.emit(
        PROGRESS_EVENT,
        PublishProgress {
            workspace_id: workspace_id.clone(),
            stage: "committing".into(),
            loaded: built.file_size,
            total: built.file_size,
            attempt: 0,
            max_attempts: 0,
        },
    );

    // ── 事务提交（由服务端执行） ──
    let mod_id = meta.mod_id;
    let lang = meta.lang_code.clone();
    let base_hash = meta.base_file_hash.clone();
    let file_hashes = built.file_hashes.clone();
    let file_size_i64 = built.file_size as i64;
    let file_hash = built.file_hash.clone();
    let ver = effective_version.clone();
    let force = force.unwrap_or(false);

    // 可重试错误（网络/服务端暂时不可用/死锁）按递增退避重试；
    // 上传产物沿用同一个 op_id 与同一个对象，重试不会重复上传。
    let mut attempt = 0u8;
    let commit: Result<(), String> = loop {
        attempt += 1;
        let r = call_commit(
            "db_publish_commit",
            serde_json::json!({
                "mod_id": mod_id,
                "author_id": author_id,
                "lang_code": lang.clone(),
                "file_url": new_url.clone(),
                "file_name": built.file_name.clone(),
                "file_size": file_size_i64,
                "file_hash": file_hash.clone(),
                "version": ver.clone(),
                "manifest": built.manifest.clone(),
                "file_hashes": file_hashes.clone(),
                "expected_file_hash": base_hash.clone(),
                "force": force,
            }),
        )
        .await;

        match r {
            Ok(()) => break Ok(()),
            // 上一次尝试已提交成功（只是响应丢了）：直接视为成功
            Err(e) if e.starts_with("[ALREADY_COMMITTED]") => break Ok(()),
            Err(e) => {
                if is_retryable_publish_error(&e) && attempt <= PUBLISH_RETRY_MAX {
                    emit_publish_retry(&app, &workspace_id, attempt, &e);
                    tokio::time::sleep(publish_retry_backoff(attempt)).await;
                    continue;
                }
                break Err(e);
            }
        }
    };

    match commit {
        Ok(()) => {
            // 旧对象由服务端在事务提交后 best-effort 删除（新存储/旧图床统一处理）
            let _ = fs::remove_dir_all(&dir);
            let _ = app.emit(
                PROGRESS_EVENT,
                PublishProgress {
                    workspace_id,
                    stage: "done".into(),
                    loaded: built.file_size,
                    total: built.file_size,
                    attempt: 0,
                    max_attempts: 0,
                },
            );
            Ok(ApiResponse::ok_val(
                serde_json::json!({
                    // 内容未变化、只为把历史包条目名归一而重打时，仍是一次幂等发布：
                    // 版本保持基线，调用方要提示作者「版本不会更新」。
                    "idempotent": !built.changed,
                    "changed": built.changed,
                    "repacked": !built.changed,
                    "manifestFixed": built.manifest_dirty,
                    "lang_code": meta.lang_code,
                    "file_url": new_url,
                    "file_name": built.file_name,
                    "file_size": built.file_size,
                    "file_hash": built.file_hash,
                    "version": effective_version,
                    "manifest": built.manifest,
                    "file_hashes": built.file_hashes,
                }),
                if built.changed {
                    "发布成功"
                } else {
                    "已按归一后的条目名重新打包，内容未变化"
                },
            ))
        }
        Err(e) => {
            // 权限/冲突属于确定性失败：上传的新对象可安全删除。
            // 网络/超时类错误下后台事务可能仍会提交，删对象反而会让 DB 指向空文件，
            // 因此保留孤儿对象并提示用户刷新确认。
            if e.starts_with("[FORBIDDEN]") || e.starts_with("[CONFLICT]") {
                let _ = delete_remote_file(&new_url).await;
                // 对象已删除：同步清掉待复用记录，避免下次点保存复用一个失效地址。
                // package.zip 与工作区保留，修正问题后仍可直接重试。
                meta.pending_upload = None;
                let _ = save_meta(&dir, &meta);
                return Err(e.trim_start_matches("[FORBIDDEN] ").trim_start_matches("[CONFLICT] ").to_string());
            }
            Err(format!("{e}（上传的整包已保留，请刷新确认文件记录后再决定是否清理）"))
        }
    }
}
