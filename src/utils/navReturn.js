/**
 * 详情之间的「@提及卡片」跳转：记录入口位置，返回时恢复视口。
 *
 * 只记录由提及卡片触发的导航（正文里的蓝色 @ 链接或独立卡片），
 * 列表 -> 详情这种普通浏览不受影响。
 */

const stack = []
const TTL = 5 * 60 * 1000
const MAX_ENTRIES = 20
const RESTORE_TIMEOUT_MS = 10_000
let seq = 0

function findScrollable(el) {
  let node = el?.parentElement
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node
    node = node.parentElement
  }
  return document.scrollingElement
}

function removeMarker(entry) {
  if (!entry?.anchorId) return
  const el = document.querySelector('[data-nav-entry="' + entry.anchorId + '"]')
  el?.removeAttribute('data-nav-entry')
}

/** 从 hash 里取楼层 id（?comment=123） */
export function commentIdFromHash(hash) {
  const m = String(hash || '').match(/[?&]comment=(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * 在触发跳转前记录当前页的 hash 与滚动位置。
 * @param {Element} el 触发跳转的元素（用来找最近的滚动容器，并作为返回时的锚点）
 * @param {string} target 目标标识，如 \`mod:<mod_key>\` / \`discuss:<id>\`，用于判断 entry 是否属于当前详情
 */
export function rememberEntryPoint(el, target) {
  const scroller = findScrollable(el)
  seq += 1
  const anchorId = String(seq)
  let anchorTop = 0
  if (el?.setAttribute) {
    el.setAttribute('data-nav-entry', anchorId)
    anchorTop = el.getBoundingClientRect().top
  }
  stack.push({
    hash: window.location.hash,
    key: scroller?.dataset?.scrollKey || '',
    top: scroller?.scrollTop || 0,
    target: target || '',
    anchorId: el?.setAttribute ? anchorId : '',
    anchorTop,
    at: Date.now(),
  })
  while (stack.length > MAX_ENTRIES) removeMarker(stack.shift())
}

export function peekEntryPoint() {
  while (stack.length && Date.now() - stack[stack.length - 1].at > TTL) {
    removeMarker(stack.pop())
  }
  return stack[stack.length - 1] || null
}

/** 取出并丢弃栈顶（不恢复位置，例如入口已不匹配当前详情） */
export function discardEntryPoint() {
  const entry = peekEntryPoint()
  if (entry) {
    stack.pop()
    removeMarker(entry)
  }
  return entry
}

export function consumeEntryPoint() {
  const entry = peekEntryPoint()
  if (entry) stack.pop()
  return entry
}

/**
 * 恢复到入口位置：优先用点击元素的现场位置校正，避免来源内容高度变化导致偏移。
 * 容器可能短暂隐藏/尚未挂载，轮询到 10 秒。
 */
export function restoreScroll(entry) {
  if (!entry) return
  if (!entry.key) {
    removeMarker(entry)
    return
  }
  const deadline = performance.now() + RESTORE_TIMEOUT_MS
  const apply = () => {
    const el = document.querySelector('[data-scroll-key="' + entry.key + '"]')
    if (el && el.offsetParent !== null) {
      const anchor = entry.anchorId
        ? el.querySelector('[data-nav-entry="' + entry.anchorId + '"]')
        : null
      if (anchor) {
        // 让锚点在视口中的位置回到点击时的位置（而不是死板地写 scrollTop）
        el.scrollTop += anchor.getBoundingClientRect().top - entry.anchorTop
        removeMarker(entry)
      } else {
        el.scrollTop = entry.top
        removeMarker(entry)
      }
      return
    }
    if (performance.now() < deadline) requestAnimationFrame(apply)
    else removeMarker(entry)
  }
  requestAnimationFrame(apply)
}
