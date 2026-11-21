import { createElement, useMemo } from 'react'
import { makeStyles, tokens } from '@fluentui/react-components'
import { isF95AttachmentLink } from './attachmentLinks'

const tags = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'mark',
  'ol', 'p', 'pre', 's', 'small', 'span', 'strike', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'tfoot', 'u', 'ul',
])
const blocked = new Set([
  'audio', 'base', 'button', 'embed', 'form', 'iframe', 'input', 'link', 'math',
  'meta', 'object', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'video',
])
const xfClasses = new Set([
  'bbCodeBlock', 'bbCodeBlock--quote', 'bbCodeBlock--code', 'bbCodeBlock-title',
  'bbCodeBlock-content', 'bbCodeBlock-expandContent', 'bbCodeBlock-sourceJump',
  'message-attachments', 'attachmentList', 'file', 'file-info', 'file-name',
])
const textStyles = [
  'color', 'backgroundColor', 'fontFamily', 'fontWeight', 'fontStyle',
  'textDecoration', 'textAlign', 'verticalAlign',
]

const useStyles = makeStyles({
  document: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase400,
    overflowWrap: 'anywhere',
    '& img': { maxWidth: '100%', height: 'auto', verticalAlign: 'middle' },
    '& a': { color: tokens.colorBrandForegroundLink },
    '& .cached-f95-attachment': {
      backgroundColor: 'transparent',
      borderTopWidth: 0,
      borderRightWidth: 0,
      borderBottomWidth: 0,
      borderLeftWidth: 0,
      padding: 0,
      font: 'inherit',
      color: tokens.colorBrandForegroundLink,
      textAlign: 'inherit',
      cursor: 'pointer',
    },
    '& .cached-f95-attachment:hover': { textDecoration: 'underline' },
    '& .cached-f95-attachment:disabled': { color: tokens.colorNeutralForegroundDisabled, cursor: 'default' },
    '& ul, & ol': { paddingInlineStart: '1.75em' },
    '& pre': { whiteSpace: 'pre-wrap', backgroundColor: tokens.colorNeutralBackground3, padding: '10px' },
    '& blockquote, & .bbCodeBlock--quote, & .bbCodeBlock--code, & details': {
      margin: '10px 0',
      padding: '8px 12px',
      backgroundColor: tokens.colorNeutralBackground3,
      borderInlineStartWidth: '3px',
      borderInlineStartStyle: 'solid',
      borderInlineStartColor: tokens.colorNeutralStroke1,
    },
    '& summary': { cursor: 'pointer', fontWeight: tokens.fontWeightSemibold },
    '& .bbCodeBlock-title': { fontWeight: tokens.fontWeightSemibold, marginBottom: '6px' },
    '& table': { borderCollapse: 'collapse', maxWidth: '100%' },
    '& td, & th': { border: `1px solid ${tokens.colorNeutralStroke1}`, padding: '4px 8px' },
    '& .message-attachments': {
      marginTop: '16px',
      paddingTop: '10px',
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    },
    '& .attachmentList': { display: 'flex', flexWrap: 'wrap', gap: '8px', listStyleType: 'none', padding: 0 },
    '& .attachmentList .file': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: '6px 10px',
      borderRadius: tokens.borderRadiusMedium,
    },
  },
})

function httpUrl(value, baseUrl) {
  if (!value) return undefined
  try {
    const url = new URL(value, baseUrl)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      return url.href
    }
  } catch {
    return undefined
  }
}

function textStyle(node) {
  const style = {}
  for (const name of textStyles) {
    if (node.style[name]) style[name] = node.style[name]
  }
  // Forum posts use inline sizes for headings and captions.
  const size = node.style.fontSize.match(/^([0-9.]+)(px|rem|em|%)$/)
  if (size) {
    const max = size[2] === 'px' ? 60 : size[2] === '%' ? 300 : 3
    if (Number(size[1]) <= max) style.fontSize = size[0]
  }
  return style
}

function renderNode(node, key, baseUrl, spoilerLabel, onAttachment, attachmentsDisabled) {
  if (node.nodeType === 3) return node.textContent
  if (node.nodeType !== 1 || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null
  const tag = node.localName
  if (blocked.has(tag) || node.classList.contains('bbCodeBlock-expandLink')) return null

  const children = parent => Array.from(parent.childNodes, (child, index) =>
    renderNode(child, `${key}.${index}`, baseUrl, spoilerLabel, onAttachment, attachmentsDisabled),
  )

  if (node.classList.contains('bbCodeSpoiler')) {
    const label = node.querySelector('.bbCodeSpoiler-button')?.textContent.trim() || spoilerLabel
    const body = node.querySelector('.bbCodeSpoiler-content')
    return createElement('details', { key },
      createElement('summary', null, label),
      body && createElement('div', null, children(body)),
    )
  }
  if (!tags.has(tag)) {
    return createElement('span', { key }, children(node))
  }

  const props = { key, style: textStyle(node) }
  const className = Array.from(node.classList).filter(name => xfClasses.has(name)).join(' ')
  if (className) props.className = className
  const filenameLink = node.classList.contains('file-name')
    ? node.closest('.file')?.querySelector('a.file-preview[href]')?.getAttribute('href')
    : undefined
  const attachmentUrl = httpUrl(filenameLink ?? (tag === 'a' ? node.getAttribute('href') : undefined), baseUrl)
  if (isF95AttachmentLink(attachmentUrl)) {
    return createElement('button', {
      ...props,
      className: [props.className, 'cached-f95-attachment'].filter(Boolean).join(' '),
      type: 'button',
      title: attachmentUrl,
      disabled: attachmentsDisabled,
      onClick: () => onAttachment(attachmentUrl, node.closest('.file')?.querySelector('.file-name')?.textContent.trim() || node.textContent.trim()),
    }, children(node))
  }
  if (tag === 'a') {
    props.href = attachmentUrl
  } else if (tag === 'img') {
    props.src = httpUrl(node.getAttribute('data-src'), baseUrl) ?? httpUrl(node.getAttribute('src'), baseUrl)
    props.alt = node.getAttribute('alt') ?? ''
    props.loading = 'lazy'
    props.referrerPolicy = 'no-referrer'
    return props.src ? createElement('img', props) : props.alt
  } else if (tag === 'td' || tag === 'th') {
    props.colSpan = node.colSpan
    props.rowSpan = node.rowSpan
  } else if (tag === 'ol') {
    props.start = node.start
    props.reversed = node.reversed
  } else if (tag === 'li' && node.hasAttribute('value')) {
    props.value = node.value
  }
  if (tag === 'br' || tag === 'hr' || tag === 'col') return createElement(tag, props)
  if (tag === 'center') {
    props.style.textAlign = 'center'
    return createElement('div', props, children(node))
  }
  if (tag === 'font') {
    props.style.color ||= node.getAttribute('color') ?? undefined
    props.style.fontFamily ||= node.getAttribute('face') ?? undefined
    return createElement('span', props, children(node))
  }
  return createElement(tag, props, children(node))
}

export function CachedF95Post({ html, baseUrl, spoilerLabel, onAttachment, attachmentsDisabled }) {
  const styles = useStyles()
  const content = useMemo(() => {
    const template = document.createElement('template')
    template.innerHTML = html
    return Array.from(template.content.childNodes, (node, index) =>
      renderNode(node, String(index), baseUrl, spoilerLabel, onAttachment, attachmentsDisabled),
    )
  }, [html, baseUrl, spoilerLabel, onAttachment, attachmentsDisabled])
  return <div className={styles.document}>{content}</div>
}
