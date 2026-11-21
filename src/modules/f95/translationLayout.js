// Used by the cache reader and the isolated F95 window. Keep this factory self-contained.
export function createTranslationLayout() {
  const blocks = new Set([
    'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details',
    'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'header', 'li', 'ol', 'p', 'section', 'table', 'tbody', 'td',
    'tfoot', 'th', 'thead', 'tr', 'ul',
  ])
  const inline = new Set([
    'a', 'abbr', 'b', 'del', 'em', 'font', 'i', 'ins', 'mark', 's', 'small',
    'span', 'strike', 'strong', 'sub', 'sup', 'u',
  ])
  const ignored = [
    '.message-attachments', '.attachmentList', '.cached-f95-attachment', '.message-signature',
    '.bbCodeBlock--code', '.bbCodeBlock-title', '.bbCodeBlock-sourceJump', '.bbCodeBlock-expandLink',
    '.bbCodeSpoiler-button', 'summary', 'script', 'style', 'template', 'noscript', 'pre',
    'img', 'picture', 'svg', 'video', 'audio', 'iframe', 'button', 'input', 'hr',
    '[data-sfmmm-translation]', '[data-sfmmm-translation-status]',
  ].join(',')
  const styles = [
    'color', 'backgroundColor', 'fontWeight', 'fontStyle', 'fontFamily', 'fontSize',
    'textDecoration', 'verticalAlign', 'textTransform', 'letterSpacing',
  ]

  function linkUrl(node) {
    const href = node.getAttribute('href')
    if (!href) return null
    try {
      const url = new URL(href, node.baseURI)
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url
    } catch {
      return null
    }
    return null
  }

  function isAttachment(node) {
    if (node.localName !== 'a') return false
    const url = linkUrl(node)
    return url && (url.hostname === 'attachments.f95zone.to' ||
      (url.hostname === 'f95zone.to' && url.pathname.startsWith('/attachments/')))
  }

  function collect(root) {
    const segments = []
    const inserted = new Set()
    const results = new Map()
    const doc = root.ownerDocument
    let shown = true

    function add(nodes, anchor) {
      if (!nodes.length) return
      const marks = []
      let words = ''

      function marker(meta, body) {
        const id = marks.length
        marks.push(meta)
        return '<f' + id + '>' + body() + '</f' + id + '>'
      }

      function textPart(value) {
        let start = 0
        let output = ''
        // Treat bare URLs as opaque inline elements. Link destinations remain local too.
        for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
          const prose = value.slice(start, match.index)
          words += prose
          output += prose.replace(/<(?=\/?f[0-9]+>)/g, '‹') +
            marker({ fixed: doc.createTextNode(match[0]) }, () => '…')
          start = match.index + match[0].length
        }
        const tail = value.slice(start)
        words += tail
        return output + tail.replace(/<(?=\/?f[0-9]+>)/g, '‹')
      }

      function encode(node) {
        if (node.nodeType === 3) return textPart(node.data)
        if (node.nodeType !== 1 || node.matches(ignored) || isAttachment(node)) return ''
        const tag = node.localName
        if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
          const fixed = doc.createElement(tag)
          fixed.textContent = node.textContent
          return marker({ fixed }, () => '…')
        }
        const children = () => Array.from(node.childNodes, encode).join('')
        if (!inline.has(tag)) return children()
        const css = styles.map(name => [name, node.style?.[name]]).filter(([, value]) => value)
        const url = tag === 'a' ? linkUrl(node) : null
        if (tag === 'span' && !css.length) return children()
        const safe = doc.createElement(tag === 'font' ? 'span' : tag)
        for (const [name, value] of css) safe.style[name] = value
        if (tag === 'font') {
          if (node.hasAttribute('color')) safe.style.color ||= node.getAttribute('color')
          if (node.hasAttribute('face')) safe.style.fontFamily ||= node.getAttribute('face')
        }
        if (url) safe.href = url.href
        if (tag === 'a' && !url) return children()
        return marker({ template: safe }, children)
      }

      const text = nodes.map(encode).join('').replace(/[\t\r\n ]+/g, ' ').trim()
      if (!/\p{L}/u.test(words) || !text) return
      segments.push({ id: segments.length, text, anchor, marks })
    }

    function walk(block) {
      let line = []
      let last = null
      function flush(anchor = last) {
        if (anchor) add(line, anchor)
        line = []
        last = null
      }
      for (const node of block.childNodes) {
        if (node.nodeType === 3) {
          line.push(node)
          last = node
        } else if (node.nodeType === 1) {
          if (node.localName === 'br') {
            flush(node)
          } else if (node.matches(ignored) || isAttachment(node)) {
            flush()
          } else if (blocks.has(node.localName) || (inline.has(node.localName) && node.querySelector('br'))) {
            flush()
            walk(node)
          } else {
            line.push(node)
            last = node
          }
        }
      }
      flush()
    }

    function decoded(segment, result) {
      const fragment = doc.createDocumentFragment()
      if (!result.formatted) {
        fragment.append(doc.createTextNode(result.text))
        return fragment
      }
      const stack = [{ id: null, node: fragment }]
      const seen = new Set()
      let offset = 0
      function append(value) {
        if (!stack.some(entry => entry.fixed)) stack.at(-1).node.append(doc.createTextNode(value))
      }
      for (const match of result.text.matchAll(/<(\/?)f(\d+)>/g)) {
        const id = Number(match[2])
        const format = segment.marks[id]
        append(result.text.slice(offset, match.index))
        offset = match.index + match[0].length
        if (!format) return doc.createTextNode(result.text.replace(/<\/?f\d+>/g, ''))
        if (match[1]) {
          if (stack.length < 2 || stack.pop().id !== id) {
            return doc.createTextNode(result.text.replace(/<\/?f\d+>/g, ''))
          }
        } else {
          if (seen.has(id)) return doc.createTextNode(result.text.replace(/<\/?f\d+>/g, ''))
          seen.add(id)
          const node = (format.fixed ?? format.template).cloneNode(true)
          if (!stack.some(entry => entry.fixed)) stack.at(-1).node.append(node)
          stack.push({ id, node, fixed: Boolean(format.fixed) })
        }
      }
      append(result.text.slice(offset))
      return stack.length === 1 && seen.size === segment.marks.length
        ? fragment : doc.createTextNode(result.text.replace(/<\/?f\d+>/g, ''))
    }

    function render(batch) {
      for (const result of batch) {
        const segment = segments[result.id]
        if (!segment || !segment.anchor.parentNode || results.has(result.id)) continue
        const translated = doc.createElement('span')
        translated.dataset.sfmmmTranslation = ''
        translated.style.display = shown ? 'block' : 'none'
        translated.style.marginBlockEnd = '0.4em'
        translated.append(decoded(segment, result))
        segment.anchor.after(translated)
        results.set(result.id, translated)
        inserted.add(translated)
      }
    }

    walk(root)
    return {
      parts: segments.map(({ id, text }) => ({ id, text })),
      render,
      show(value) {
        shown = value
        for (const element of inserted) element.style.display = shown ? 'block' : 'none'
      },
      clear() {
        for (const element of inserted) element.remove()
        inserted.clear()
        results.clear()
      },
    }
  }

  return { collect }
}
