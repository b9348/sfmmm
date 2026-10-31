/**
 * 「评论/回复/点赞通知」本地 SQLite 缓存
 * 拉取成功后按页 upsert 合并到本地（(user_id, entity, notif_id) 唯一）；
 * 标记已读时同步回写；远程库连接数打满/断连时回退展示缓存的历史通知，
 * 与创意工坊（likedModsCache / ratingCache）的缓存优先策略保持一致。
 */

import { getDb } from './dbHelper'

const TABLE = 'user_notifications_cache'
// 本地缓存上限：防止无限增长（通知按 created_at 倒序保留最新 N 条）
const MAX_ROWS_PER_USER = 200

function rowToNotif(r) {
  return {
    id: r.notif_id,
    entity: r.entity,
    type: r.type,
    target_id: r.target_id,
    comment_id: r.comment_id,
    is_read: !!r.is_read,
    created_at: r.created_at,
    content: r.content,
    display_key: r.display_key || '',
    author_id: r.author_id,
    author_name: r.author_name,
    author_avatar: r.author_avatar,
    is_author: !!r.is_author,
    is_collab: !!r.is_collab,
    is_parent_author: !!r.is_parent_author,
  }
}

function notifToParams(userId, n) {
  return [
    userId,
    n.entity || 'mod',
    n.id,
    n.type || '',
    n.target_id || 0,
    n.comment_id || 0,
    n.is_read ? 1 : 0,
    n.created_at || '',
    n.content || '',
    n.display_key || '',
    n.author_id || 0,
    n.author_name || '',
    n.author_avatar || '',
    n.is_author ? 1 : 0,
    n.is_collab ? 1 : 0,
    n.is_parent_author ? 1 : 0,
  ]
}

/** 读取某用户的历史通知缓存（按 created_at 倒序），并返回最近缓存时间（ms，无缓存为 null） */
export async function loadNotificationsFromCache(userId) {
  if (userId == null) return { items: [], cachedAt: null }
  try {
    const db = await getDb()
    const rows = await db.select(
      `SELECT * FROM ${TABLE} WHERE user_id = $1 ORDER BY created_at DESC, notif_id DESC LIMIT ${MAX_ROWS_PER_USER}`,
      [userId]
    )
    const meta = await db.select(
      `SELECT MAX(cached_at) AS latest FROM ${TABLE} WHERE user_id = $1`,
      [userId]
    )
    let cachedAt = null
    if (meta.length > 0 && meta[0].latest) {
      const ms = Date.parse(String(meta[0].latest).replace(' ', 'T') + 'Z')
      if (!Number.isNaN(ms)) cachedAt = ms
    }
    return { items: rows.map(rowToNotif), cachedAt }
  } catch (e) {
    console.warn('[notifCache] 读取缓存失败:', e)
    return { items: [], cachedAt: null }
  }
}

/** 按页 upsert 合并写入缓存（不清空旧数据，避免翻页时丢页），并裁剪超出上限的旧行 */
export async function saveNotificationsToCache(userId, items) {
  if (userId == null || !Array.isArray(items) || items.length === 0) return
  try {
    const db = await getDb()
    for (const n of items) {
      await db.execute(
        `INSERT OR REPLACE INTO ${TABLE} (
          user_id, entity, notif_id, type, target_id, comment_id,
          is_read, created_at, content, display_key,
          author_id, author_name, author_avatar,
          is_author, is_collab, is_parent_author
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        notifToParams(userId, n)
      )
    }
    // 裁剪：仅保留最新 MAX_ROWS_PER_USER 条（SQLite 无 LIMIT DELETE，按 id 倒序排除）
    await db.execute(
      `DELETE FROM ${TABLE} WHERE user_id = $1 AND id NOT IN (
         SELECT id FROM ${TABLE} WHERE user_id = $1 ORDER BY created_at DESC, notif_id DESC LIMIT ${MAX_ROWS_PER_USER}
       )`,
      [userId]
    )
  } catch (e) {
    console.warn('[notifCache] 写入缓存失败:', e)
  }
}

/** 调和缓存（第 1 页拉取成功时调用）：
 *  - 服务端第 1 页为空 → 该用户服务端已无任何通知，清空缓存；
 *  - 否则先按页合并本页，再以本页为「最新窗口」剔除陈旧行：
 *    服务端按 created_at 倒序返回，缓存中 created_at 晚于本页最早一条、却不在本页
 *    (entity, notif_id) 集合内的行，必然对应已被删除的评论/帖子，予以清除，
 *    避免断连回退时展示实际已不存在的历史通知（窗口之外更旧的行不判定，属第 2 页+ 范畴）。 */
export async function reconcileNotificationsCache(userId, items) {
  if (userId == null) return
  if (!Array.isArray(items) || items.length === 0) {
    await clearNotificationsCache(userId)
    return
  }
  await saveNotificationsToCache(userId, items)
  try {
    const db = await getDb()
    let minCreated = ''
    for (const n of items) {
      const c = n.created_at || ''
      if (c && (!minCreated || c < minCreated)) minCreated = c
    }
    if (!minCreated) return
    const keys = items.map(n => `${n.entity || 'mod'}:${n.id}`)
    const placeholders = keys.map((_, i) => `$${i + 3}`).join(', ')
    await db.execute(
      `DELETE FROM ${TABLE} WHERE user_id = $1 AND created_at >= $2 AND (entity || ':' || notif_id) NOT IN (${placeholders})`,
      [userId, minCreated, ...keys]
    )
  } catch (e) {
    console.warn('[notifCache] 调和缓存失败:', e)
  }
}

/** 标记已读后同步回写缓存（entity 为空表示全部类型；ids 为空表示该范围内全部通知） */
export async function markNotificationsReadInCache(userId, entity, ids) {
  if (userId == null) return
  try {
    const db = await getDb()
    const conds = ['user_id = $1']
    const params = [userId]
    if (entity) {
      params.push(entity)
      conds.push(`entity = $${params.length}`)
    }
    if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map((_, i) => `$${params.length + i + 1}`).join(', ')
      params.push(...ids)
      conds.push(`notif_id IN (${placeholders})`)
    }
    await db.execute(`UPDATE ${TABLE} SET is_read = 1 WHERE ${conds.join(' AND ')}`, params)
  } catch (e) {
    console.warn('[notifCache] 回写已读状态失败:', e)
  }
}

/** 切换账号/清理用户数据时清空该用户的通知缓存 */
export async function clearNotificationsCache(userId) {
  if (userId == null) return
  try {
    const db = await getDb()
    await db.execute(`DELETE FROM ${TABLE} WHERE user_id = $1`, [userId])
  } catch (e) {
    console.warn('[notifCache] 清空缓存失败:', e)
  }
}
