/**
 * 「评分记录」本地 SQLite 缓存（全量快照）
 * 评分/撤评成功后回写缓存（含卡片渲染所需的完整 mod 信息），
 * 「点赞与评分」页评分栏离线时直接读缓存展示；列表离线时展示缓存均分。
 *
 * 行按 user_id 归属：换账号后只读当前账号的记录，避免把上一个账号的评分
 * 当成自己的（离线详情回退的 my_rating 也来自这里）。v3 起带 user_id。
 */

import { getDb, getConfig, setConfig } from './dbHelper'

const TABLE = 'rated_workshop_mods'
// 缓存结构版本：升级后自动清空旧缓存（v2 起存储全量快照，v3 起按用户归属）
const CACHE_VERSION = '3'
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

/**
 * 读取本地缓存（按最近缓存时间倒序）。匿名（userId 为空）不展示评分记录，
 * 避免把本机上一个账号的评分当成本人数据。
 */
export async function loadRatedModsFromCache(userId = null) {
  if (userId == null) return []
  try {
    await ensureCacheVersion()
    const db = await getDb()
    const rows = await db.select(
      `SELECT * FROM ${TABLE} WHERE user_id = $1 ORDER BY cached_at DESC`,
      [Number(userId) || 0],
    )
    return rows.map(rowToRating)
  } catch (e) {
    console.warn('[ratingCache] 读取缓存失败:', e)
    return []
  }
}

/** 读取单个 mod 的本地评分记录；没有评分记录 / 匿名 / 非本账号时返回 null */
export async function getCachedRating(modId, userId = null) {
  if (userId == null) return null
  try {
    await ensureCacheVersion()
    const db = await getDb()
    const rows = await db.select(
      `SELECT * FROM ${TABLE} WHERE mod_id = $1 AND user_id = $2`,
      [Number(modId) || 0, Number(userId) || 0],
    )
    return rows?.length ? rowToRating(rows[0]) : null
  } catch (e) {
    console.warn('[ratingCache] 读取单条缓存失败:', e)
    return null
  }
}

/** 底层插入（不含版本校验；批量刷新时由调用方先校验一次，避免逐条查配置） */
async function insertRatedMod(db, mod, userId) {
  await db.execute(
    `INSERT OR REPLACE INTO ${TABLE} (
      mod_id, mod_key, my_rating, rating_avg, rating_count,
      display_name, description, category, author_id, author_name, author_avatar,
      download_count, like_count, is_liked, comment_count,
      files, translations, created_at, updated_at, user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
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
      Number(userId) || 0,
    ],
  )
}

/** 单个模组回写缓存（评分/改评后使用，保存完整快照供卡片渲染） */
export async function upsertRatedModToCache(mod, userId = null) {
  if (userId == null) return
  // 必须先校验版本：升级后第一次评分若写进旧表，之后首次读缓存触发的
  // 版本清空会把刚写入的行一起删掉（离线又显示 0 星）
  await ensureCacheVersion()
  try {
    const db = await getDb()
    await insertRatedMod(db, mod, userId)
  } catch (e) {
    console.warn('[ratingCache] 更新缓存失败:', e)
  }
}

/** 全量刷新当前用户的缓存：先清空本账号旧行，再批量写入 */
export async function saveRatedModsToCache(mods, userId = null) {
  if (userId == null) return
  await ensureCacheVersion()
  try {
    const db = await getDb()
    await db.execute(`DELETE FROM ${TABLE} WHERE user_id = $1`, [Number(userId) || 0])
    for (const mod of mods) {
      await insertRatedMod(db, mod, userId)
    }
  } catch (e) {
    console.warn('[ratingCache] 写入缓存失败:', e)
  }
}

/** 从缓存移除单个模组（可选，撤评后同步清除） */
export async function removeRatedModFromCache(modId, userId = null) {
  if (userId == null) return
  try {
    const db = await getDb()
    await db.execute(
      `DELETE FROM ${TABLE} WHERE mod_id = $1 AND user_id = $2`,
      [modId, Number(userId) || 0],
    )
  } catch (e) {
    console.warn('[ratingCache] 删除缓存失败:', e)
  }
}
