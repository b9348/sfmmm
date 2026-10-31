/**
 * 数据库网络状态 mini-store（信号灯数据源）
 *
 * workshopApi 的 dbCall 在每次请求生命周期上报状态，组件通过
 * useSyncExternalStore 消费。零依赖，全部模块级状态。
 *
 * 状态推导（见 useDbNetStatus）：
 * - unknown  初始（本会话尚无请求且探活未完成）→ 灰常亮
 * - down     最近请求失败且无 in-flight → 红常亮
 * - retrying in-flight 但 recentFailure 置位（失败后重试中）→ 红黄交替闪
 * - busy     in-flight（正在查询数据库）→ 黄闪烁
 * - ok       最近请求成功且空闲 → 绿常亮
 */

import { invoke } from '@tauri-apps/api/core'

let state = {
  inflight: 0,
  /** 本会话最近一次请求成败：null=还没有, true=成功, false=失败 */
  lastOutcome: null,
  /** 最近是否连接失败（与后端 recent_failure 同步校准） */
  recentFailure: false,
  /** 启动探活是否已完成 */
  probed: false,
}

const listeners = new Set()

export function subscribeNetStatus(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getNetStatusSnapshot() {
  return state
}

function update(patch) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn(state))
}

export function dbRequestStart() {
  update({ inflight: state.inflight + 1 })
}

export function dbRequestEnd(ok) {
  update({
    inflight: Math.max(0, state.inflight - 1),
    lastOutcome: ok,
    // 成功即视为连接恢复；失败置红。后端 pool 内部语义一致
    recentFailure: ok ? false : true,
    probed: true,
  })
}

/**
 * 启动探活：读后端连接池 recent_failure 原子标志（不触碰 MySQL），
 * 用于本会话首次请求前校准红/绿（例如重启 app 前数据库已断）。
 * 只调一次；失败静默（探活失败保持 unknown/灰灯，不影响主流程）。
 */
let probed = false
export async function probePoolStatus() {
  if (probed) return
  probed = true
  try {
    const res = await invoke('db_pool_status')
    update({ recentFailure: !!res?.recentFailure, probed: true })
  } catch {
    update({ probed: true })
  }
}

/** 由快照推导信号灯状态字 */
export function deriveNetStatus(s) {
  if (s.inflight > 0 && (s.recentFailure || s.lastOutcome === false)) return 'retrying'
  if (s.inflight > 0) return 'busy'
  if (s.recentFailure || s.lastOutcome === false) return 'down'
  if (s.lastOutcome === true) return 'ok'
  if (s.probed && !s.recentFailure) return 'ok'
  return 'unknown'
}

export const NET_STATUS_LABEL = {
  ok: '数据库连接正常',
  busy: '正在查询数据库…',
  down: '无法连接到数据库',
  retrying: '连接失败，重试中…',
  unknown: '网络状态未知',
}
