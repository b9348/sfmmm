/**
 * 后台任务错误代码 → i18n 文案映射。
 * Rust 数据层抛出稳定错误代码（如 GAME_DIR_INVALID），前端统一在此映射为本地化文案；
 * 非代码的普通错误原样返回。
 */
export function localizeError(t, error) {
  if (error === 'GAME_DIR_INVALID') return t('subscriptions.gameDirInvalid')
  return error
}
