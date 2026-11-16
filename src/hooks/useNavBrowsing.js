import { useEffect, useRef } from 'react'
import { canGoBack, canGoForward, goBack, goForward, restoreView } from '../utils/navHistory'

/**
 * 鼠标侧键导航：XButton1（button === 3）后退，XButton2（button === 4）前进。
 *
 * 页面切换本项目不写浏览器历史，所以侧键统一走 navHistory 的视图栈：
 * App 挂唯一一处监听，先把按键派发给「最上层且可见」的详情页处理器
 * （详情页要处理自己的详情栈与楼层），没人接管时再按视图栈后退/前进。
 *
 * 只有一个 window 监听，详情页用 useDetailNav 注册处理器；各页面自带的
 * useMouseBackButton 也走注册，避免多处监听同时响应导致「一次侧键退两层」。
 */

// 详情处理器：后注册的在上层（详情后于列表挂载）
const handlers = []

/**
 * 详情页注册后退/前进处理器。
 * @param {() => boolean|void} onBack 处理自己的详情层；返回 false 表示放行给导航历史
 * @param {() => boolean|void} onForward
 * @param {boolean} active 组件可见时才接管（隐藏标签里的详情不响应）
 */
export function useDetailNav({ onBack, onForward, active = true } = {}) {
  const backRef = useRef(onBack)
  const forwardRef = useRef(onForward)
  const activeRef = useRef(active)

  useEffect(() => {
    backRef.current = onBack
    forwardRef.current = onForward
    activeRef.current = active
  }, [onBack, onForward, active])

  useEffect(() => {
    if (typeof onBack !== 'function' && typeof onForward !== 'function') return undefined
    const entry = {
      run: (isBack) => {
        if (!activeRef.current) return false
        const cb = isBack ? backRef.current : forwardRef.current
        if (typeof cb !== 'function') return false
        // 详情页注册了回调就默认由它处理；只有显式返回 false 才放行给导航历史
        return cb() !== false
      },
    }
    handlers.push(entry)
    return () => {
      const i = handlers.indexOf(entry)
      if (i >= 0) handlers.splice(i, 1)
    }
    // 处理器只在挂载/卸载时增删，回调与可见性通过 ref 取最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** 从最上层开始找第一个可见的详情处理器，交给它处理 */
function dispatchToDetail(isBack) {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    if (handlers[i].run(isBack)) return true
  }
  return false
}

/**
 * App 级：安装唯一的侧键监听。详情页都不接管时按导航历史后退/前进。
 */
export function useNavBrowsing() {
  useEffect(() => {
    const onMouseUp = (e) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      const isBack = e.button === 3
      // 先交给详情页：它掌握自己的详情栈与楼层，返回目标比页面级历史更精确
      if (dispatchToDetail(isBack)) return
      const view = isBack
        ? (canGoBack() ? goBack() : null)
        : (canGoForward() ? goForward() : null)
      if (view) restoreView(view)
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])
}

/** 详情页内部只处理后退的兼容入口（签名与原 useMouseBackButton 一致） */
export function useMouseBackButton(onBack, options = {}) {
  useDetailNav({ onBack, ...options })
}
