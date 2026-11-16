import { useEffect, useState } from 'react'

/**
 * 订阅一个媒体查询（如 '(max-width: 768px)'），窗口跨过断点时触发重渲染。
 *
 * 只用于「渲染内容要按宽度变」的场景（比如窄屏隐藏 tab 图标）；
 * 纯样式差异仍写在 makeStyles 的 @media 里，不要走 JS。
 * 初始值在挂载时读取，之后靠 matchMedia 的 change 事件同步。
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const mql = window.matchMedia(query)
    const onChange = (e) => setMatches(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
