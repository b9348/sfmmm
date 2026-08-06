/**
 * 「评分记录」本地 SQLite 缓存（全量快照）
 * 评分/撤评成功后回写缓存（含卡片渲染所需的完整 mod 信息），
 * 「点赞与评分」页评分栏离线时直接读缓存展示；列表离线时展示缓存均分。
 */

import { getDb, getConfig, setConfig } from './dbHelper'

const TABLE = 'rated_workshop_mods'
// 缓存结构版本：升级后自动清空旧缓存（v2 起存储全量快照）
const CACHE_VERSION = '2'
const VERSION_KEY = 'rated_mods_cache_version'

/** 版本不一致时清空缓存，避免展示修复前写入的脏数据 */
async function ensureCacheVersion() {
  try {
    const current = await getConfig(VERSION_KEY)
    if (current !== CACHE_VERSION) {
      const db = await getDb()
      await db.execute(`DELETE FROM ${TABLE}`)
      await setConfig(VERSION_KEY, CACHE_VERSION)
    }
  } catch (e) {
    console.warn('[ratingCache] 校验缓存版本失败:', e)
  }
}

function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function rowToRating(r) {
  return {
    id: r.mod_id,
    mod_id: r.mod_id,
    mod_key: r.mod_key,
    my_rating: r.my_rating || 0,
    rating_avg: r.rating_avg || 0,
    rating_count: r.rating_count || 0,
    display_name: r.display_name || '',
    description: r.description || '',
    category: r.category || '',
    author_id: r.author_id || 0,
    author_name: r.author_name || '',
    author_avatar: r.author_avatar || '',
    download_count: r.download_count || 0,
    like_count: r.like_count || 0,
    is_liked: !!r.is_liked,
    comment_count: r.comment_count || 0,
    files: parseJson(r.files),
    translations: parseJson(r.translations),
    created_at: r.created_at || '',
    updated_at: r.updated_at || '',
  }
}

/** 读取本地缓存（按最近缓存时间倒序） */
export async function loadRatedModsFromCache() {
  try {
    await ensureCacheVersion()
    const db = await getDb()
    const rows = await db.select(`SELECT * FROM ${TABLE} ORDER BY cached_at DESC`)
    return rows.map(rowToRating)
  } catch (e) {
    console.warn('[ratingCache] 读取缓存失败:', e)
    return []
  }
}

/** 单个模组回写缓存（评分/改评后使用，保存完整快照供卡片渲染） */
export async function upsertRatedModToCache(mod) {
  try {
    const db = await getDb()
    await db.execute(
      `INSERT OR REPLACE INTO ${TABLE} (
        mod_id, mod_key, my_rating, rating_avg, rating_count,
        display_name, description, category, author_id, author_name, author_avatar,
        download_count, like_count, is_liked, comment_count,
        files, translations, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        mod.mod_id ?? mod.id,
        mod.mod_key || '',
        mod.my_rating || 0,
        mod.rating_avg || 0,
        mod.rating_count || 0,
        mod.display_name || '',
        mod.description || '',
        mod.category || '',
        mod.author_id || 0,
        mod.author_name || '',
        mod.author_avatar || '',
        mod.download_count || 0,
        mod.like_count || 0,
        mod.is_liked ? 1 : 0,
        mod.comment_count || 0,
        JSON.stringify(mod.files || []),
        JSON.stringify(mod.translations || {}),
        mod.created_at || '',
        mod.updated_at || '',
      ],
    )
  } catch (e) {
    console.warn('[ratingCache] 更新缓存失败:', e)
  }
}

/** 全量刷新缓存：清空后批量写入 */
export async function saveRatedModsToCache(mods) {
  try {
    const db = await getDb()
    await db.execute(`DELETE FROM ${TABLE}`)
    for (const mod of mods) {
      await upsertRatedModToCache(mod)
    }
  } catch (e) {
    console.warn('[ratingCache] 写入缓存失败:', e)
  }
}

/** 从缓存移除单个模组（可选，撤评后同步清除） */
export async function removeRatedModFromCache(modId) {
  try {
    const db = await getDb()
    await db.execute(`DELETE FROM ${TABLE} WHERE mod_id = $1`, [modId])
  } catch (e) {
    console.warn('[ratingCache] 删除缓存失败:', e)
  }
}
