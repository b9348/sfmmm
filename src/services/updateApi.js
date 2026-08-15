/**
 * 更新检查与自动安装
 */

import { invoke } from '@tauri-apps/api/core'
import { setConfig } from './dbHelper'

// 版本清单固定 URL（图床公开文件，CI 发版时删旧传新维护；无需认证）
// 构建时通过环境变量注入，例如：VITE_LATEST_URL=https://img.b9349.dpdns.org/file/sfm/installer/latest.json
const LATEST_URL = import.meta.env.VITE_LATEST_URL

// 备用更新源：GitHub Releases latest（公开仓库，无需认证）。
// 图床 latest.json 故障/被墙时，通过 GitHub Release 资产拿安装包直链。
const GH_OWNER = 'b9348'
const GH_REPO = 'sfmmm'

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
  // 未配置版本清单地址时跳过（避免请求 undefined 报错）；
  // 本地 dev 已通过 .env 配置 VITE_LATEST_URL 时照常检测，便于本地验证更新链路
  if (!LATEST_URL) {
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
    // 清单格式异常（CDN 错误页 200 等）：与"无更新"区分，标记 error 供上层决策
    return { error: '版本清单格式异常' }
  } catch (e) {
    // 网络故障（图床被墙/超时）：不能当作"无更新"，标记 error 保留 pending_update
    console.warn('[Update] 检测更新失败:', e.message)
    return { error: e.message }
  }
}

/**
 * 检测是否有新版本
 * 返回 error 字段表示更新源故障（区别于"确认无更新"），调用方据此保留待应用状态
 */
export async function checkVersion(currentVersion) {
  const latest = await checkForUpdates()
  if (!latest) {
    return { hasUpdate: false, latestVersion: null, updateUrl: null }
  }
  if (latest.error) {
    return { hasUpdate: false, latestVersion: null, updateUrl: null, error: latest.error }
  }
  const hasUpdate = compareVersions(latest.version, currentVersion) > 0
  return {
    hasUpdate,
    latestVersion: latest.version,
    updateUrl: latest.update_url,
  }
}

/**
 * 备用更新源：查询 GitHub Releases latest，返回版本号与 exe 安装包直链。
 * 图床 latest.json 不可用时切换到此源；公开仓库匿名可访问。
 * @param {string} owner - GitHub 仓库 owner
 * @param {string} repo - GitHub 仓库名
 * @returns {Promise<{version, tagName, updateUrl, assetName, size, publishedAt}>}
 */
export async function checkGitHubUpdate(owner = GH_OWNER, repo = GH_REPO) {
  const res = await invoke('db_gh_latest_release', { owner, repo })
  if (res && res.success && res.data && res.data.version) {
    const d = res.data
    // Rust 端返回 snake_case，统一转成前端 camelCase（与 checkVersion 同构）
    return {
      version: d.version,
      tagName: d.tag_name,
      updateUrl: d.update_url,
      assetName: d.asset_name,
      size: d.size,
      publishedAt: d.published_at,
    }
  }
  throw new Error(res?.message || 'GitHub 更新检测失败')
}

/**
 * 创建更新安装包下载后台任务并立即返回（下载在 Rust 后台执行，
 * 离开设置页/切换标签不中断，进度由全局事件 "update-progress" 广播，
 * 状态用 getUpdateStatus() 查询恢复）。服务端支持 Range 时按
 * threads 分块并行下载（默认 8 线程），不支持则自动回退单流。
 * @param {string} url - 安装包下载地址
 * @param {string} version - 本次下载对应的目标版本（写库，供静默自动更新校验）
 * @param {number} threads - 分块下载线程数（默认 8）
 * @returns {Promise<{taskId: number}>}
 */
export async function prepareUpdate(url, version = '', threads = 8) {
  return await invoke('db_prepare_update', { url, version, threads })
}

/**
 * 查询最近一次更新下载任务状态（设置页挂载时恢复进度/错误/已就绪）
 * @returns {Promise<{id, status, percent, stage, error} | null>}
 */
export async function getUpdateStatus() {
  return await invoke('db_get_update_status')
}

/**
 * 下载就绪后统一"提升待应用"（App 全局监听与设置页 ready 分支共用同一门禁，
 * 消除手动/自动两条路径的逻辑分歧）：
 * 仅当任务行就绪、安装包确实在盘上且记录版本 === 当前最新版时才写入
 * pending_update='true'（防陈旧提升——旧版/未知版本安装包不自动应用），
 * 并顺带清除失败退避时间戳（下载成功即视为网络恢复）。
 * 跳过提升时记录具体原因日志，避免"静默不武装"导致下次启动不自动应用却无提示。
 * @param {string} latestVersion - 当前最新版本号（调用方无可靠参照时传空串，
 *                                 此时不提升并记录日志，防止基于陈旧 UI 状态误武装）
 * @returns {Promise<boolean>} 是否成功提升
 */
export async function armPendingUpdate(latestVersion) {
  const st = await getUpdateStatus()
  if (!st) {
    console.warn('[Update] 跳过提升待应用：无任务记录')
    return false
  }
  if (st.status !== 'ready') {
    console.warn(`[Update] 跳过提升待应用：任务状态非就绪（${st.status}）`)
    return false
  }
  if (!st.installerExists) {
    console.warn('[Update] 跳过提升待应用：安装包不在盘上（可能已被消费/清理）')
    return false
  }
  if (!st.version || !latestVersion || st.version !== latestVersion) {
    console.warn(`[Update] 跳过提升待应用：安装包版本 ${st.version || '未知'} 与最新版 ${latestVersion || '未知'} 不一致`)
    return false
  }
  try {
    await setConfig('pending_update', 'true')
  } catch (e) {
    console.warn('[Update] 写入待更新状态失败:', e)
    return false
  }
  // 下载成功：清除失败退避（fire-and-forget，写失败仅告警）
  setConfig('auto_update_fail_at', '').catch((e) => {
    console.warn('[Update] 清除失败退避失败:', e)
  })
  return true
}

/**
 * 启动已下载的安装包并退出当前应用
 */
export async function applyUpdate() {
  return await invoke('db_apply_update')
}
