/**
 * 页面级导航历史：鼠标侧键（后退 / 前进）与「详情返回来源页」共用的视图栈。
 *
 * 本项目的页面切换不写浏览器历史（Tauri 下也没有可靠的前进栈），详情页又是组件
 * 内部的 state，所以这里自己记一份栈：每一项是一次页面停留（顶层标签 + hash）。
 *
 * App 在标签或 hash 每次变化时调用 noteView 对齐游标：
 * - 与上一项相同 → 视为后退（详情组件自己把 hash 改回列表页就是这种）；
 * - 与下一项相同 → 视为前进；
 * - 同标签内的 hash 变化（切子页）→ 就地更新当前项，不产生多余的历史条目；
 * - 其余 → 新分支，丢弃原前进记录后压栈。
 * 这样「侧键前进回到刚才的详情」只需把 hash 改回去，不必关心是谁改的 hash。
 *
 * 「通知页 → 详情」这类跨标签跳转之所以能正确返回，是因为压栈时记下了来源标签：
 * 详情关闭时用 previousView 取上一项，落在其他标签就 restoreView 切回去。
 */

// 视图栈上限：超出的最旧记录被丢弃，避免长期使用无限增长
const MAX_VIEWS = 50
// 恢复视图会分两次触发 noteView（切标签 + 写 hash），其间不压新分支
const RESTORE_MS = 600

let views = []
let cursor = -1
let blockUntil = 0
let restorer = null

export function normalizeHash(hash) {
  const s = String(hash ?? '')
  if (!s || s === '#') return ''
  return s.startsWith('#') ? s : '#' + s
}

/** 由 hash 推导所属顶层标签（与 App 的标签切换同一套规则） */
export function tabOfHash(hash) {
  const h = normalizeHash(hash)
  if (h.startsWith('#/mod/') || h.startsWith('#/discuss/') || h.startsWith('#/workshop')) return 'workshop'
  if (h.startsWith('#/notify')) return 'notify'
  if (h.startsWith('#/localmods')) return 'localmods'
  return ''
}

export function isDetailHash(hash) {
  const h = normalizeHash(hash)
  return h.startsWith('#/mod/') || h.startsWith('#/discuss/')
}

/** 恢复视图的实现由 App 注入（切标签 + 写 hash） */
export function setViewRestorer(fn) {
  restorer = typeof fn === 'function' ? fn : null
}

/** 把游标移到与目标页面匹配的那一项（恢复视图后保持前进/后退可用） */
function moveCursorTo(hash, tab) {
  for (let i = views.length - 1; i >= 0; i -= 1) {
    if (views[i].hash === hash && views[i].tab === tab) {
      cursor = i
      return views[i]
    }
  }
  return null
}

/** 恢复一个视图；未注入实现时返回 false */
export function restoreView(view) {
  if (!view) return false
  const hash = normalizeHash(view.hash)
  const tab = view.tab || tabOfHash(hash)
  // 页面内详情（点赞/评分页等不改 hash 的详情）自己登记了重开方式，优先用它
  if (typeof view.enter === 'function') {
    blockUntil = Date.now() + RESTORE_MS
    view.enter()
    return true
  }
  if (!restorer) return false
  // 先把游标对到目标项：否则「跨标签返回」之后游标仍停在详情上，侧键前进就失效
  moveCursorTo(hash, tab)
  blockUntil = Date.now() + RESTORE_MS
  restorer({ ...view, hash, tab })
  return true
}

/**
 * 显式入栈一页（用于不改 hash 的页面内详情）：记为当前停留，
 * 之后侧键前进即可用 enter 重开它。
 * @param {{tab?:string, hash?:string, key?:string, enter?:() => void}} view
 */
export function enterView(view) {
  const hash = normalizeHash(view?.hash ?? window.location.hash)
  const tab = view?.tab || tabOfHash(hash)
  const cur = views[cursor]
  if (cur && view?.key && cur.key === view.key) {
    views[cursor] = { ...cur, ...view, hash, tab }
    return views[cursor]
  }
  if (cursor < views.length - 1) views = views.slice(0, cursor + 1)
  views.push({ ...view, hash, tab })
  if (views.length > MAX_VIEWS) views = views.slice(views.length - MAX_VIEWS)
  cursor = views.length - 1
  return views[cursor]
}

/** 页面内详情关闭时调用：游标回退一页（页面自己已经切回列表） */
export function leaveView() {
  if (cursor <= 0) return null
  if (!views[cursor]?.enter) return null
  cursor -= 1
  return views[cursor]
}

/**
 * 对齐游标：App 在标签或 hash 每次变化后调用。
 * @param {{tab?:string, hash?:string}} view 当前停留的页面
 */
export function noteView(view) {
  const hash = normalizeHash(view?.hash)
  // 详情页的归属标签由 hash 决定：从通知页点开详情时「改 hash」与「切标签」是两次
  // 状态更新，按 activeTab 记会得到半新半旧的混合态
  const tab = isDetailHash(hash) ? tabOfHash(hash) : (view?.tab || tabOfHash(hash))
  const cur = views[cursor]

  if (cur && cur.hash === hash && cur.tab === tab) return cur

  // 同标签内的 hash 变化（切子页）就地更新，不让子页切换占满历史
  if (cur && cur.tab === tab && !isDetailHash(hash) && !isDetailHash(cur.hash)) {
    views[cursor] = { ...cur, hash }
    return views[cursor]
  }

  const prev = cursor > 0 ? views[cursor - 1] : null
  if (prev && prev.hash === hash && prev.tab === tab) {
    cursor -= 1
    return views[cursor]
  }
  if (cursor >= 0 && cursor < views.length - 1) {
    const next = views[cursor + 1]
    if (next.hash === hash && next.tab === tab) {
      cursor += 1
      return views[cursor]
    }
  }
  // 恢复视图期间的中间态只对齐，不新增记录
  if (Date.now() < blockUntil) return cur || null

  if (cursor < views.length - 1) views = views.slice(0, cursor + 1)
  views.push({ tab, hash })
  if (views.length > MAX_VIEWS) views = views.slice(views.length - MAX_VIEWS)
  cursor = views.length - 1
  return views[cursor]
}

export function currentView() {
  return cursor >= 0 ? views[cursor] : null
}

/** 上一视图（游标不动） */
export function previousView() {
  return cursor > 0 ? views[cursor - 1] : null
}

export function canGoBack() {
  return cursor > 0
}

export function canGoForward() {
  return cursor >= 0 && cursor < views.length - 1
}

export function goBack() {
  if (!canGoBack()) return null
  cursor -= 1
  return views[cursor]
}

export function goForward() {
  if (!canGoForward()) return null
  cursor += 1
  return views[cursor]
}
