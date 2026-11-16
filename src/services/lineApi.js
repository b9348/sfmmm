/**
 * 数据库线路：直连云数据库（大陆） 或 经香港中继服务器查询。
 *
 * - 线路由 Rust 端（src-tauri/src/db/line.rs）决定并持久化到 config.db，
 *   前端只做展示与偏好切换，不缓存「当前生效线路」作为判断依据。
 * - 切换偏好会丢弃当前连接池，新线路在下一次查询时生效；在途查询仍在旧连接上
 *   跑完（线路在它建池时已固定），不会被打断。
 */

import { invoke } from '@tauri-apps/api/core'

/** 线路偏好：auto（探测可达则中继）/ direct（强制直连）/ relay（强制中继） */
export const LINE_MODES = ['auto', 'direct', 'relay']

/** 状态未就绪时的安全默认值：直连是既有能力，永远可用 */
const EMPTY_STATUS = {
  mode: 'auto',
  effective: 'direct',
  sinceMs: 0,
  serverNowMs: 0,
  relayConfigured: false,
  relayAvailable: null,
  relayLatencyMs: null,
  relayCoolingDown: false,
  relayMaxConns: 15,
  lastReason: null,
}

/**
 * 拉取线路状态快照（纯内存读取，不建连、不做 I/O）。
 * 失败返回 null，由调用方决定是否降级展示。
 */
export async function getLineStatus() {
  try {
    return await invoke('db_line_status')
  } catch {
    return null
  }
}

/**
 * 设置线路偏好并持久化。mode 必须是 LINE_MODES 之一。
 * 返回最新状态；后端拒绝（参数非法）时抛错，由调用方回滚 UI。
 */
export async function setLineMode(mode) {
  if (!LINE_MODES.includes(mode)) {
    throw new Error(`无效的线路参数: ${mode}`)
  }
  return await invoke('db_line_set', { mode })
}

/**
 * 主动探测中继接口并重算线路。未配置中继时后端返回错误文案。
 */
export async function probeLine() {
  return await invoke('db_line_probe')
}

/** 状态对象归一化：缺失字段补安全默认，避免 UI 因 null 崩溃 */
export function normalizeLineStatus(status) {
  if (!status) return { ...EMPTY_STATUS }
  return {
    ...EMPTY_STATUS,
    ...status,
    // relayAvailable 语义是三态（true/false/null=未探测），不能被默认值覆盖成 false
    relayAvailable: status.relayAvailable ?? null,
    relayLatencyMs: status.relayLatencyMs ?? null,
  }
}
