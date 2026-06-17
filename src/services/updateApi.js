/**
 * 更新检查 API 服务
 * 从 sfm-cloud 的 /api/admin/version 接口获取最新版本
 */

const API_BASE = import.meta.env.DEV
  ? 'http://localhost:3000'
  : 'https://sfm.b9349.dpdns.org'

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
 * 从 sfm-cloud 获取最新版本信息
 */
export async function checkForUpdates() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/version`)
    const data = await res.json()
    if (data.success && data.data) {
      return data.data  // { version, update_url, updated_at }
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
