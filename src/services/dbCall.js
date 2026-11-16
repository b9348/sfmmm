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
  AUTH_FAILED: 'errors.authFailed',
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

// ── 超时参数：唯一来源是后端 `db_timeouts` ──
// 后端常量区是唯一来源：执行段软超时 90s / 排队 30s / 取连接 5s / 建连 15s；
// socket 读超时为「不限」（后端返回 ioTimeoutMs = null，读超时不再等于失败）。
// 前端不保留第二套默认值：取不到就按原始错误上抛。
// 共享同一个 Promise：App 启动时先发起，dbCall / AsyncView 再 await 同一份，
// 不会重复 invoke；命令是纯内存返回，正常毫秒级。
let cachedTimeouts = null
let timeoutsPromise = null

/**
 * 拉取超时参数（纯内存返回，不建连接、不做 I/O）。
 * 失败不做任何兜底替换：清掉缓存的 Promise 以便下次重试，错误原样抛给调用方。
 */
export function initDbTimeouts() {
  if (!timeoutsPromise) {
    timeoutsPromise = invoke('db_timeouts')
      .then((res) => {
        cachedTimeouts = {
          callSoftTimeoutMs: res.callSoftTimeoutMs,
          queueWaitTimeoutMs: res.queueWaitTimeoutMs,
          poolAcquireTimeoutMs: res.poolAcquireTimeoutMs,
        }
        return cachedTimeouts
      })
      .catch((e) => {
        timeoutsPromise = null
        throw e
      })
  }
  return timeoutsPromise
}

/** 单次 db_* 调用的前端等待上限（毫秒）——调用前必须先 await `initDbTimeouts()`。 */
function getDbCallTimeoutMs() {
  const t = cachedTimeouts
  // 全部由后端返回值算出，不另拍魔数：
  //   排队等待 (queueWaitTimeoutMs) + 执行段软超时 (callSoftTimeoutMs)
  //   + 取连接等待上限 (poolAcquireTimeoutMs) 作为 IPC/调度抖动余量。
  // 注意：读超时已取消，后端可能一直阻塞等服务器返回；本值只是前端的「最后等待上限」，
  // 到点后前端先报超时，后端任务仍可能在同一连接上继续等（不会新建连接）。
  return t.queueWaitTimeoutMs + t.callSoftTimeoutMs + t.poolAcquireTimeoutMs
}

// 供 AsyncView 等组件展示「前端等待上限 Xs」；未加载完成时返回 null（不提供默认值）
export function getDbCallTimeoutS() {
  return cachedTimeouts ? getDbCallTimeoutMs() / 1000 : null
}

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
  // 用户身份标（游戏领域大神）：只含 id 列表，不涉敏感内容；
  // 缓存后离线也能保持头像角标，不必联网重算
  'db_list_game_masters',
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

/**
 * 缓存族失效后广播的事件名：持有全局只读集合的 Provider（如「游戏领域大神」）
 * 监听它即可立即重拉，不必轮询。detail = { command, families }
 */
export const CACHE_INVALIDATED_EVENT = 'sfmmm:cache-invalidated'

function dispatchCacheInvalidated(command, families) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CACHE_INVALIDATED_EVENT, { detail: { command, families } }))
}

// 写命令成功后需失效的缓存命令族（整族失效而非精确定位：
// cache_key 是参数级 JSON，命令名前缀失效简单可靠；保留量由字节预算控制）
const WRITE_FAMILIES = {
  db_add_comment: ['db_get_comments', 'db_get_replies', 'db_get_mod_detail', 'db_list_mods', 'db_locate_mod_comment'],
  db_edit_comment: ['db_get_comments', 'db_get_replies', 'db_get_mod_detail'],
  db_delete_comment: ['db_get_comments', 'db_get_replies', 'db_get_mod_detail', 'db_list_mods', 'db_locate_mod_comment'],
  db_like_mod: ['db_get_mod_detail', 'db_list_mods', 'db_list_liked_mods', 'db_list_game_masters'],
  db_unlike_mod: ['db_get_mod_detail', 'db_list_mods', 'db_list_liked_mods', 'db_list_game_masters'],
  db_rate_mod: ['db_get_mod_detail', 'db_list_mods', 'db_list_rated_mods'],
  db_unrate_mod: ['db_get_mod_detail', 'db_list_mods', 'db_list_rated_mods'],
  db_create_mod: ['db_list_mods', 'db_get_mod_detail', 'db_list_my_mods', 'db_list_game_masters'],
  db_update_mod: ['db_list_mods', 'db_get_mod_detail', 'db_list_my_mods', 'db_list_game_masters'],
  db_delete_mod: ['db_list_mods', 'db_get_mod_detail', 'db_list_my_mods', 'db_list_liked_mods', 'db_list_rated_mods', 'db_list_game_masters'],
  db_force_delete_mod: ['db_list_mods', 'db_get_mod_detail', 'db_list_my_mods', 'db_list_liked_mods', 'db_list_rated_mods', 'db_list_game_masters'],
  db_save_mod_file: ['db_get_mod_detail', 'db_list_my_mods', 'db_list_mods', 'db_list_game_masters'],
  db_delete_mod_file: ['db_get_mod_detail', 'db_list_my_mods', 'db_list_mods', 'db_list_game_masters'],
  db_set_mod_permissions: ['db_get_mod_detail'],
  db_create_discussion: ['db_list_discussions', 'db_get_discussion_detail', 'db_list_my_discussions'],
  db_update_discussion: ['db_list_discussions', 'db_get_discussion_detail', 'db_list_my_discussions'],
  db_delete_discussion: ['db_list_discussions', 'db_get_discussion_detail', 'db_list_my_discussions', 'db_list_my_discussion_comments', 'db_list_liked_discussions'],
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
  const runNetwork = async (cached = null) => {
    try {
      // 先拿到真实超时值再发请求：失败（命令不可用等）时原始错误从这里上抛，
      // 由 dbCall 现有错误路径处理，不在此处兜底成某个数字。
      await initDbTimeouts()
      let result
      let nextEtag = null
      if (cacheable) {
        // 只读命令走带 ETag 的通用通道：内容未变时服务端只回 304，不再传 body
        const out = await withTimeout(
          invoke('db_call_cached', { command, args, etag: cached?.etag ?? null }),
          getDbCallTimeoutMs(),
        )
        if (out?.not_modified) {
          dbRequestEnd(true)
          return cached?.payload ?? null
        }
        result = out?.result
        nextEtag = out?.etag ?? null
        if (!result || typeof result.success !== 'boolean') {
          throw new Error('云服务响应格式异常')
        }
      } else {
        result = await withTimeout(invoke(command, args), getDbCallTimeoutMs())
      }
      if (!result.success) {
        throw new Error(result.message || '操作失败')
      }
      dbRequestEnd(true)
      if (cacheable) {
        writeRequestCache(key, result, null, nextEtag)
      } else {
        const families = WRITE_FAMILIES[command]
        // 必须等失效完成再返回：写操作（编辑/发布）后页面会立即重新拉详情，
        // 若失效仍在异步执行，详情会命中旧缓存展示过期数据
        if (families) {
          await invalidateRequestCache(families)
          // 广播失效结果：持有全局只读集合的 Provider（如「游戏领域大神」）据此立即重拉，
          // 否则点赞/发布后达标也要等下次启动才体现
          dispatchCacheInvalidated(command, families)
        }
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
      const revalidate = runNetwork(hit).then(finalize).catch(() => null)
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
    // 令牌过期/被吊销：通知 AuthContext 统一清掉本地登录态，避免 UI 仍显示已登录
    if (code === 'AUTH_FAILED' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sfmmm:auth-expired'))
    }
    throw error
  }
}
