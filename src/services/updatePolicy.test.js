import { describe, it, expect } from 'vitest'
import { AUTO_UPDATE_BACKOFF_MS, isInBackoff, canAutoApply, shouldDownload } from './updatePolicy'

describe('isInBackoff', () => {
  const now = 1_700_000_000_000

  it('无失败记录（空串/undefined）不处于退避', () => {
    expect(isInBackoff('', now)).toBe(false)
    expect(isInBackoff(undefined, now)).toBe(false)
  })

  it('24h 内失败 → 退避中', () => {
    const failAt = new Date(now - AUTO_UPDATE_BACKOFF_MS + 1000).toISOString()
    expect(isInBackoff(failAt, now)).toBe(true)
  })

  it('超过 24h 的失败记录 → 退避已解除', () => {
    const failAt = new Date(now - AUTO_UPDATE_BACKOFF_MS - 1000).toISOString()
    expect(isInBackoff(failAt, now)).toBe(false)
  })

  it('非法时间戳按无记录处理（不阻塞）', () => {
    expect(isInBackoff('not-a-date', now)).toBe(false)
  })
})

describe('canAutoApply（版本门禁）', () => {
  const ready = (overrides = {}) => ({
    status: 'ready',
    installerExists: true,
    version: '1.2.0',
    ...overrides,
  })

  it('就绪 + 文件在盘 + 版本匹配 → 允许自动应用', () => {
    expect(canAutoApply(ready(), '1.2.0')).toBe(true)
  })

  it('版本不匹配（陈旧/其他渠道旧版）→ 拒绝', () => {
    expect(canAutoApply(ready(), '1.3.0')).toBe(false)
  })

  it('版本为空（migration 16 遗留行）→ 拒绝', () => {
    expect(canAutoApply(ready({ version: '' }), '1.2.0')).toBe(false)
    expect(canAutoApply(ready({ version: '' }), '')).toBe(false)
  })

  it('安装包不在盘上 → 拒绝', () => {
    expect(canAutoApply(ready({ installerExists: false }), '1.2.0')).toBe(false)
  })

  it('状态非就绪（下载中/失败/无任务）→ 拒绝', () => {
    expect(canAutoApply(ready({ status: 'downloading' }), '1.2.0')).toBe(false)
    expect(canAutoApply(ready({ status: 'failed' }), '1.2.0')).toBe(false)
    expect(canAutoApply(null, '1.2.0')).toBe(false)
  })

  it('最新版参照为空 → 拒绝（不基于陈旧/缺失 UI 状态误武装）', () => {
    expect(canAutoApply(ready(), '')).toBe(false)
  })
})

describe('shouldDownload', () => {
  it('版本门禁不通过 → 应重新下载', () => {
    expect(shouldDownload({ status: 'ready', installerExists: true, version: '1.1.0' }, '1.2.0')).toBe(true)
    expect(shouldDownload(null, '1.2.0')).toBe(true)
  })

  it('版本门禁通过 → 不应重新下载', () => {
    expect(shouldDownload({ status: 'ready', installerExists: true, version: '1.2.0' }, '1.2.0')).toBe(false)
  })
})
