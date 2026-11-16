import { describe, it, expect } from 'vitest'
import { deriveNetStatus, idleCountdownSecs, netStatusTooltip } from './netStatus'

/** 构造信号灯快照（默认：无在途请求、无失败、已知空闲倒计时） */
function snap(patch = {}) {
  return {
    inflight: 0,
    lastOutcome: true,
    recentFailure: false,
    probed: true,
    idleRemainingMs: null,
    idleTimeoutSecs: 60,
    idlePoolReady: true,
    idleReleased: false,
    ...patch,
  }
}

describe('deriveNetStatus', () => {
  it('在途查询优先于空闲状态：进行中一律显示 busy', () => {
    expect(deriveNetStatus(snap({ inflight: 1, idleRemainingMs: 3000 }))).toBe('busy')
  })

  it('在途且此前失败 → retrying（红黄交替优先于空闲倒计时）', () => {
    expect(deriveNetStatus(snap({ inflight: 1, recentFailure: true, idleRemainingMs: 3000 }))).toBe('retrying')
  })

  it('无在途且最近失败 → down，不被空闲倒计时盖住', () => {
    expect(deriveNetStatus(snap({ lastOutcome: false, idleRemainingMs: 3000 }))).toBe('down')
  })

  it('倒计时边界：10s 内进入 idleWarn，5s 内进入 idleCritical', () => {
    expect(deriveNetStatus(snap({ idleRemainingMs: 10001 }))).toBe('ok')
    expect(deriveNetStatus(snap({ idleRemainingMs: 10000 }))).toBe('idleWarn')
    expect(deriveNetStatus(snap({ idleRemainingMs: 5001 }))).toBe('idleWarn')
    expect(deriveNetStatus(snap({ idleRemainingMs: 5000 }))).toBe('idleCritical')
    expect(deriveNetStatus(snap({ idleRemainingMs: 0 }))).toBe('idleCritical')
  })

  it('已释放（池未建）→ released；池已重建则回到正常态', () => {
    expect(deriveNetStatus(snap({ idleReleased: true, idlePoolReady: false }))).toBe('released')
    expect(deriveNetStatus(snap({ idleReleased: true, idlePoolReady: true }))).toBe('ok')
  })

  it('尚未探活且无请求 → unknown', () => {
    expect(deriveNetStatus(snap({ probed: false, lastOutcome: null }))).toBe('unknown')
  })
})

describe('idleCountdownSecs', () => {
  it('向上取整并至少 1 秒（不显示「0 秒后释放」）', () => {
    expect(idleCountdownSecs(snap({ idleRemainingMs: 1 }))).toBe(1)
    expect(idleCountdownSecs(snap({ idleRemainingMs: 0 }))).toBe(1)
    expect(idleCountdownSecs(snap({ idleRemainingMs: 4200 }))).toBe(5)
    expect(idleCountdownSecs(snap({ idleRemainingMs: 10000 }))).toBe(10)
  })

  it('未知倒计时返回 0', () => {
    expect(idleCountdownSecs(snap())).toBe(0)
  })
})

describe('netStatusTooltip', () => {
  const t = (key, vars) => `${key}|${vars.secs}|${vars.timeout}`

  it('倒计时状态带上秒数与空闲阈值', () => {
    expect(netStatusTooltip('idleCritical', snap({ idleRemainingMs: 3000 }), t))
      .toBe('netStatus.idleCritical|3|60')
  })

  it('释放状态带上阈值（无秒数）', () => {
    expect(netStatusTooltip('released', snap({ idleRemainingMs: null }), t))
      .toBe('netStatus.released|0|60')
  })
})
