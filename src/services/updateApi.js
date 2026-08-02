/**
 * 更新检查与自动安装
 */

import { invoke, Channel } from '@tauri-apps/api/core'

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
  try {
    const res = await fetch(LATEST_URL)
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
 * 下载更新安装包到本地（不立即安装），带进度回调
 * @param {string} url - 安装包下载地址
 * @param {function} onProgress - 进度回调 ({ percent: number, stage: string }) => void
 */
export async function prepareUpdate(url, onProgress) {
  const channel = new Channel((msg) => {
    onProgress?.(msg)
  })
  return await invoke('db_prepare_update', { url, onProgress: channel })
}

/**
 * 启动已下载的安装包并退出当前应用
 */
export async function applyUpdate() {
  return await invoke('db_apply_update')
}
