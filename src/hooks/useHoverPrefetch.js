import { useCallback, useEffect, useRef } from 'react'

/**
 * 卡片 hover 预取：停留 delay 毫秒后才请求；鼠标按下则立即预取。
 * 返回的 onMouseLeave 会取消待触发的预取。
 */
export function useHoverPrefetch(prefetch, { delay = 700 } = {}) {
  const timerRef = useRef(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const onMouseEnter = useCallback((item) => {
    clearTimer()
    timerRef.current = setTimeout(() => prefetch(item), delay)
  }, [clearTimer, prefetch, delay])

  const onMouseDown = useCallback((item) => {
    clearTimer()
    prefetch(item)
  }, [clearTimer, prefetch])

  useEffect(() => clearTimer, [clearTimer])

  return { onMouseEnter, onMouseLeave: clearTimer, onMouseDown }
}
