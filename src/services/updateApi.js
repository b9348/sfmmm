/**
 * 更新检查与自动安装
 */

import { invoke } from '@tauri-apps/api/core'

// 版本清单固定 URL（图床公开文件，CI 发版时删旧传新维护；无需认证）
// 构建时通过环境变量注入，例如：VITE_LATEST_URL=https://img.b9349.dpdns.org/file/sfm/installer/latest.json
const LATEST_URL = import.meta.env.VITE_LATEST_URL

export function compareVersions(a, b) {
  const cleanA = a.replace(/^v/i, '')
  const cleanB = b.replace(/^v/i, '')
  const partsA = cleanA.split('.').map(Number)
  const partsB = cleanB.split('.').map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const va = partsA[i] || 0
    const vb = partsB[i] || 0
    if (va !== vb) return va - vb
  }
  return 0
}

/**
 * 检测新版本
 */
export async function checkForUpdates() {
  // 本地开发时跳过更新检测（无后端服务，避免请求报错）
  if (import.meta.env.DEV) {
    return null
  }
  // 优先走 Rust reqwest 拉取（无 HTTP 缓存，规避 WebView 对图床文件的强缓存）
  try {
    const res = await invoke('db_fetch_latest', { url: LATEST_URL })
    if (res && res.success && res.data && res.data.version) {
      return res.data
    }
  } catch (e) {
    console.warn('[Update] Rust 检测失败，回退前端 fetch:', e)
  }
  // 回退：前端 fetch 强制 no-store 绕过缓存
  try {
    const res = await fetch(LATEST_URL, { cache: 'no-store' })
    if (!res.ok) {
      // 404 等异常响应视为无更新
      return null
    }
    const data = await res.json()
    if (data && data.version) {
      return data
    }
    return null
  } catch (e) {
    console.warn('[Update] 检测更新失败:', e.message)
    return null
  }
}

/**
 * 检测是否有新版本
 */
export async function checkVersion(currentVersion) {
  const latest = await checkForUpdates()
  if (!latest) {
    return { hasUpdate: false, latestVersion: null, updateUrl: null }
  }
  const hasUpdate = compareVersions(latest.version, currentVersion) > 0
  return {
    hasUpdate,
    latestVersion: latest.version,
    updateUrl: latest.update_url,
  }
}

/**
 * 创建更新安装包下载后台任务并立即返回（下载在 Rust 后台执行，
 * 离开设置页/切换标签不中断，进度由全局事件 "update-progress" 广播，
 * 状态用 getUpdateStatus() 查询恢复）。
 * @param {string} url - 安装包下载地址
 * @returns {Promise<{taskId: number}>}
 */
export async function prepareUpdate(url) {
  return await invoke('db_prepare_update', { url })
}

/**
 * 查询最近一次更新下载任务状态（设置页挂载时恢复进度/错误/已就绪）
 * @returns {Promise<{id, status, percent, stage, error} | null>}
 */
export async function getUpdateStatus() {
  return await invoke('db_get_update_status')
}

/**
 * 启动已下载的安装包并退出当前应用
 */
export async function applyUpdate() {
  return await invoke('db_apply_update')
}
