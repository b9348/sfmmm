import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { makeStyles, tokens } from '@fluentui/react-components'
import {
  subscribeNetStatus,
  getNetStatusSnapshot,
  deriveNetStatus,
  netStatusTooltip,
} from '../../services/netStatus'

// Griffel 不支持内联 keyframes 定义，闪烁/旋转动画用全局 <style> 注入一次，
// makeStyles 里直接引用 keyframes 名。
const KEYFRAMES_CSS = `
@keyframes sfmmm-blink-opacity { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@keyframes sfmmm-blink-opacity-hard { 0%, 100% { opacity: 1; } 50% { opacity: 0.1; } }
@keyframes sfmmm-blink-red-yellow { 0%, 100% { background-color: #d13438; } 50% { background-color: #ffd400; } }
@keyframes sfmmm-spin { to { transform: rotate(360deg); } }
`

let styleInjected = false
function injectKeyframes() {
  if (styleInjected) return
  styleInjected = true
  const style = document.createElement('style')
  style.textContent = KEYFRAMES_CSS
  document.head.appendChild(style)
}

const useStyles = makeStyles({
  // 定位容器：信号灯本体 + 加载时的旋转外圈都锚定在此
  wrap: {
    position: 'relative',
    width: '16px',
    height: '16px',
    flexShrink: 0,
  },
  light: {
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    // 外圈细描边让浅色/深色主题下都清晰可见
    boxShadow: `0 0 0 1px ${tokens.colorNeutralStroke1}`,
  },
  ring: {
    position: 'absolute',
    // 比灯体大一圈的旋转圆环，只显示上弧线制造 spinner 视觉
    left: '-4px',
    top: '-4px',
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    border: `1.5px solid transparent`,
    borderTopColor: tokens.colorBrandForeground1,
    animationName: 'sfmmm-spin',
    animationDuration: '0.9s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
    pointerEvents: 'none',
  },
  ok: { backgroundColor: tokens.colorPaletteGreenForeground1 },
  unknown: { backgroundColor: tokens.colorNeutralForeground4 },
  down: { backgroundColor: tokens.colorPaletteRedForeground1 },
  busy: { backgroundColor: tokens.colorPaletteYellowForeground1, animationName: 'sfmmm-blink-opacity', animationDuration: '1s', animationIterationCount: 'infinite' },
  retrying: { animationName: 'sfmmm-blink-red-yellow', animationDuration: '0.8s', animationIterationCount: 'infinite' },
  // 空闲倒计时（黄灯两档闪烁）：10s 内 2s 一拍的缓闪；最后 5s 改成每秒一次的硬闪；
  // 释放完成转黄灯常亮（与「查询中」的黄灯闪烁区分开）
  idleWarn: {
    backgroundColor: tokens.colorPaletteYellowForeground1,
    animationName: 'sfmmm-blink-opacity',
    animationDuration: '2s',
    animationIterationCount: 'infinite',
  },
  idleCritical: {
    backgroundColor: tokens.colorPaletteYellowForeground1,
    animationName: 'sfmmm-blink-opacity-hard',
    animationDuration: '1s',
    animationIterationCount: 'infinite',
  },
  released: { backgroundColor: tokens.colorPaletteYellowForeground1 },
  // 通知推送掉线（RPC 仍可用）：黄灯慢闪，与「查询中」的快闪区分
  wsBackoff: {
    backgroundColor: tokens.colorPaletteYellowForeground1,
    animationName: 'sfmmm-blink-opacity',
    animationDuration: '2s',
    animationIterationCount: 'infinite',
  },
  // 令牌失效：推送已停止，后续请求也会 401
  authRequired: { backgroundColor: tokens.colorPaletteRedForeground1 },
})

/**
 * 网络状态信号灯。默认作为全局指示灯（FloatingActions 第一项固定渲染），
 * 由 dbCall 上报的全局状态驱动；也可传入 status/title 作为受控指示灯，
 * 供页面级专用状态（如编辑页保活）复用同一套视觉与 token。
 *
 * 绿常亮=连接正常；黄闪+旋转外圈=查询中；红常亮=连接失败；红黄交替+旋转外圈=失败后重试中；
 * 黄灯慢闪=空闲连接即将被释放（10s 内）/ 通知推送重连中；黄灯快闪=释放前最后 5s；
 * 黄灯常亮=连接已按空闲策略释放；红常亮（authRequired）=登录令牌失效，推送已停止。
 */
export function NetStatusLight({ status, title, loading: loadingProp } = {}) {
  const styles = useStyles()
  const { t } = useTranslation()
  const snapshot = useSyncExternalStore(subscribeNetStatus, getNetStatusSnapshot, getNetStatusSnapshot)
  const derived = status || deriveNetStatus(snapshot)
  const loading = loadingProp ?? (!status && (derived === 'busy' || derived === 'retrying'))
  // 全局灯走 i18n 文案（含空闲倒计时秒数）；受控灯由调用方直接给 title
  const text = title || netStatusTooltip(derived, snapshot, t)

  useEffect(() => {
    injectKeyframes()
    // 空闲倒计时由 store 的订阅轮询驱动（首个订阅者自动启动），
    // 受控模式不驱动全局订阅以外的任何探活
  }, [])

  return (
    <div className={styles.wrap} title={text} aria-label={text}>
      <div className={`${styles.light} ${styles[derived]}`} />
      {loading && <div className={styles.ring} />}
    </div>
  )
}
