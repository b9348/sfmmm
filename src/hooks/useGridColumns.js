import { useCallback, useEffect, useState } from 'react'

/**
 * 「每行 N 个」只是上限：容器宽度放不下 N 张最小宽度卡片时自动减列。
 * 直接用 repeat(N, 1fr) 会把卡片挤成窄条（窗口小或 N 调大时尤其明显）。
 */
export function useGridColumns(maxColumns, { minCardWidth = 280, gap = 12 } = {}) {
  const [columns, setColumns] = useState(maxColumns)
  const [node, setNode] = useState(null)
  const ref = useCallback((el) => setNode(el), [])

  useEffect(() => {
    if (!node) return
    const update = () => {
      const width = node.clientWidth
      // 隐藏的 tab（display:none）宽度为 0，等可见后 ResizeObserver 会再算一次
      if (width <= 0) return
      const fit = Math.floor((width + gap) / (minCardWidth + gap))
      setColumns(Math.min(maxColumns, Math.max(1, fit)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, maxColumns, minCardWidth, gap])

  return [ref, columns]
}
