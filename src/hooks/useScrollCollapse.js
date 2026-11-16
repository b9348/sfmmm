import { useEffect, useRef, useState } from 'react'

/**
 * 移动端「下滚收起、上滚呼出」。
 *
 * 只订阅原生 scroll（passive），并用 requestAnimationFrame 合帧：滚动事件本身
 * 不 setState，一帧最多判定一次，避免触控板/滚轮的密集事件把渲染拖崩。
 *
 * 判定不看单帧 delta——惯性滚动里单帧方向经常正负跳变，按单帧判会抽风；
 * 这里累计「同一方向的位移」，越过阈值才切换，方向一变就把反向计数清零：
 * - 下滚累计 ≥ hideThreshold 才收起（收起要有耐心，防误触）
 * - 上滚累计 ≥ showThreshold 才展开（展开比收起更灵敏，回看内容更顺手）
 * - 不足一屏 / 已回到顶部（≤ topSlack）一律展开，
 *   避免出现「页面明明在顶端、顶部栏却是收起态」的死区
 *
 * 用法：
 *   const { scrollRef, collapsed } = useScrollCollapse({ enabled: isNarrow })
 *   <div ref={scrollRef}>…</div>
 *
 * enabled 为 false（宽屏）时不挂监听，对外也恒定返回 false；
 * 这里故意不在 effect 里 setState（react-hooks/set-state-in-effect），
 * 切回宽屏时靠返回值短路，切回窄屏后由第一次滚动重新判定。
 */
export function useScrollCollapse({
  enabled = true,
  hideThreshold = 24,
  showThreshold = 16,
  topSlack = 24,
} = {}) {
  const scrollRef = useRef(null)
  const [collapsed, setCollapsed] = useState(false)
  const trackRef = useRef({ lastTop: 0, down: 0, up: 0 })

  useEffect(() => {
    const el = scrollRef.current
    if (!enabled || !el) return undefined

    const track = trackRef.current
    track.lastTop = el.scrollTop
    track.down = 0
    track.up = 0

    let frame = 0
    let disposed = false

    const evaluate = () => {
      frame = 0
      if (disposed) return
      const top = el.scrollTop
      const delta = top - track.lastTop
      track.lastTop = top
      const maxTop = el.scrollHeight - el.clientHeight

      // 内容撑不满 / 已经贴着顶部：没有「继续下滚」可言，直接展开
      if (maxTop <= 1 || top <= topSlack) {
        track.down = 0
        track.up = 0
        setCollapsed(prev => (prev ? false : prev))
        return
      }

      if (delta > 0) {
        track.down += delta
        track.up = 0
      } else if (delta < 0) {
        track.up -= delta
        track.down = 0
      }

      if (track.down >= hideThreshold) {
        track.down = 0
        setCollapsed(prev => (prev ? prev : true))
      } else if (track.up >= showThreshold) {
        track.up = 0
        setCollapsed(prev => (prev ? false : prev))
      }
    }

    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(evaluate)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    // 容器尺寸变化（窗口缩放、顶部栏收起/展开、内容高度变化）也要重新判定：
    // 否则「已收起 + 内容刚好缩到不满一屏」时再也滚不出事件，顶部栏就卡没了
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(evaluate)
    })
    ro?.observe(el)
    // 挂上监听时先按当前位置判定一次：从宽屏切回窄屏、或上次收起后重新进入页面，
    // 如果此时正贴在最顶部就必须立刻展开，否则会卡在「顶端却是收起态」的死区。
    // 放在 rAF 里不算 effect 内同步 setState，且能保证布局已稳定
    frame = requestAnimationFrame(evaluate)

    return () => {
      disposed = true
      el.removeEventListener('scroll', onScroll)
      ro?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [enabled, hideThreshold, showThreshold, topSlack])

  return { scrollRef, collapsed: enabled && collapsed }
}
