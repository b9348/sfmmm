import { useCallback, useEffect, useRef, useState } from 'react'
import { getConfig, setConfig } from '../services/dbHelper'

/**
 * 可拖拽调整高度并持久化到 sqlite config 表。
 *
 * 用法：把返回的 attach 挂到真正被拉伸的元素上（textarea / 可 resize 的容器），
 * 并用 heightStyle() 输出内联样式（元素须自带 resize: vertical）。
 *
 * - 未存过值时用 defaultHeight 渲染，不会写库
 * - 拖动结束后由 ResizeObserver 防抖记录，只在高度确实变化时写一次
 */
export function usePersistedHeight(key, {
  min = 60,
  max = 2000,
  defaultHeight = 192,
  debounceMs = 400,
  logTag = 'usePersistedHeight',
} = {}) {
  const [height, setHeight] = useState(null)
  const [node, setNode] = useState(null)
  const lastSavedRef = useRef(null)
  // 首次观察拿到的是元素的初始高度，不是用户拖出来的，跳过
  const skipFirstRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const raw = await getConfig(key)
        if (cancelled || raw === null) return
        const parsed = parseInt(raw, 10)
        if (Number.isNaN(parsed)) return
        const clamped = Math.min(max, Math.max(min, parsed))
        lastSavedRef.current = clamped
        setHeight(clamped)
      } catch (e) {
        console.warn(`[${logTag}] 读取 ${key} 失败:`, e)
      }
    })()
    return () => { cancelled = true }
  }, [key, min, max, logTag])

  useEffect(() => {
    if (!node) return
    // 换节点后第一次观察到的仍是初始高度，同样跳过（否则没存过值时也会被写一条）
    skipFirstRef.current = true
    let timer = null
    const observer = new ResizeObserver(() => {
      if (skipFirstRef.current) {
        skipFirstRef.current = false
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => {
        const raw = Math.round(node.getBoundingClientRect().height)
        if (!raw) return
        const next = Math.min(max, Math.max(min, raw))
        if (lastSavedRef.current !== null && Math.abs(next - lastSavedRef.current) < 2) return
        lastSavedRef.current = next
        setHeight(next)
        setConfig(key, String(next)).catch(e => {
          console.warn(`[${logTag}] 保存 ${key} 失败:`, e)
        })
      }, debounceMs)
    })
    observer.observe(node)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [node, key, min, max, debounceMs, logTag])

  /**
   * 供内联样式使用：必须同时脱离 flex 拉伸（flex: 0 0 auto），
   * 否则父级 flex 容器的 grow 会盖掉用户拖出来的高度。
   */
  const heightStyle = useCallback((extra = {}) => ({
    ...extra,
    height: `${height ?? defaultHeight}px`,
    minHeight: `${min}px`,
    flex: '0 0 auto',
  }), [height, defaultHeight, min])

  return { height, attach: setNode, heightStyle }
}
