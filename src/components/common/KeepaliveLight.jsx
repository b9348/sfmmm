import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NetStatusLight } from './NetStatusLight'
import { pingServer } from '../../services/workshopApi'
import { formatDbError } from '../../services/dbCall'

// 每 30 秒发一次轻量探针，反映云服务与数据库是否可达。
const KEEPALIVE_INTERVAL_MS = 30000

// 状态 → NetStatusLight 的色值键：灰=未开始/已停止，黄=请求中，绿=最近成功，红=最近失败
const LIGHT_STATUS = {
  idle: 'unknown',
  pending: 'busy',
  ok: 'ok',
  fail: 'down',
}

function formatClock(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 编辑页云服务/数据库保活信号灯。
 *
 * 自己持有轮询定时器与四态（idle/pending/ok/fail），只重渲染自己，
 * 不把状态提到页面级，避免整页跟着重渲染。
 * 复用 NetStatusLight 的受控模式：同款尺寸/token/动画，且受控时不会额外探活。
 * 失败静默：不弹 toast、不写日志，唯一的反馈就是灯变红。
 *
 * 轮询本身即探活：每轮请求结束就把结果映射成灯色，不额外发任何探测请求。
 */
export function KeepaliveLight({ userId, paused = false }) {
  const { t } = useTranslation()
  const [state, setState] = useState({ status: 'idle', lastSuccess: 0, lastFail: 0, reason: '' })
  // 翻译函数只用于失败原因文案：用 ref 读取，避免它影响轮询定时器的生命周期
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    // 业务正忙（上传/打包/保存）：不抢唯一串行连接，同时把灯复位成灰色「未开始」
    if (paused) {
      setState((prev) => ({ ...prev, status: 'idle', reason: '' }))
      return undefined
    }
    let stopped = false
    let timer = null
    // 递归 setTimeout：上一轮请求结束才排下一轮，天然不会堆积。
    // 卸载/暂停时清理定时器；未登录也照常轮询（探针不需要身份），
    // 灯色只反映云服务与数据库是否可达。
    const schedule = () => {
      if (!stopped) timer = setTimeout(run, KEEPALIVE_INTERVAL_MS)
    }
    async function run() {
      timer = null
      if (stopped) return
      // 先切黄，请求结束再按结果切绿/红——灯色就是这次查询的真实结果
      setState((prev) => ({ ...prev, status: 'pending' }))
      try {
        await pingServer()
        if (stopped) return
        setState((prev) => ({ ...prev, status: 'ok', lastSuccess: Date.now() }))
      } catch (e) {
        if (stopped) return
        setState((prev) => ({
          ...prev,
          status: 'fail',
          lastFail: Date.now(),
          reason: formatDbError(e, tRef.current),
        }))
      }
      schedule()
    }
    // 进入页面立即探活一次，之后每 30 秒一轮（不依赖页面其它刷新时机）
    run()
    return () => {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }, [userId, paused])

  const stamp = state.status === 'fail' ? state.lastFail : state.lastSuccess
  const time = stamp ? formatClock(stamp) : ''
  let title = t('workshop.keepaliveIdle')
  if (state.status === 'pending') title = t('workshop.keepalivePending')
  else if (state.status === 'ok') title = t('workshop.keepaliveOk', { time })
  else if (state.status === 'fail') {
    title = state.reason
      ? t('workshop.keepaliveFail', { time, reason: state.reason })
      : t('workshop.keepaliveFailNoReason', { time })
  }

  return (
    <NetStatusLight
      status={LIGHT_STATUS[state.status]}
      loading={state.status === 'pending'}
      title={title}
    />
  )
}
