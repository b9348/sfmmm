/**
 * 公告公开查询。公告不进入只读缓存：启动时和 WS 失效后都直接走网络，
 * 避免离线缓存把已归档/已过期的公告继续展示。
 */
import { dbCall } from './dbCall'

const DISPLAY_TYPES = new Set(['modal', 'banner', 'toast'])

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = Number(raw.id)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const displayType = String(raw.display_type || '')
  if (!DISPLAY_TYPES.has(displayType)) return null
  return {
    id,
    title: String(raw.title || ''),
    body: String(raw.body || ''),
    display_type: displayType,
    priority: Number(raw.priority) || 0,
    published_at_ms: Number(raw.published_at_ms) || 0,
    ends_at_ms: raw.ends_at_ms == null ? null : Number(raw.ends_at_ms) || 0,
  }
}

/**
 * 拉取当前有效公告。
 * 返回 { serverMs, items }；serverMs 是服务端时钟，用于校准 ends_at_ms 的本地到期计时。
 */
export async function fetchActiveAnnouncements() {
  const res = await dbCall('db_list_active_announcements', {})
  const data = res?.data || {}
  const items = Array.isArray(data.items) ? data.items.map(normalizeItem).filter(Boolean) : []
  const serverMs = Number(data.server_ms)
  return {
    serverMs: Number.isFinite(serverMs) && serverMs > 0 ? serverMs : Date.now(),
    items,
  }
}
