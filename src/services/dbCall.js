/**
 * 通用 db_* 调用包装
 * - 统一前端超时兜底
 * - 后端结构化错误（[DBERR:*]）解析与面向用户的文案
 * - 只读命令的缓存优先 + 网络信号灯
 *
 * 与具体业务无关，workshopApi / imageApi 等共用。
 */

import { invoke } from '@tauri-apps/api/core'
import { makeCacheKey, readRequestCache, readRequestCacheIgnoringDevice, writeRequestCache, invalidateRequestCache } from './requestCache'
import { dbRequestStart, dbRequestEnd } from './netStatus'

// ── 错误辅助 ──

function extractError(e) {
  if (typeof e === 'string') return e
  if (e?.message) return e.message
  return String(e)
}

// 后端错误类别前缀：`[DBERR:<CODE>] <人类可读信息>`（见 src-tauri/src/db.rs）
// 前端据此展示差异化提示，而不是把原始错误串直接抛给用户
const DBERR_RE = /^\[DBERR:([A-Z_]+)\]\s*/

/**
 * 解析错误，返回 { code, message }。
 * 兼容两种输入：已结构化的 Error（读 dbErrorCode）与原始错误串（解析前缀）。
 * code 为 null 表示非结构化错误（如前端自身超时兜底）。
 */
export function parseDbError(raw) {
  // dbCall 抛出的 Error 已剥离前缀，类别存在 dbErrorCode 上
  if (raw && typeof raw === 'object' && raw.dbErrorCode !== undefined) {
    return { code: raw.dbErrorCode, message: raw.message }
  }
  const text = typeof raw === 'string' ? raw : extractError(raw)
  const m = text.match(DBERR_RE)
  if (!m) return { code: null, message: text }
  return { code: m[1], message: text.replace(DBERR_RE, '') }
}

/**
 * 错误类别 → i18n key 映射。
 * 无类别（前端超时兜底等）走通用加载失败文案。
 */
const DBERR_I18N_KEY = {
  TOO_MANY_CONNECTIONS: 'errors.tooManyConnections',
  QUEUE_TIMEOUT: 'errors.serverBusy',
  QUERY_TIMEOUT: 'errors.queryTimeout',
  POOL_BUSY: 'errors.serverBusy',
  NETWORK: 'errors.network',
}

// 可视为「云端暂时不可达」的错误类别：这些情况下允许业务层用列表缓存补详情
const CONNECTIVITY_CODES = new Set([
  'TOO_MANY_CONNECTIONS', 'QUEUE_TIMEOUT', 'QUERY_TIMEOUT', 'POOL_BUSY', 'OFFLINE_DEV', 'NETWORK',
])

export function isConnectivityError(raw) {
  // 前端兜底超时没有错误类别，但同样说明云端这次没能返回，允许业务层用缓存补详情
  if (raw && typeof raw === 'object' && raw.isTimeout) return true
  const { code } = parseDbError(raw)
  return !!code && CONNECTIVITY_CODES.has(code)
}

/**
 * 把错误转成面向用户的提示文案（已翻译）。
 * 翻译缺失时退回后端原始信息，不露出 i18n key。
 * @param {string|Error} raw 原始错误串或 dbCall 抛出的 Error
 * @param {(k: string) => string} [t] i18n 翻译函数；省略则返回剥前缀后的原文
 */
export function formatDbError(raw, t) {
  const { code, message } = parseDbError(raw)
  const key = code && DBERR_I18N_KEY[code]
  if (key && t) {
    const translated = t(key)
    if (translated && translated !== key) return translated
  }
  return message
}

// ── 通用请求包装 ──

// 单次 db_* 调用的前端超时：前端仅作兜底。
// 后端两段式超时：排队 30s（QUEUE_WAIT_TIMEOUT_SECS）+ 执行 90s（CALL_SOFT_TIMEOUT_SECS），
// SQLPub 免费库高峰期会限流，慢查询多等一会总能返回，故放宽；
// 前端取 130s 略宽于后端最坏 120s，超时前必然收到后端的结构化错误。
const DB_CALL_TIMEOUT_MS = 130_000
// 供 AsyncView 等组件在加载/报错时展示「已等待 Xs / 超时 Ys」
export const DB_CALL_TIMEOUT_S = DB_CALL_TIMEOUT_MS / 1000
// 后端两段式超时（排队 30s + 执行 90s），仅用于展示说明
export const DB_BACKEND_TIMEOUT_S = { queue: 30, exec: 90 }

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`请求超时（超过 ${ms / 1000} 秒）`)
      // 与后端结构化错误区分：保留超时文案，但按「云端不可达」处理
      err.isTimeout = true
      reject(err)
    }, ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

// ── 只读查询缓存：云端不可达时回退本地历史 ──
// 只收浏览类只读 DTO：列表/详情/评论楼中楼/投票结果/历史列表/公开资料/评论定位。
// 写操作、编辑预填、登录等绝不缓存。
// 申请列表（db_list_applications）刻意不缓存：页面只有「作者视角」入口，
// 查询结果会带出申请人姓名、申请理由等他人敏感信息（远端是加密字段），
// 不能落本地明文 SQLite；将来若新增申请人视角，需单独评估参数级白名单后再放行。
// 支持 revalidate 的浏览命令走缓存优先秒开 + 后台刷新；其余命令走网络优先，
// 只在失败时回退缓存（见 FALLBACK_ONLY_COMMANDS），避免在线展示旧数据无法刷新。
const CACHEABLE_COMMANDS = new Set([
  'db_list_mods', 'db_list_my_mods', 'db_list_liked_mods', 'db_list_rated_mods',
  'db_list_discussions', 'db_list_liked_discussions', 'db_list_my_discussions', 'db_list_my_discussion_comments',
  'db_get_mod_detail', 'db_get_discussion_detail',
  'db_get_comments', 'db_get_replies',
  'db_get_discussion_comments', 'db_get_discussion_replies',
  'db_get_poll_results', 'db_get_user_public_profile',
  'db_locate_mod_comment', 'db_locate_discussion_comment',
])

// 这些命令的调用方只消费最终数据、不支持 revalidate 回填：
// 采用「网络优先、失败回退缓存」，避免在线时先展示旧缓存却无法自动刷新。
const FALLBACK_ONLY_COMMANDS = new Set([
  'db_list_my_mods', 'db_list_liked_mods', 'db_list_rated_mods',
  'db_list_liked_discussions', 'db_list_my_discussions', 'db_list_my_discussion_comments',
  'db_get_user_public_profile',
  'db_locate_mod_comment', 'db_locate_discussion_comment',
])

// 写命令成功后需失效的缓存命令族（整族失效而非精确定位：
// cache_key 是参数级 JSON，命令名前缀失效简单可靠；保留量由字节预算控制）
const WRITE_FAMILIES = {
  db_add_comment: ['db_get_comments', 'db_get_replies', 'db_get_mod_detail', 'db_list_mods', 'db_locate_mod_comment'],
  db_edit_comment: ['db_get_comments', 'db_get_replies', 'db_get_mod_detail'],
  db_delete_comment: ['db_get_comments', 'db_get_replies', 'db_get_mod_detail', 'db_list_mods', 'db_locate_mod_comment'],
  db_like_mod: ['db_get_mod_detail', 'db_list_mods', 'db_list_liked_mods'],
  db_unlike_mod: ['db_get_mod_detail', 'db_list_mods', 'db_list_liked_mods'],
  db_rate_mod: ['db_get_mod_detail', 'db_list_mods', 'db_list_rated_mods'],
  db_unrate_mod: ['db_get_mod_detail', 'db_list_mods', 'db_list_rated_mods'],
  db_create_mod: ['db_list_mods', 'db_get_mod_detail', 'db_list_my_mods'],
  db_update_mod: ['db_list_mods', 'db_get_mod_detail', 'db_list_my_mods'],
  db_delete_mod: ['db_list_mods', 'db_get_mod_detail', 'db_list_my_mods', 'db_list_liked_mods', 'db_list_rated_mods'],
  db_force_delete_mod: ['db_list_mods', 'db_get_mod_detail', 'db_list_my_mods', 'db_list_liked_mods', 'db_list_rated_mods'],
  db_save_mod_file: ['db_get_mod_detail', 'db_list_my_mods'],
  db_delete_mod_file: ['db_get_mod_detail', 'db_list_my_mods'],
  db_set_mod_permissions: ['db_get_mod_detail'],
  db_create_discussion: ['db_list_discussions', 'db_get_discussion_detail', 'db_list_my_discussions'],
  db_update_discussion: ['db_list_discussions', 'db_get_discussion_detail', 'db_list_my_discussions'],
  db_delete_discussion: ['db_list_discussions', 'db_get_discussion_detail', 'db_list_my_discussions', 'db_list_liked_discussions'],
  db_like_discussion: ['db_list_discussions', 'db_get_discussion_detail', 'db_list_liked_discussions'],
  db_unlike_discussion: ['db_list_discussions', 'db_get_discussion_detail', 'db_list_liked_discussions'],
  db_boost_discussion: ['db_list_discussions', 'db_get_discussion_detail'],
  db_unboost_discussion: ['db_list_discussions', 'db_get_discussion_detail'],
  db_vote_poll: ['db_get_poll_results', 'db_get_discussion_detail'],
  db_add_discussion_comment: ['db_get_discussion_comments', 'db_get_discussion_replies', 'db_get_discussion_detail', 'db_list_discussions', 'db_list_my_discussion_comments', 'db_locate_discussion_comment'],
  db_edit_discussion_comment: ['db_get_discussion_comments', 'db_get_discussion_replies', 'db_get_discussion_detail', 'db_list_my_discussion_comments'],
  db_delete_discussion_comment: ['db_get_discussion_comments', 'db_get_discussion_replies', 'db_get_discussion_detail', 'db_list_discussions', 'db_list_my_discussion_comments', 'db_locate_discussion_comment'],
  db_update_profile: [
    'db_get_user_public_profile', 'db_get_comments', 'db_get_replies',
    'db_get_discussion_comments', 'db_get_discussion_replies',
  ],
  // 申请列表不缓存（见 CACHEABLE_COMMANDS 注释），提交/处理申请只需失效 mod 详情
  db_handle_application: ['db_get_mod_detail'],
}

/**
 * dbCall：只读命令缓存优先（stale-while-revalidate），写命令直连。
 * @param {string} command Tauri 命令名
 * @param {object} args 命令参数
 * @param {(raw: object) => object} [mapResult] 原始返回 → 页面 DTO 的映射函数；
 *   缓存命中与 revalidate 完成时都会经它映射，保证两条路径返回结构一致
 * @param {object} [opts]
 * @param {boolean} [opts.force] 跳过本地缓存直接走网络（编辑/发布后刷新详情用，
 *   避免失效尚未完成时读到旧缓存）
 */
export async function dbCall(command, args = {}, mapResult, opts = {}) {
  const { force = false } = opts
  dbRequestStart()
  const cacheable = CACHEABLE_COMMANDS.has(command)
  const key = cacheable ? makeCacheKey(command, args) : null

  // 网络请求本体：成功回写缓存（写命令则失效缓存族）；失败置红信号灯并抛错
  const runNetwork = async () => {
    try {
      const result = await withTimeout(invoke(command, args), DB_CALL_TIMEOUT_MS)
      if (!result.success) {
        throw new Error(result.message || '操作失败')
      }
      dbRequestEnd(true)
      if (cacheable) {
        writeRequestCache(key, result)
      } else {
        const families = WRITE_FAMILIES[command]
        // 必须等失效完成再返回：写操作（编辑/发布）后页面会立即重新拉详情，
        // 若失效仍在异步执行，详情会命中旧缓存展示过期数据
        if (families) await invalidateRequestCache(families)
      }
      return result
    } catch (e) {
      dbRequestEnd(false)
      throw e
    }
  }

  const finalize = (raw) => (mapResult ? mapResult(raw) : raw)

  // 缓存优先：命中立即返回缓存内容（页面秒开），后台静默请求网络回写缓存；
  // revalidate promise 随返回值暴露，网络结果到达后页面可据此刷新视图。
  // 刷新失败静默吞掉：缓存内容继续展示，信号灯由 dbRequestEnd 置红提示。
  if (cacheable && !force && !FALLBACK_ONLY_COMMANDS.has(command)) {
    const hit = await readRequestCache(key)
    if (hit) {
      const revalidate = runNetwork().then(finalize).catch(() => null)
      return finalize({ ...hit.payload, __fromCache: true, __cachedAt: hit.cachedAt, __revalidate: revalidate })
    }
  }

  try {
    return finalize(await runNetwork())
  } catch (e) {
    // 网络失败且命中本地缓存：降级返回缓存内容（带标注），让页面可离线浏览历史
    if (cacheable) {
      let hit = await readRequestCache(key)
      // 精确键未命中时再忽略 device_id 匹配一次：device_id 存在 localStorage，
      // dev（localhost:5173）与生产（tauri.localhost）不同 origin 会生成不同 ID，
      // 但两者共用同一份 request_cache。离线开发模式（dev:of）切换来源后仍可读到旧缓存。
      if (!hit) hit = await readRequestCacheIgnoringDevice(command, args)
      if (hit) {
        return finalize({ ...hit.payload, __fromCache: true, __cachedAt: hit.cachedAt })
      }
    }
    const raw = extractError(e)
    const { code, message } = parseDbError(raw)
    // message 已剥离 [DBERR:*] 前缀，现有所有 e.message 消费点（alert / setError）
    // 都不会露出内部协议标记；类别另存 dbErrorCode 供 UI 做差异化翻译与分支
    const error = new Error(message)
    error.httpCode = 'DB_ERROR'
    error.dbErrorCode = code
    throw error
  }
}
