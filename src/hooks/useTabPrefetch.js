import { useEffect, useState } from 'react'

/**
 * 通用 tab 预加载（预请求）hook。
 *
 * 当前 tab 激活时，自动把「下一个 tab」标记为已挂载（预加载）：
 * 下一个 tab 的面板以 display:none 隐藏挂载，其数据请求在后台提前发出；
 * 用户切换到该 tab 时数据已就绪，无需等待加载。
 *
 * 用法：渲染面板时对 mounted 集合中每个 tab 保持固定挂载（不随切换卸载），
 * 仅用 display 控制显隐，切换即可即时展示预加载结果。
 *
 * @param {string} current 当前 tab 值
 * @param {string[]} tabs 按顺序排列的全部 tab 值（需稳定引用，如模块级常量）
 * @returns {{ mounted: Set<string> }} 已挂载（含已预加载）的 tab 集合
 */
export function useTabPrefetch(current, tabs) {
  const [mounted, setMounted] = useState(() => new Set([current]))
  const idx = tabs.indexOf(current)
  const next = idx >= 0 && idx < tabs.length - 1 ? tabs[idx + 1] : null

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted((prev) => {
      // 通过 hash 直接跳到的 tab 可能尚未挂载，先补挂当前 tab
      if (!prev.has(current)) {
        const s = new Set(prev)
        s.add(current)
        if (next !== null) s.add(next)
        return s
      }
      // 当前已挂载：只需补挂下一个 tab（触发其预请求）
      if (next === null || prev.has(next)) return prev
      const s = new Set(prev)
      s.add(next)
      return s
    })
  }, [current, next])

  return { mounted }
}
