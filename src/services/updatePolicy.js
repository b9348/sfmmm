/**
 * 静默自动更新的纯决策函数（无副作用，可单测）。
 * App.jsx 启动编排与全局监听共用，保证各路径门禁一致。
 */

// 静默自动更新失败退避时长（24h）：自动下载/自动应用连续失败后，此期间内
// 不再自动发起下载/提升待应用，避免更新源不可达或安装反复失败时每次启动都重试
export const AUTO_UPDATE_BACKOFF_MS = 24 * 60 * 60 * 1000

/**
 * 失败退避判定：最近失败时间戳距今 < 24h 视为退避中，不自动发起下载/应用
 * @param {string} failAtStr - config 中记录的失败 ISO 时间戳（空串/undefined = 无失败记录）
 * @param {number} now - 当前时间戳（测试可注入）
 * @returns {boolean} 是否处于退避窗口
 */
export function isInBackoff(failAtStr, now = Date.now()) {
  const failAt = failAtStr ? Date.parse(failAtStr) : 0
  return !!failAt && now - failAt < AUTO_UPDATE_BACKOFF_MS
}

/**
 * 自动应用资格判定（版本门禁）：任务就绪 + 安装包确实在盘上 + 记录版本
 * === 当前最新版才允许自动应用/提升待应用。
 * 空版本（migration 16 遗留行）或版本不符（陈旧/其他渠道旧版）一律不通过，
 * 防止静默安装旧构建。
 * @param {object|null} st - db_get_update_status 返回的任务状态行
 * @param {string} latestVersion - 当前最新版本号
 * @returns {boolean}
 */
export function canAutoApply(st, latestVersion) {
  return !!(
    st &&
    st.status === 'ready' &&
    st.installerExists &&
    st.version &&
    st.version === latestVersion
  )
}

/**
 * 是否应重新下载当前最新版（canAutoApply 的取反语义，含"版本未知/不符/文件缺失/
 * 任务失败/无任务"），App.jsx 自动下载分支据此决定 prepareUpdate
 * @param {object|null} st - 任务状态行
 * @param {string} latestVersion - 当前最新版本号
 * @returns {boolean}
 */
export function shouldDownload(st, latestVersion) {
  return !canAutoApply(st, latestVersion)
}
