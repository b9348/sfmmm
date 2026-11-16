/**
 * 云服务网络状态 mini-store（信号灯数据源）
 *
 * workshopApi 的 dbCall 在每次请求生命周期上报状态，组件通过
 * useSyncExternalStore 消费。零依赖，全部模块级状态。
 *
 * hk 架构下桌面端不再直连数据库：`db_pool_status` 只返回「最近一次云 API
 * 请求是否失败」，没有本机连接池与空闲释放倒计时（相关状态恒为 null/false）。
 */

import { invoke } from '@tauri-apps/api/core'

/** 距释放 <= 10s：开始闪烁提醒 */
const IDLE_WARN_MS = 10000
/** 距释放 <= 5s：每秒闪烁，直到释放 */
const IDLE_CRITICAL_MS = 5000
/** 进入倒计时快车道（每秒拉取/刷新一次）的窗口 */
const IDLE_FAST_WINDOW_MS = 15000
const IDLE_POLL_FAST_MS = 1000
const IDLE_POLL_SLOW_MS = 5000
const IDLE_TICK_FAST_MS = 1000
const IDLE_TICK_SLOW_MS = 5000

let state = {
  inflight: 0,
  /** 本会话最近一次请求成败：null=还没有, true=成功, false=失败 */
  lastOutcome: null,
  /** 最近是否连接失败（与后端 recent_failure 同步校准） */
  recentFailure: false,
  /** 启动探活是否已完成 */
  probed: false,
  /** 距后端预计释放连接的剩余毫秒：null=未知（没有空闲池 / 已释放） */
  idleRemainingMs: null,
  /** 后端空闲释放阈值（秒），用于文案 */
  idleTimeoutSecs: 0,
  /** 后端当前是否已建池 */
  idlePoolReady: false,
  /** 后端最近一次空闲回收后是否还没重新建池 */
  idleReleased: false,
  /** 通知长连接状态：null=未知；connected/connecting/backoff/auth_required/unsupported/disabled/signed_out */
  wsState: null,
  /** 退避重试剩余毫秒（仅 backoff 时有值，用于 hover 文案） */
  wsRetryInMs: null,
  /** 最近一次连接状态事件的服务端时间（ms） */
  wsSinceMs: null,
}

const listeners = new Set()

export function subscribeNetStatus(fn) {
  listeners.add(fn)
  // 有消费者才轮询：命令是纯内存返回，但也不该在没有任何灯显示时空转
  if (listeners.size === 1) startSync()
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0) stopSync()
  }
}

export function getNetStatusSnapshot() {
  return state
}

function update(patch) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn(state))
}

// ── 空闲释放倒计时 ─────────────────────────────────────────

/** 后端预计释放时刻换算到本地单调时钟（performance.now 基准）；null=未知 */
let deadlineAt = null
let pollTimer = null
let tickTimer = null
let polling = false
let syncing = false

function computeRemaining() {
  if (deadlineAt === null) return null
  return Math.max(0, deadlineAt - performance.now())
}

/**
 * 应用一次 `db_pool_status` 结果。
 * 用后端自带的 `serverNowMs` 与 `idleReleaseAtMs` 相减，消除本机时钟偏差；
 * 再减掉本次 IPC 往返耗时，把释放时刻换算到本地单调时钟上。
 */
function applyStatus(res, latencyMs) {
  const releaseAt = Number(res?.idleReleaseAtMs)
  const serverNow = Number(res?.serverNowMs)
  if (Number.isFinite(releaseAt) && Number.isFinite(serverNow) && releaseAt > 0) {
    deadlineAt = performance.now() + Math.max(0, releaseAt - serverNow - latencyMs)
  } else {
    deadlineAt = null
  }
  update({
    probed: true,
    recentFailure: !!res?.recentFailure,
    idlePoolReady: !!res?.poolReady,
    idleReleased: !!res?.idleReleased,
    idleTimeoutSecs: Number(res?.idleTimeoutSecs) || 0,
    idleRemainingMs: computeRemaining(),
  })
  // 首次拿到释放时刻时补启动倒计时节拍（此前 deadline 为 null，tick 不会自续）
  scheduleTick()
}

/** 拉一次连接池状态（纯内存，不建连）并续期下一次轮询 */
async function poll() {
  pollTimer = null
  if (listeners.size === 0) return
  // 重入保护：进行中的那次结束时自己会续期，避免叠加请求
  if (polling) return
  polling = true
  const startedAt = performance.now()
  try {
    const res = await invoke('db_pool_status')
    applyStatus(res, performance.now() - startedAt)
  } catch {
    // 探活失败保持上一次已知状态（不清成绿灯），只标记已探活
    update({ probed: true })
  } finally {
    polling = false
    schedulePoll()
  }
}

/** 安排下一次轮询；`delay` 省略时按「是否进入倒计时窗口」自动选快/慢节拍 */
function schedulePoll(delay) {
  if (listeners.size === 0) return
  if (pollTimer !== null) clearTimeout(pollTimer)
  let d = delay
  if (d === undefined) {
    const r = computeRemaining()
    d = r !== null && r <= IDLE_FAST_WINDOW_MS ? IDLE_POLL_FAST_MS : IDLE_POLL_SLOW_MS
  }
  pollTimer = setTimeout(poll, d)
}

/** 倒计时节拍：只在「显示秒数」变化时推送，避免同一秒内重复渲染 */
function tick() {
  tickTimer = null
  if (listeners.size === 0) return
  const remaining = computeRemaining()
  if (remaining !== null) {
    const prevSec = state.idleRemainingMs === null ? null : Math.ceil(state.idleRemainingMs / 1000)
    const nextSec = Math.ceil(remaining / 1000)
    if (prevSec !== nextSec) update({ idleRemainingMs: remaining })
  }
  scheduleTick()
  // 本地已到预计释放时刻但还没收到「已释放」：立即复核一次后端真实状态
  // （后端若因在途查询没能回收，会返回新的预计时刻，不会形成 1s 空转）
  if (remaining === 0 && !state.idleReleased) schedulePoll(0)
}

function scheduleTick() {
  if (listeners.size === 0) return
  if (tickTimer !== null) clearTimeout(tickTimer)
  const r = computeRemaining()
  if (r === null) {
    tickTimer = null
    return
  }
  // 倒计时窗口内每秒一跳；窗口外最多 5s 一跳，但精确唤醒在 10s 边界上，
  // 保证「即将释放的 10s」那一刻不会因为节拍错过而晚闪
  const d = r <= IDLE_FAST_WINDOW_MS
    ? IDLE_TICK_FAST_MS
    : Math.min(IDLE_TICK_SLOW_MS, Math.max(250, r - IDLE_WARN_MS + 50))
  tickTimer = setTimeout(tick, d)
}

function startSync() {
  if (syncing) return
  syncing = true
  poll()
  scheduleTick()
}

function stopSync() {
  syncing = false
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (tickTimer !== null) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
}

// ── 请求生命周期上报（由 dbCall 调用） ────────────────────

export function dbRequestStart() {
  // 新请求会刷新后端 last_activity、旧倒计时随即作废：先清掉，
  // 避免绿灯后仍按旧时刻显示「即将释放」。
  deadlineAt = null
  update({ inflight: state.inflight + 1, idleRemainingMs: null, idleReleased: false })
}

export function dbRequestEnd(ok) {
  // 请求期间 last_activity 已变，旧 deadline 不可信；交给轮询重新取
  deadlineAt = null
  update({
    inflight: Math.max(0, state.inflight - 1),
    lastOutcome: ok,
    // 成功即视为连接恢复；失败置红。后端 pool 内部语义一致
    recentFailure: ok ? false : true,
    probed: true,
    idleRemainingMs: null,
  })
  // 请求结束后尽早拿到新的释放时刻（纯内存命令，不建连）
  schedulePoll(1000)
}

// ── 通知长连接状态（由 NotificationContext 从 Tauri 事件写入） ──

/**
 * 写入通知长连接状态。信号灯把「实时推送是否在线」并入同一颗灯：
 * 绿色=推送在线；黄色慢闪=推送重连中（RPC 仍可用）；红色=登录失效。
 */
export function setWsState(payload) {
  const wsState = payload?.state || null
  const retryMs = Number(payload?.retry_in_ms)
  update({
    wsState,
    wsRetryInMs: Number.isFinite(retryMs) && retryMs > 0 ? retryMs : null,
    wsSinceMs: Number(payload?.since_ms) || null,
  })
}

// ── 状态推导与文案 ───────────────────────────────────────

/** 由快照推导信号灯状态字 */
export function deriveNetStatus(s) {
  if (s.inflight > 0 && (s.recentFailure || s.lastOutcome === false)) return 'retrying'
  if (s.inflight > 0) return 'busy'
  if (s.recentFailure || s.lastOutcome === false) return 'down'
  // 通知推送鉴权失败：令牌已失效，后续 RPC 同样会 401
  if (s.wsState === 'auth_required') return 'authRequired'
  // 推送在重连：RPC 仍可用，用黄灯与「数据库不可用」的红色区分
  if (s.wsState === 'backoff') return 'wsBackoff'
  // 空闲释放：池已被回收 → 黄灯常亮；逼近阈值 → 黄灯闪烁（倒计时）
  if (s.idleReleased && !s.idlePoolReady) return 'released'
  if (s.idleRemainingMs !== null && s.idleRemainingMs !== undefined) {
    if (s.idleRemainingMs <= IDLE_CRITICAL_MS) return 'idleCritical'
    if (s.idleRemainingMs <= IDLE_WARN_MS) return 'idleWarn'
  }
  if (s.wsState === 'connected') return 'ok'
  if (s.lastOutcome === true) return 'ok'
  if (s.probed && !s.recentFailure) return 'ok'
  return 'unknown'
}

/** 倒计时文案用的秒数：向上取整并至少 1 秒，避免显示「0 秒后」 */
export function idleCountdownSecs(s) {
  if (s.idleRemainingMs === null || s.idleRemainingMs === undefined) return 0
  return Math.max(1, Math.ceil(s.idleRemainingMs / 1000))
}

/**
 * 信号灯的 hover 文案（已翻译）。
 * 状态字与 i18n key 一一对应（`netStatus.*`），倒计时状态额外带上秒数与阈值。
 * @param {string} status deriveNetStatus 的结果
 * @param {object} s 状态快照
 * @param {(k: string, vars?: object) => string} t i18n 翻译函数
 */
export function netStatusTooltip(status, s, t) {
  const baseSecs =
    status === 'wsBackoff'
      ? Math.max(1, Math.ceil((s.wsRetryInMs || 0) / 1000))
      : idleCountdownSecs(s)
  const base = t(`netStatus.${status}`, {
    secs: baseSecs,
    timeout: s.idleTimeoutSecs || 60,
  })
  // wsBackoff / authRequired 两个灯态本身就是推送状态，不再重复追加一行
  if (status === 'wsBackoff' || status === 'authRequired') return base
  // 同一颗灯兼报「通知推送」状态：RPC 正常但推送掉线时，hover 文案给出原因
  const wsKey = {
    connected: 'netStatus.wsStateConnected',
    backoff: 'netStatus.wsStateBackoff',
    auth_required: 'netStatus.wsStateAuthRequired',
    unsupported: 'netStatus.wsStateUnsupported',
    disabled: 'netStatus.wsStateDisabled',
  }[s.wsState]
  if (!wsKey) return base
  const wsText = t(wsKey, {
    secs: Math.max(1, Math.ceil((s.wsRetryInMs || 0) / 1000)),
  })
  return `${base}\n${wsText}`
}
