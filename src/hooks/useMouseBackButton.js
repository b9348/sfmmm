import { useDetailNav } from './useNavBrowsing'

/**
 * 详情页监听鼠标侧键返回。
 *
 * 侧键事件由 useNavBrowsing 在 App 顶层挂唯一一处监听，再分发给最上层的详情页；
 * 这里只负责注册回调，绝不能自己再 addEventListener——否则一次侧键会触发多层返回。
 *
 * @param {() => void} onBack 返回回调；返回 false 表示不处理，交给上层/导航历史
 * @param {{active?: boolean}} options active=false 时（所在标签不可见）不接管侧键
 */
export function useMouseBackButton(onBack, options = {}) {
  useDetailNav({ onBack, active: options.active !== false })
}
