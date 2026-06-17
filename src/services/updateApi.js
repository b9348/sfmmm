/**
 * 更新检查 API 服务
 * 使用 Tauri updater 插件检测和安装更新
 */

import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

/**
 * 检测更新并自动安装
 * @param {boolean} autoInstall - 是否自动安装（静默）
 * @returns {{ hasUpdate: boolean, version: string|null }}
 */
export async function checkAndUpdate(autoInstall = true) {
  try {
    const update = await check()
    if (!update) {
      return { hasUpdate: false, version: null }
    }

    if (autoInstall) {
      await update.downloadAndInstall()
      await relaunch()
    }

    return { hasUpdate: true, version: update.version }
  } catch (e) {
    console.warn('[Update] 检测更新失败:', e?.message || e)
    return { hasUpdate: false, version: null }
  }
}

/**
 * 仅检测是否有新版本，不安装
 */
export async function checkForUpdates() {
  try {
    const update = await check()
    return update ? { version: update.version, update_url: '' } : null
  } catch {
    return null
  }
}

/**
 * 比较两个语义化版本号
 */
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
 * 检测是否有新版本（仅检查，兼容旧接口）
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
