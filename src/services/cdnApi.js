/**
 * 图床资源双线路：加速域名（IMGBED_MIRROR_URL）与原始域名（IMGBED_URL）动态切换。
 *
 * 数据库与展示里的 URL 一律保持原始域名；本模块在渲染层改写 host。
 * 下载/上传类 URL 由 Rust 端（db/cdn.rs）统一改写，本模块只管前端 <img> 展示。
 */

import { invoke } from '@tauri-apps/api/core'
import { getConfig, setConfig } from './dbHelper'

// 模块级缓存：启动时 initCdnMode() 填充；未就绪时 cdnUrl 原样返回老域名（安全默认）
let status = null

/**
 * 应用启动时调用：读用户持久化的线路选择 → 应用到 Rust → 拉取生效状态缓存。
 * 失败静默（保持老域名），不影响启动。
 */
export async function initCdnMode() {
  try {
    const saved = await getConfig('cdn_mode')
    if (saved && saved !== 'auto') {
      await invoke('cdn_set_mode', { mode: saved }).catch(() => {})
    }
  } catch { /* 配置未就绪时忽略 */ }
  try {
    status = await invoke('cdn_status')
  } catch {
    status = null
  }
  return status
}

export async function getCdnStatus() {
  if (!status) {
    try {
      status = await invoke('cdn_status')
    } catch {
      return null
    }
  }
  return status
}

/**
 * 手动切换线路并持久化。mode: 'auto' | 'mirror' | 'primary'
 */
export async function setCdnMode(mode) {
  await invoke('cdn_set_mode', { mode })
  await setConfig('cdn_mode', mode)
  status = await invoke('cdn_status')
  return status
}

/**
 * 展示用 URL 改写：当前生效线路不是主域名时，把主域名替换为生效线路域名，其余原样返回。
 * 同步函数，可直接用于渲染；状态未就绪时原样返回（主域名是安全默认）。
 */
export function cdnUrl(url) {
  if (!url || !status?.activeHost) return url
  try {
    const u = new URL(url)
    // 仅主域名的资源需要改写；已在备用线路域名上（或外域）的原样返回
    if (u.host !== status.primaryHost || status.activeHost === status.primaryHost) return url
    u.host = status.activeHost
    return u.toString()
  } catch {
    return url
  }
}
