import { findMarkdownImageSpans, destUrlOf } from '../services/imageApi'

// 必须一直匹配到 `>`：否则替换后会把 ` alt="">` 之类的残渣留在摘要里
const IMG_TAG_RE = /<img\b[^>]*?src=["']([^"']+)["'][^>]*>/gi

/**
 * 从 markdown/html 正文中提取第一张可用的图片 URL，并返回去掉图片语法后的纯文本摘要。
 * 用于列表/卡片类界面的预览：正文里只带图片时不应把 markdown 语法当纯文本裸露出来。
 *
 * 用括号配平扫描（findMarkdownImageSpans）而不是单条正则：alt 里可能又套了图片语法
 * （`![a![b](c)d](e)`），正则会在第一个 `]` 处截断，把内层的 URL 当成首图——那正是
 * 列表页显示 A 图、详情页显示 B 图的成因。另外这里是 `https?://` 白名单，
 * 未上传的 `imgbed://pending/...` 自然被排除在外。
 */
export function extractFirstImage(content) {
  if (!content) return { image: null, text: '' }

  // Markdown 图片语法（含嵌套），取第一个指向 http(s) 的
  let image = null
  const spans = findMarkdownImageSpans(content)
  const mdRanges = []
  for (const span of spans) {
    // 剥掉 `![a](url "title")` 的 title：它会让 src 变成非法 URL，卡片直接破图
    const dest = destUrlOf(content.slice(span.destStart, span.destEnd))
    if (!image && /^https?:\/\//i.test(dest)) image = dest
    mdRanges.push([span.start, span.end])
  }

  // 兜底：正文里直接写的 <img src="https://...">
  const tagMatches = [...content.matchAll(IMG_TAG_RE)]
  if (!image && tagMatches.length > 0) image = tagMatches[0][1]

  // 去掉图片语法，只保留正文文本
  let text = ''
  let last = 0
  for (const [start, end] of mdRanges) {
    text += content.slice(last, start) + ' '
    last = end
  }
  text += content.slice(last)
  text = text.replace(IMG_TAG_RE, ' ').replace(/\s+/g, ' ').trim()
  return { image, text }
}

export default extractFirstImage
