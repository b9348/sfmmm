import { listMods, listDiscussions, getDiscussionDetail } from './workshopApi'
import { readRequestCacheByCommand } from './requestCache'

/**
 * @ 提及的数据层。
 *
 * 两类可提及对象：
 * - 模组（mod_key）       -> sfmmm:mod:<mod_key>
 * - 讨论区主题帖（数字 id） -> sfmmm:discuss:<id>
 *
 * 查询策略（按用户要求避免频繁查库）：
 * - 打开 @ 时只读本地 SQLite 里的列表缓存，默认展示「缓存记录匹配」
 * - 在搜索框里输入时，仅对内存中的缓存记录做模糊过滤
 * - 只有点「搜索」或按 Shift+Enter 才真正请求云端（模组列表 + 讨论列表）
 */

export const MENTION_MOD = 'mod'
export const MENTION_DISCUSSION = 'discussion'

/** 解析正文里的 @提及链接；不是提及链接返回 null */
export function parseMentionHref(href) {
  if (typeof href !== 'string') return null
  if (href.startsWith('sfmmm:mod:')) {
    return { kind: MENTION_MOD, ref: safeDecode(href.slice('sfmmm:mod:'.length)) }
  }
  if (href.startsWith('sfmmm:discuss:')) {
    return { kind: MENTION_DISCUSSION, ref: safeDecode(href.slice('sfmmm:discuss:'.length)) }
  }
  return null
}

function safeDecode(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 去掉语言里的地区后缀（zh-CN -> zh），后端只认主语言码 */
export function normalizeLang(lang) {
  const base = String(lang || 'zh').split('-')[0].toLowerCase()
  return ['zh', 'en', 'ja'].includes(base) ? base : 'zh'
}

// ── 内存记录：正文里别人的 @提及 反查、以及搜索结果的合并都走这里 ──

/** mod_key -> mod */
const modsByKey = new Map()
/** discussion id -> discussion */
const discussionsById = new Map()

export function rememberMod(mod) {
  if (mod?.mod_key) modsByKey.set(mod.mod_key, mod)
  return mod
}

export function rememberDiscussion(d) {
  if (d?.id != null) discussionsById.set(String(d.id), d)
  return d
}

export function getCachedMod(modKey) {
  return modsByKey.get(modKey) || null
}

export function getCachedDiscussion(id) {
  return discussionsById.get(String(id)) || null
}

/** 把两类原始 DTO 归一成补全列表/悬浮卡片共用的形状 */
function toRecord(item, kind) {
  if (!item) return null
  if (kind === MENTION_MOD) {
    return {
      kind,
      ref: item.mod_key,
      title: item.display_name || item.mod_key,
      subtitle: item.mod_key,
      description: item.description || '',
      category: item.category,
      author_name: item.author_name,
      author_avatar: item.author_avatar,
      author_id: item.author_id,
      like_count: item.like_count || 0,
      comment_count: item.comment_count || 0,
      updated_at: item.updated_at || item.created_at || '',
      raw: item,
    }
  }
  return {
    kind,
    ref: String(item.id),
    title: item.title || ('#' + item.id),
    subtitle: '#' + item.id,
    description: item.content || '',
    category: null,
    author_name: item.author_name,
    author_avatar: item.author_avatar,
    author_id: item.author_id,
    like_count: item.like_count || 0,
    comment_count: item.comment_count || 0,
    updated_at: item.updated_at || item.created_at || '',
    raw: item,
  }
}

function collectFromPayloads(modPayloads, discPayloads) {
  const mods = []
  const discussions = []
  for (const payload of modPayloads) {
    for (const m of payload?.mods || []) mods.push(m)
  }
  for (const payload of discPayloads) {
    for (const d of payload?.data?.discussions || []) discussions.push(d)
  }
  return { mods, discussions }
}

function buildRecords(mods, discussions) {
  const seen = new Set()
  const out = []
  for (const m of mods) {
    if (!m?.mod_key || seen.has('m:' + m.mod_key)) continue
    seen.add('m:' + m.mod_key)
    rememberMod(m)
    out.push(toRecord(m, MENTION_MOD))
  }
  for (const d of discussions) {
    if (d?.id == null || seen.has('d:' + d.id)) continue
    seen.add('d:' + d.id)
    rememberDiscussion(d)
    out.push(toRecord(d, MENTION_DISCUSSION))
  }
  // 最近更新的排前面；没有时间字段的保持在末尾
  out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  return out
}

/** 会话内已经见过的记录（上一次搜索 / 正文反查），打开 @ 时先同步展示 */
export function currentMentionRecords() {
  return buildRecords([...modsByKey.values()], [...discussionsById.values()])
}

// 本地缓存的解析结果按会话缓存：模组列表 payload 含 files/translations，
// 每次打开 @ 都重新扫 24 行并解析会造成明显卡顿
const LOCAL_CACHE_TTL = 30_000
let localCacheAt = 0
let localCacheRecords = null

/**
 * 只读本地缓存（本地 SQLite，不访问云端），作为 @ 打开时的默认列表。
 * 30 秒内重复打开直接复用解析结果；期间浏览过新页面也不会漏太多。
 */
export async function loadCachedMentionRecords() {
  if (localCacheRecords && Date.now() - localCacheAt < LOCAL_CACHE_TTL) {
    return localCacheRecords
  }
  const [modPayloads, discPayloads] = await Promise.all([
    readRequestCacheByCommand('db_list_mods', 12),
    readRequestCacheByCommand('db_list_discussions', 12),
  ])
  const { mods, discussions } = collectFromPayloads(modPayloads, discPayloads)
  const records = buildRecords(mods, discussions)
  localCacheRecords = records
  localCacheAt = Date.now()
  return records
}

/**
 * 显式搜索：只有这里会请求云端。模组与主题帖并行查，合并进本地记录。
 */
export async function runMentionSearch(query, lang = 'zh') {
  const q = String(query || '').trim()
  const [modRes, discRes] = await Promise.all([
    listMods({ lang: normalizeLang(lang), search: q || null, limit: 30, page: 1 }),
    listDiscussions({ search: q || null, limit: 20, page: 1 }),
  ])
  const mods = modRes.mods || []
  const discussions = discRes.discussions || []
  return buildRecords(mods, discussions)
}

// ── 模糊匹配 ──

/**
 * 精确 > 前缀 > 子串 > 子序列。作者名与正文也参与匹配，
 * 方便只记得作者或帖子内容里的片段时也能找到。
 */
export function fuzzyScore(text, query) {
  if (!text) return 0
  const t = String(text).toLowerCase()
  const q = String(query).toLowerCase()
  if (!q) return 1
  if (t === q) return 1000
  if (t.startsWith(q)) return 800 - t.length
  const idx = t.indexOf(q)
  if (idx >= 0) return 600 - idx * 2 - Math.max(0, t.length - q.length) / 10
  let ti = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    gaps += found - ti
    ti = found + 1
  }
  return 200 - gaps
}

function recordScore(record, query) {
  return Math.max(
    fuzzyScore(record.title, query),
    fuzzyScore(record.subtitle, query),
    fuzzyScore(record.author_name, query),
    fuzzyScore(String(record.description || '').slice(0, 2000), query) * 0.8,
  )
}

/** 在缓存记录里做模糊过滤；空查询返回全部（默认展示缓存记录） */
export function searchMentionRecords(records, query, limit = 20) {
  if (!Array.isArray(records) || records.length === 0) return []
  const q = String(query || '').trim()
  if (!q) return records.slice(0, limit)

  const scored = []
  for (const record of records) {
    const score = recordScore(record, q)
    if (score > 0) scored.push({ record, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((x) => x.record)
}

/**
 * 取提及对象的完整数据（正文里别人写的 @提及）。
 * 先查会话内记录，再按类型回退到一次精确查询；失败返回 null。
 */
export async function getMentionData(kind, ref, lang = 'zh') {
  if (!ref) return null
  if (kind === MENTION_MOD) {
    const cached = modsByKey.get(ref)
    if (cached) return cached
    try {
      const res = await listMods({ lang: normalizeLang(lang), search: ref, limit: 20, page: 1 })
      const hit = (res.mods || []).find((m) => m.mod_key.toLowerCase() === ref.toLowerCase())
      return hit ? rememberMod(hit) : null
    } catch {
      return null
    }
  }

  if (kind === MENTION_DISCUSSION) {
    const cached = discussionsById.get(String(ref))
    if (cached) return cached
    try {
      const res = await getDiscussionDetail(ref)
      const d = res.data
      return d ? rememberDiscussion(d) : null
    } catch {
      return null
    }
  }
  return null
}
