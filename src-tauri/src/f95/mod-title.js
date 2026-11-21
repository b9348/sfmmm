(root, downloads = []) => {
  if (!root) return null
  const lines = []
  const sizes = new Map()
  let text = ''
  let size = Infinity
  const clean = value => value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  const ignored = '.bbCodeBlock--quote, .message-signature, .message-attachments, .bbCodeSpoiler-button, .bbCodeBlock-expandLink, .bbCodeBlock--code, pre, code, noscript, svg, script, style'
  const section = /^(?:overview|description|features?|downloads?|installation|install instructions|requirements?|dependencies|changelog|updates?|credits?|screenshots?|mod|warnings?|functions?|注意事项|介绍|简介|功能|安装(?:说明|方法)?|下载(?:地址|链接)?|更新日志|依赖|截图|概要|説明|インストール|ダウンロード)$/i
  function endLine() {
    const value = text.replace(/\s+/g, ' ').trim()
    if (value && Number.isFinite(size)) lines.push({ text: value, size })
    text = ''
    size = Infinity
  }
  function walk(node) {
    if (node.nodeType === 3) {
      const value = clean(node.textContent)
      text += value
      const count = value.replace(/\s/g, '').length
      if (count) {
        const font = Number.parseFloat(getComputedStyle(node.parentElement).fontSize)
        size = Math.min(size, font)
        sizes.set(font, (sizes.get(font) ?? 0) + count)
      }
      return
    }
    if (node.nodeType !== 1 || node.matches(ignored)) return
    if (node.localName === 'br') {
      endLine()
      return
    }
    const block = /^(block|flow-root|list-item|flex|grid|table)/.test(getComputedStyle(node).display)
    if (block) endLine()
    for (const child of node.childNodes) walk(child)
    if (block) endLine()
  }
  for (const node of root.childNodes) walk(node)
  endLine()
  if (!lines.length) return null

  const versionless = value => value.replace(/[\s_-]*v?\d+(?:[._]\d+)+(?:[a-z])?(?:[\s_-]*(?:f95|en|cn|zh[-_]cn))?$/i, '').trim()
  const compact = value => versionless(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const headline = value => value.replace(/\s+(?:is (?:up|out|here)|(?:has been )?released)[!！.。]*$/i, '').trim()
  const names = []
  for (const link of downloads) {
    let name = link.label.trim()
    if (!/\.(?:zip|7z|rar|dll|json)$/i.test(name)) {
      try {
        name = decodeURIComponent(new URL(link.url).pathname.split('/').filter(Boolean).at(-1) ?? '')
      } catch {
        continue
      }
    }
    if (!/\.(?:zip|7z|rar|dll|json)$/i.test(name)) continue
    const plugin = /\.dll(?:\.(?:zip|7z|rar))?$/i.test(name)
    name = name.replace(/^\d+_/, '').replace(/(?:\.(?:zip|7z|rar|dll|json))+$/i, '').replace(/_/g, ' ').trim()
    const key = compact(name)
    if (key.length >= 5 && !/^(?:mod|modpack|archive|download|update|file|save(?:data)?|log(?:output)?|test|说明|进阶说明|署名声明)\d*$/i.test(key)) {
      names.push({ name, key, plugin })
    }
  }
  for (const line of lines) {
    const name = headline(line.text)
    if (names.some(file => file.key === compact(name))) return name
  }

  const prose = lines.map(line => line.text).join('\n')
  const compactProse = prose.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const namedInBody = names.filter(file => compactProse.includes(file.key))
  if (new Set(namedInBody.map(file => file.key)).size === 1) return namedInBody[0].name

  const baseline = lines.length === 1 ? Number.parseFloat(getComputedStyle(root).fontSize)
    : [...sizes].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]
  const largeTitle = lines.find(line =>
    line.size >= baseline * 1.12 &&
    !section.test(line.text.replace(/^[\s[【(]+|[\s\]】):：]+$/g, '')),
  )
  const oneName = new Set(names.map(file => file.key)).size === 1
  const announcement = largeTitle && /^(?:okay[,.!\s]+|thanks?\b|some features?\b|the basic functionality\b|i (?:don't know|need help)\b|现在插件)/i.test(largeTitle.text)
  if (largeTitle && (!oneName || !announcement)) return largeTitle.text
  if (announcement && oneName) return names.at(-1).name

  const ownsPack = /\b(?:my\s+(?:(?:custom|missions?|quest)\s+)*(?:mod\s*)?(?:pack|bundle|collection)|this is a collection i have created)\b|(?:我做的|我制作的|我整理的)[^\n。]{0,18}(?:合集|整合包)/i
  const packHeading = /^(?:(?:new|custom)\s+)*(?:mod|missions?|quests?)\s+(?:pack|bundle)\s*[:!：！]/i
  if (oneName && (ownsPack.test(prose) || packHeading.test(prose) || names.some(file => file.plugin))) {
    return names.at(-1).name
  }
  const collection = prose.match(/(?:我做的|我制作的|我整理的)\s*([\p{L}\p{N} ]{0,18}(?:合集|整合包))/u)?.[1]?.trim()
  const mega = downloads.some(link => /^https?:\/\/(?:www\.)?mega\.nz\/(?:file|folder)\//i.test(link.url))
  if (collection && mega && /安装|导入|放入|根文件夹|install/i.test(prose)) return collection
  return null
}
