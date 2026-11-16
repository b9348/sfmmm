/**
 * 后台任务错误代码 → i18n 文案映射。
 * Rust 数据层抛出稳定错误代码（如 GAME_DIR_INVALID），前端统一在此映射为本地化文案；
 * 非代码的普通错误原样返回。
 */
export function localizeError(t, error) {
  if (error === 'GAME_DIR_INVALID') return t('subscriptions.gameDirInvalid')
  // 补丁发布版本号字符集不合法（会拼进远端对象路径），Rust 侧返回稳定错误码
  if (error === 'VERSION_INVALID') return t('workshop.patchVersionInvalid')
  // 后端拒绝发布空文件清单（作者可能把条目全部删除）
  if (error === 'EMPTY_MANIFEST') return t('workshop.patchEmptyManifestRejected')
  // 草稿快照落后于工作区：工作区有新检出的变化条目，前端草稿没见过
  if (typeof error === 'string' && error.startsWith('DRAFT_STALE')) {
    return t('workshop.patchDraftStale')
  }
  return error
}
