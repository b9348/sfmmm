/**
 * 「点赞记录」本地 SQLite 缓存
 * 打开标签页时默认读取缓存避免每次查远程库；
 * 点进详情 / 手动刷新时再查库并回写缓存。
 */

import { getDb, getConfig, setConfig } from './dbHelper'

const TABLE = 'liked_workshop_mods'
// 缓存结构版本：升级后自动清空旧缓存（v1 曾写入错误的 created_at/缺失 updated_at）
const CACHE_VERSION = '2'
const VERSION_KEY = 'liked_mods_cache_version'

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
    console.warn('[likedModsCache] 校验缓存版本失败:', e)
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

function rowToMod(r) {
  return {
    id: r.mod_id,
    mod_key: r.mod_key,
    display_name: r.display_name,
    description: r.description,
    category: r.category,
    author_id: r.author_id,
    author_name: r.author_name,
    author_avatar: r.author_avatar,
    download_count: r.download_count,
    like_count: r.like_count,
    is_liked: !!r.is_liked,
    comment_count: r.comment_count,
    files: parseJson(r.files),
    translations: parseJson(r.translations),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

function modToParams(mod) {
  return [
    mod.id,
    mod.mod_key || '',
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
  ]
}

async function upsertMod(db, mod) {
  await db.execute(
    `INSERT OR REPLACE INTO ${TABLE} (
      mod_id, mod_key, display_name, description, category,
      author_id, author_name, author_avatar,
      download_count, like_count, is_liked, comment_count,
      files, translations, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    modToParams(mod)
  )
}

/** 读取本地缓存（按最近缓存时间倒序） */
export async function loadLikedModsFromCache() {
  try {
    await ensureCacheVersion()
    const db = await getDb()
    const rows = await db.select(`SELECT * FROM ${TABLE} ORDER BY cached_at DESC`)
    return rows.map(rowToMod)
  } catch (e) {
    console.warn('[likedModsCache] 读取缓存失败:', e)
    return []
  }
}

/** 全量刷新缓存：清空后批量写入 */
export async function saveLikedModsToCache(mods) {
  try {
    const db = await getDb()
    await db.execute(`DELETE FROM ${TABLE}`)
    for (const mod of mods) {
      await upsertMod(db, mod)
    }
  } catch (e) {
    console.warn('[likedModsCache] 写入缓存失败:', e)
  }
}

/** 单个模组回写缓存（详情查库后使用） */
export async function upsertLikedModToCache(mod) {
  try {
    const db = await getDb()
    await upsertMod(db, mod)
  } catch (e) {
    console.warn('[likedModsCache] 更新缓存失败:', e)
  }
}

/** 从缓存移除单个模组（取消点赞后使用） */
export async function removeLikedModFromCache(modId) {
  try {
    const db = await getDb()
    await db.execute(`DELETE FROM ${TABLE} WHERE mod_id = $1`, [modId])
  } catch (e) {
    console.warn('[likedModsCache] 删除缓存失败:', e)
  }
}
