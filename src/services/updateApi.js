/**
 * 更新检查与自动安装
 */

import { invoke, Channel } from '@tauri-apps/api/core'

const API_BASE = import.meta.env.DEV
  ? 'http://localhost:3000'
  : 'https://sfm.b9349.dpdns.org'

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
  try {
    const res = await fetch(`${API_BASE}/api/admin/version`)
    const data = await res.json()
    if (data.success && data.data) {
      return data.data
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
