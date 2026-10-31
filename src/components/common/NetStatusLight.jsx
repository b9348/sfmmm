import { useEffect, useSyncExternalStore } from 'react'
import { makeStyles, tokens } from '@fluentui/react-components'
import {
  subscribeNetStatus,
  getNetStatusSnapshot,
  deriveNetStatus,
  NET_STATUS_LABEL,
  probePoolStatus,
} from '../../services/netStatus'

// Griffel 不支持内联 keyframes 定义，闪烁/旋转动画用全局 <style> 注入一次，
// makeStyles 里直接引用 keyframes 名。
const KEYFRAMES_CSS = `
@keyframes sfmmm-blink-opacity { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
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
})

/**
 * 网络状态信号灯：无点击交互的悬浮指示灯（FloatingActions 第一项固定渲染）。
 * 绿常亮=连接正常；黄闪+旋转外圈=查询中；红常亮=连接失败；红黄交替+旋转外圈=失败后重试中。
 */
export function NetStatusLight() {
  const styles = useStyles()
  const status = useSyncExternalStore(subscribeNetStatus, getNetStatusSnapshot, getNetStatusSnapshot)
  const derived = deriveNetStatus(status)
  const loading = derived === 'busy' || derived === 'retrying'

  useEffect(() => { injectKeyframes(); probePoolStatus() }, [])

  return (
    <div className={styles.wrap} title={`数据库网络：${NET_STATUS_LABEL[derived]}`} aria-label={NET_STATUS_LABEL[derived]}>
      <div className={`${styles.light} ${styles[derived]}`} />
      {loading && <div className={styles.ring} />}
    </div>
  )
}
