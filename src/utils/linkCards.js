/**
 * 把 Markdown 切成「普通 Markdown 片段」与「链接卡片组」两类。
 *
 * 判定规则（对齐 Discourse onebox，但放宽到列表项）：
 * - 一整段就是一个链接 → 卡片
 * - 一行 / 每个列表项是「短标签 + 链接」（如「夸克网盘转载 https://...」）→ 标签 + 卡片
 * - 一行里连着写多组「标签 + 链接」→ 逐个拆成卡片（网盘分流链接的常见写法）
 * - 句子中间提到的链接保持行内链接，避免正文被大块卡片切碎
 */

/** 代码块围栏，块内即使有整行链接也不当卡片 */
const FENCE_LINE = /^\s*(```|~~~)/
/** 列表项前缀 */
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/
/** 结尾的句读标点属于正文，不属于链接（中文全角标点最常见） */
const TRAILING_PUNCT = /[.,;:!?。，、；：！？'"\]]+$/
/** 链接本身 */
const URL_CORE = /^(https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef]+)$/i

/** 标签最长字符数：超过就说明是句子而不是标签 */
const MAX_LABEL_CHARS = 20
/** 引用块 / 标题：整行交给 Markdown，不能把前缀当卡片标签 */
const STRUCTURAL_LINE = /^\s*(?:#{1,6}\s|>)/
/** 标签里只有 Markdown 标记符号（**、~~、反引号等），说明是强调/代码而非标签 */
const MARKDOWN_ONLY = /^[#>*_~`<]+$/
/** URL 尾部还挂着 Markdown 标记，说明链接被强调/代码包着，交给 Markdown 渲染 */
const MD_TRAILING = /[*_~`<>]+$/

function cleanUrl(raw) {
  return raw.replace(TRAILING_PUNCT, '').replace(/^</, '').replace(/>$/, '')
}

/**
 * 解析单行：返回 { label, url, listItem } 或 null
 * 只认「这一行除了链接以外，最多还有一个短标签」的写法。
 */
export function matchCardLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  // > 引用、# 标题：保留原始 Markdown 结构
  if (STRUCTURAL_LINE.test(trimmed)) return null
  // 行内代码：URL 属于代码内容，交给 Markdown
  if (trimmed.includes('`')) return null

  const listItem = LIST_ITEM.test(trimmed)
  const body = listItem ? trimmed.replace(LIST_ITEM, '') : trimmed

  // 行内含 Markdown 链接 / 图片语法（![alt](url)、[文字](url)）时交给 Markdown 渲染，
  // 否则 URL 会把后面的正文一起吃掉（图床图片后面紧跟文字是最常见的踩坑）
  if (/!?\[[^\]]*\]\(/.test(body)) return null

  // 尖括号 autolink：<https://...> 独占一行时直接做无标签卡片
  const auto = body.match(/^<(https?:\/\/[^\s<>]+)>$/)
  if (auto) return { label: '', url: auto[1], listItem }

  const m = body.match(/^(.*?)\s*(https?:\/\/\S+)\s*$/)
  if (!m) return null

  const url = cleanUrl(m[2])
  if (!URL_CORE.test(url)) return null
  // **https://...** / `https://...` 等被标记包裹的链接保留 Markdown 强调
  if (MD_TRAILING.test(url)) return null

  // 标签去掉分隔冒号；中间不允许有空白，避免把整句话当标签
  const label = m[1].replace(/[:：]\s*$/, '').trim()
  if (label.length > MAX_LABEL_CHARS) return null
  if (/\s/.test(label)) return null
  if (MARKDOWN_ONLY.test(label)) return null
  // 标签里带强调/代码/删除线符号：这是 Markdown 行文，不是纯文本短标签
  if (/[*_~`]/.test(label)) return null
  if (!label && listItem) {
    // 「- https://...」也算卡片，但空标签的普通行不额外处理
    return { label: '', url, listItem }
  }
  return { label, url, listItem }
}

export function isBareUrlLine(text) {
  const t = text.trim()
  if (!t || t.includes('\n')) return false
  return URL_CORE.test(cleanUrl(t))
}

/**
 * 正文里任意位置的 @提及（模组 sfmmm:mod: / 主题帖 sfmmm:discuss:）。
 *
 * 提及在编辑器里是行内蓝链（便于看清链接指向），发布后一律渲染成卡片，
 * 因此不要求独占一行：夹在句子里（「…其他mod [@xxx](sfmmm:mod:yyy)」）也要切出来。
 */
const MENTION_TOKEN = /\[@([^\]]+)\]\(sfmmm:(mod|discuss):([^)]+)\)/

/** 片段里是否还有实际内容（只有标点 / 列表符号的残片不必单独成段） */
const HAS_CONTENT = /[^\s\p{P}]/u

function decodeRef(raw) {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 把一段正文按 @提及 切开：提及单独成段，其余文字原样保留。
 * 片段里没有提及返回 null，交给调用方的其余逻辑处理。
 */
function splitMentions(text) {
  // 行内代码里的 sfmmm: 链接是代码内容，不是提及；引用块 / 标题行属于结构，
  // 把提及从里面拆出来会破坏 Markdown 结构。两处都用等长空格遮住，索引不变。
  const masked = text
    .split('\n')
    .map((line) => (STRUCTURAL_LINE.test(line) ? ' '.repeat(line.length) : line))
    .join('\n')
    .replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
  const hits = []
  const re = new RegExp(MENTION_TOKEN.source, 'g')
  let m
  while ((m = re.exec(masked))) {
    hits.push({
      label: m[1],
      kind: m[2] === 'discuss' ? 'discussion' : 'mod',
      ref: decodeRef(m[3]),
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  if (!hits.length) return null

  const out = []
  const pushText = (value) => {
    const frag = value.trim()
    // 只剩标点 / 列表符号的残片（「。」「- 」）不必单独成段
    if (!HAS_CONTENT.test(frag)) return
    out.push({ type: 'markdown', text: frag })
  }

  let cursor = 0
  for (const hit of hits) {
    pushText(text.slice(cursor, hit.start))
    out.push({ type: 'mention', kind: hit.kind, ref: hit.ref, label: hit.label })
    cursor = hit.end
  }
  pushText(text.slice(cursor))
  return out
}

/** 裸链接（含 Markdown 链接语法里的不算） */
const BARE_URL_SCAN = /https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef]+/g

function findBareUrls(text) {
  const found = []
  let offset = 0
  for (const line of text.split('\n')) {
    // 引用块 / 标题里的链接保留 Markdown 结构
    if (STRUCTURAL_LINE.test(line)) {
      offset += line.length + 1
      continue
    }
    // 行内代码用等长空格遮住，避免把代码里的 URL 当正文链接
    const masked = line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
    for (const m of masked.matchAll(BARE_URL_SCAN)) {
      const start = m.index
      const raw = m[0]
      const before = masked.slice(Math.max(0, start - 2), start)
      // 已经是 Markdown 链接 / 图片 / HTML 属性 -> 不是裸链接
      if (before.endsWith('](') || before.endsWith('="') || before.endsWith("='")) continue
      // 尖括号 autolink 交给 Markdown
      if (line[start - 1] === '<' && line[start + raw.length] === '>') continue
      // 强调/代码包着的链接保留 Markdown 样式
      if (MD_TRAILING.test(raw)) continue
      const url = cleanUrl(raw)
      if (url.length <= 8 || !URL_CORE.test(url)) continue
      found.push({ url, index: offset + start })
    }
    offset += line.length + 1
  }
  return found
}

/** 一行写下多组「标签 + 链接」。返回卡片数组；不是这种写法返回 null */
function matchCardPairs(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (STRUCTURAL_LINE.test(trimmed)) return null
  if (trimmed.includes('`')) return null
  // 含尖括号说明是 autolink / HTML 片段，交给 Markdown 渲染
  if (/[<>]/.test(trimmed)) return null
  if (/!?\[[^\]]*\]\(/.test(trimmed)) return null

  const body = LIST_ITEM.test(trimmed) ? trimmed.replace(LIST_ITEM, '') : trimmed

  const hits = []
  for (const m of body.matchAll(BARE_URL_SCAN)) {
    const before = body.slice(Math.max(0, m.index - 2), m.index)
    if (before.endsWith('](') || before.endsWith('="') || before.endsWith("='")) continue
    if (MD_TRAILING.test(m[0])) continue
    const url = cleanUrl(m[0])
    if (url.length <= 8 || !URL_CORE.test(url)) continue
    hits.push({ url, start: m.index, end: m.index + m[0].length })
  }
  // 只有一个链接交给 matchCardLine，那套规则更宽松（容忍空标签）
  if (hits.length < 2) return null

  const items = []
  let cursor = 0
  for (const hit of hits) {
    const raw = body.slice(cursor, hit.start)
    // 标签必须紧贴链接（「网盘链接1：https://…」，允许冒号后跟空格）；
    // 其余带尾随空白的是「看这两个链接 https://… https://…」这类行文，链接要保持行内
    const head = /[:：]\s*$/.test(raw) ? raw.replace(/[:：]\s*$/, '') : raw
    if (!head || /\s$/.test(head)) return null
    const label = head.trim()
    // 段间文字必须是短标签而不是句子，否则说明这是夹着多个链接的行文
    if (/\s/.test(label)) return null
    if (label.length > MAX_LABEL_CHARS) return null
    if (MARKDOWN_ONLY.test(label) || /[*_~`]/.test(label)) return null
    items.push({ label, url: hit.url })
    cursor = hit.end
  }
  // 最后一个链接后面还跟着正文 → 行文里的多个链接，保持行内
  if (HAS_CONTENT.test(body.slice(cursor))) return null
  return items
}

/**
 * 一行能提成卡片的链接：优先按「一行多组」拆，其次按「单组」解析。
 * 两者都不成立返回 null。
 */
function matchCardItems(line) {
  const pairs = matchCardPairs(line)
  if (pairs) return pairs
  const one = matchCardLine(line)
  return one ? [{ label: one.label, url: one.url }] : null
}

/**
 * @param {string} markdown
 * @returns {Array<{type: 'markdown', text: string} | {type: 'cards', items: Array<{label: string, url: string}>}>}
 */
export function splitMarkdownWithLinkCards(markdown) {
  if (!markdown) return []

  const lines = markdown.split(/\r?\n/)
  const parts = []
  let buffer = []
  let inFence = false

  /**
   * 普通文本块：连续的卡片行合成卡片组，其余行原样交给 Markdown。
   *
   * 列表符号不再是必要条件——网盘分流链接最常见的写法就是每行一组「标签：链接」，
   * 不带 - / 1.。旧判定要求多行必须整块是列表项，这类正文于是全部退回 Markdown，
   * 在段落里挤成一串很长的行内链接。
   */
  const pushTextBlock = (value) => {
    const bufferProse = []
    const bufferCards = []

    const flushProse = () => {
      if (!bufferProse.length) return
      const text = bufferProse.join('\n')
      bufferProse.length = 0
      if (!text.trim()) return

      // 兜底：一段里只有一个裸链接时，也把链接提出来做成卡片，
      // 其余文字原样保留在卡片前后（如「...已更新，原地址 https://...」）
      const urls = findBareUrls(text)
      if (urls.length === 1) {
        const { url, index } = urls[0]
        const before = text.slice(0, index).trim()
        const after = text.slice(index + url.length).trim()
        if (before) parts.push({ type: 'markdown', text: before })
        parts.push({ type: 'cards', items: [{ label: '', url }] })
        if (after) parts.push({ type: 'markdown', text: after })
        return
      }
      parts.push({ type: 'markdown', text })
    }

    const flushCards = () => {
      if (!bufferCards.length) return
      parts.push({ type: 'cards', items: bufferCards.slice() })
      bufferCards.length = 0
    }

    for (const line of value.split('\n')) {
      const items = line.trim() ? matchCardItems(line) : null
      if (items) {
        flushProse()
        bufferCards.push(...items)
        continue
      }
      flushCards()
      bufferProse.push(line)
    }
    flushProse()
    flushCards()
  }

  const flush = () => {
    if (!buffer.length) return
    const block = buffer.slice()
    buffer = []

    const text = block.join('\n')
    if (!text.trim()) return

    // 代码块里的 sfmmm: 链接属于代码内容，整块原样交给 Markdown
    if (block.some((l) => FENCE_LINE.test(l))) {
      parts.push({ type: 'markdown', text })
      return
    }

    // @提及 不要求独占一行：夹在句子中间（「…其他mod [@xxx](sfmmm:mod:yyy)」）
    // 也切出来单独渲染成卡片，发布后的正文里不该再出现编辑器那种行内蓝链
    const mentionParts = splitMentions(text)
    if (mentionParts) {
      for (const part of mentionParts) {
        if (part.type === 'mention') parts.push(part)
        else pushTextBlock(part.text)
      }
      return
    }

    pushTextBlock(text)
  }

  for (const line of lines) {
    if (FENCE_LINE.test(line)) inFence = !inFence
    if (!inFence && line.trim() === '') {
      flush()
      continue
    }
    buffer.push(line)
  }
  flush()

  return parts
}

/**
 * 富文本（HTML）里的链接卡片切分。
 *
 * 与 Markdown 版同思路，但依据是 HTML 结构：
 * - 块级元素里**只有一个**「文字就是链接本身」的 <a>（编辑器把粘贴的裸链接自动链接化）→ 卡片
 * - 同一块里还有别的链接 / 多个裸链接 → 保持行内链接，避免正文被卡片切碎
 * - 只处理顶层节点，且要求 <a> 是块级元素的直接子节点（段落里嵌强调等复杂结构原样交给 HTML）
 *
 * @param {string} html
 * @returns {Array<{type: 'html', html: string} | {type: 'cards', items: Array<{label: string, url: string}>}>}
 */

/** 可以安全切分的块级容器（直接子节点里有 <a> 时按前后两段拆开） */
const RICH_BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'DIV', 'LI', 'TD'])

/** 编辑器自动链接化后的锚点：可见文字与 href 完全一致 */
function isBareLinkAnchor(anchor) {
  const href = (anchor.getAttribute('href') || '').trim()
  if (!/^https?:\/\//i.test(href)) return false
  if (anchor.closest('pre, code')) return false
  return (anchor.textContent || '').trim() === href
}

/** 该块是否恰好只有一个裸链接锚点，且是直接子节点 */
function findCardAnchor(block) {
  if (!RICH_BLOCK_TAGS.has(block.tagName)) return null
  const bare = Array.from(block.children).filter(
    (el) => el.tagName === 'A' && isBareLinkAnchor(el)
  )
  if (bare.length !== 1) return null
  const anchor = bare[0]
  if (anchor.parentNode !== block) return null
  return anchor
}

/** 去掉纯空白的克隆块，返回其 HTML；无有效内容返回空串 */
function blockHtml(block) {
  if (!block.textContent.trim() && !block.querySelector('img')) return ''
  return block.outerHTML
}

/** 以锚点为界，把块拆成前后两个同标签的副本 */
function splitBlockAroundAnchor(block, anchor) {
  const before = block.cloneNode(false)
  const after = block.cloneNode(false)
  let target = before
  for (const child of Array.from(block.childNodes)) {
    if (child === anchor) {
      target = after
      continue
    }
    target.appendChild(child.cloneNode(true))
  }
  return { before: blockHtml(before), after: blockHtml(after) }
}

export function splitRichtextWithLinkCards(html) {
  if (!html) return []
  if (typeof DOMParser === 'undefined') return [{ type: 'html', html }]

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const parts = []
  const pushHtml = (value) => {
    if (value && value.trim()) parts.push({ type: 'html', html: value })
  }

  for (const node of Array.from(doc.body.childNodes)) {
    // 顶层文本节点（少见）：用临时容器拿到已转义的 HTML
    if (node.nodeType !== 1) {
      const wrapper = doc.createElement('div')
      wrapper.appendChild(node.cloneNode(true))
      pushHtml(wrapper.innerHTML)
      continue
    }

    const anchor = findCardAnchor(node)
    if (!anchor) {
      parts.push({ type: 'html', html: node.outerHTML })
      continue
    }

    const { before, after } = splitBlockAroundAnchor(node, anchor)
    pushHtml(before)
    parts.push({ type: 'cards', items: [{ label: '', url: anchor.getAttribute('href').trim() }] })
    pushHtml(after)
  }

  return parts
}
