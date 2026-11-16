import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import { Search16Regular } from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { UserAvatar } from '../../components'
import {
  MENTION_DISCUSSION,
  currentMentionRecords,
  loadCachedMentionRecords,
  runMentionSearch,
  searchMentionRecords,
} from '../../services/modMentions'

/**
 * MarkdownEditor 的 @提及 自动补全。
 *
 * - 输入 @ 打开浮层，默认只展示「本地缓存记录」的匹配结果，不请求云端
 * - 在搜索框里输入时，对缓存记录做模糊过滤（即时）
 * - 只有点「搜索」或按 Shift+Enter 才查库（模组 + 讨论区主题帖），避免频繁请求
 * - 选中后写入 [@名称](sfmmm:mod:...) / [@标题](sfmmm:discuss:...)
 *
 * 浮层锚定在光标处：textarea 没有光标坐标 API，用一个隐藏的镜像 div 复刻字体/内边距/
 * 换行规则，量出光标所在行列，再叠加 textarea 的屏幕位置。
 */

const TRIGGER_RE = /(?:^|[\s([{"'（【《，。、；：！？])@([^\s@]{0,40})$/
const POPOVER_WIDTH = 380
const POPOVER_MAX_HEIGHT = 360
const LIST_MAX_HEIGHT = 250

const MIRROR_PROPS = [
  'boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'whiteSpace', 'wordWrap', 'wordBreak', 'tabSize',
]

function caretCoordinates(textarea, position) {
  const computed = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  mirror.style.position = 'absolute'
  mirror.style.top = '0'
  mirror.style.left = '0'
  mirror.style.visibility = 'hidden'
  mirror.style.overflow = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'
  mirror.style.width = textarea.clientWidth + 'px'
  mirror.style.boxSizing = 'border-box'
  mirror.style.border = '0'
  for (const prop of MIRROR_PROPS) mirror.style[prop] = computed[prop]

  mirror.textContent = textarea.value.substring(0, position)
  const marker = document.createElement('span')
  marker.textContent = textarea.value.substring(position) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  // offsetTop / offsetLeft 已包含内边距（offsetParent 是镜像 div 的 padding box）
  const coords = { top: marker.offsetTop, left: marker.offsetLeft }
  document.body.removeChild(mirror)
  return coords
}

function mergeRecords(primary, extra) {
  const map = new Map()
  for (const record of primary) map.set(record.kind + ':' + record.ref, record)
  for (const record of extra) map.set(record.kind + ':' + record.ref, record)
  return [...map.values()]
}

const useStyles = makeStyles({
  popover: {
    position: 'fixed',
    zIndex: 10000,
    width: POPOVER_WIDTH + 'px',
    maxHeight: POPOVER_MAX_HEIGHT + 'px',
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid ' + tokens.colorNeutralStroke1,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    overflow: 'hidden',
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 10px',
    borderBottom: '1px solid ' + tokens.colorNeutralStroke2,
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
  // 浮动标签的定位容器：标签从输入框内部滑到下边框
  searchField: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
    height: '22px',
  },
  searchInput: {
    width: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: tokens.colorNeutralForeground1,
    fontSize: tokens.fontSizeBase300,
    fontFamily: 'inherit',
    padding: 0,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '4px',
    overflowY: 'auto',
    maxHeight: LIST_MAX_HEIGHT + 'px',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusSmall,
    cursor: 'pointer',
    minWidth: 0,
  },
  itemActive: {
    backgroundColor: tokens.colorNeutralBackground1Hover,
  },
  identity: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    width: '72px',
    flexShrink: 0,
    minWidth: 0,
  },
  author: {
    maxWidth: '72px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  meta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flex: 1,
  },
  keyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  key: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: tokens.colorNeutralForeground1,
  },
  badge: {
    flexShrink: 0,
    fontSize: '10px',
    lineHeight: '14px',
    padding: '0 4px',
    borderRadius: '3px',
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  name: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
  },
  hint: {
    padding: '10px 8px',
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground4,
  },
  note: {
    flexShrink: 0,
    padding: '6px 10px',
    borderTop: '1px solid ' + tokens.colorNeutralStroke2,
    fontSize: '11px',
    lineHeight: '1.4',
    color: tokens.colorNeutralForeground4,
    backgroundColor: tokens.colorNeutralBackground2,
  },
})

export function MentionAutocomplete({ textareaRef, onChange, disabled = false }) {
  const styles = useStyles()
  const { t, i18n } = useTranslation()
  const [mention, setMention] = useState(null) // { start, caret }
  const [query, setQuery] = useState('')
  const [records, setRecords] = useState([])
  const [active, setActive] = useState(0)
  const [cacheLoading, setCacheLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  // 记录「哪个关键词已经真正查过云端」，用于区分本地缓存无结果与云端无结果
  const [searchedQuery, setSearchedQuery] = useState(null)
  const [failed, setFailed] = useState(false)
  // 滚出视口时只隐藏、不关闭：纯滚动回来还能继续用
  const [offscreen, setOffscreen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const mentionRef = useRef(null)
  const popoverRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // 定位 layout effect 依赖这个 ref，必须先于它运行
  useLayoutEffect(() => {
    mentionRef.current = mention
  }, [mention])

  const items = useMemo(() => searchMentionRecords(records, query), [records, query])
  const open = !!mention

  const close = useCallback(() => {
    setMention(null)
    setQuery('')
    setActive(0)
    setFailed(false)
    setSearchedQuery(null)
  }, [])

  // 打开 @ 时读本地缓存（SQLite，不发网络）；必须在事件里触发，避免 effect 里同步 setState
  const loadCache = useCallback(() => {
    setRecords((prev) => mergeRecords(currentMentionRecords(), prev))
    setCacheLoading(true)
    loadCachedMentionRecords()
      .then((cached) => setRecords((prev) => mergeRecords(cached, prev)))
      .finally(() => setCacheLoading(false))
  }, [])

  const focusTextarea = useCallback(() => {
    const el = textareaRef.current
    const m = mentionRef.current
    close()
    if (!el) return
    requestAnimationFrame(() => {
      el.focus()
      if (m) el.setSelectionRange(m.caret, m.caret)
    })
  }, [textareaRef, close])

  const sync = useCallback((el) => {
    if (!el) return
    const caret = el.selectionStart
    if (caret == null || caret !== el.selectionEnd) {
      close()
      return
    }
    const match = TRIGGER_RE.exec(el.value.slice(0, caret))
    if (!match) {
      close()
      return
    }
    const q = match[1]
    const start = caret - q.length - 1
    if (!mentionRef.current) loadCache()
    setActive(0)
    setQuery(q)
    setMention((prev) => {
      if (prev && prev.start === start && prev.caret === caret) return prev
      return { start, caret }
    })
  }, [close, loadCache])

  const updatePosition = useCallback(() => {
    const el = textareaRef.current
    const m = mentionRef.current
    if (!el || !m) return
    const rect = el.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      setOffscreen(true)
      return
    }
    setOffscreen(false)
    const coords = caretCoordinates(el, m.caret)
    const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight) || 18
    const top = rect.top + coords.top - el.scrollTop + lineHeight + 4
    const left = rect.left + coords.left - el.scrollLeft
    setPos({
      top: Math.max(8, Math.min(top, window.innerHeight - POPOVER_MAX_HEIGHT - 8)),
      left: Math.max(8, Math.min(left, window.innerWidth - POPOVER_WIDTH - 8)),
    })
  }, [textareaRef])

  const selectItem = useCallback((item) => {
    const el = textareaRef.current
    const m = mentionRef.current
    if (!el || !m || !item) return
    const label = String(item.title || item.ref).replace(/[[\]]/g, '')
    const scheme = item.kind === MENTION_DISCUSSION ? 'sfmmm:discuss:' : 'sfmmm:mod:'
    const token = '[@' + label + '](' + scheme + encodeURIComponent(item.ref) + ')'
    const next = el.value.slice(0, m.start) + token + el.value.slice(m.caret)
    close()
    onChange?.(next)
    requestAnimationFrame(() => {
      el.focus()
      const caret = m.start + token.length
      el.setSelectionRange(caret, caret)
    })
  }, [textareaRef, onChange, close])

  const runSearch = useCallback(async () => {
    if (searching) return
    setSearching(true)
    setFailed(false)
    const q = query.trim()
    try {
      const found = await runMentionSearch(query, i18n.language)
      // 新结果放前面：空关键词搜索时也能立刻看到刚查回来的内容
      setRecords((prev) => mergeRecords(found, prev))
      setSearchedQuery(q)
      setActive(0)
    } catch {
      setFailed(true)
    } finally {
      setSearching(false)
      // 结果替换后从顶部开始看，避免停留在旧的滚动位置错过新内容
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = 0
      })
    }
  }, [searching, query, i18n.language])

  // textarea 原生监听：识别 @ 触发词；焦点在搜索框时这里不参与键盘处理
  useEffect(() => {
    const el = textareaRef.current
    if (!el || disabled) return undefined
    const onInput = () => sync(el)
    const onClick = () => sync(el)
    const onKeyUp = (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'].includes(e.key)) sync(el)
    }
    const onKeyDown = (e) => {
      if (!mentionRef.current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        focusTextarea()
        return
      }
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        runSearch()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => {
          if (!items.length) return 0
          return (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        })
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !searching) {
        const target = items[active]
        if (target) {
          e.preventDefault()
          e.stopPropagation()
          selectItem(target)
        }
      }
    }
    el.addEventListener('input', onInput)
    el.addEventListener('click', onClick)
    el.addEventListener('keyup', onKeyUp)
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('input', onInput)
      el.removeEventListener('click', onClick)
      el.removeEventListener('keyup', onKeyUp)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [textareaRef, disabled, sync, focusTextarea, items, active, selectItem, runSearch, searching])

  // 点击浮层与 textarea 之外关闭
  useEffect(() => {
    if (!mention) return undefined
    const onDown = (e) => {
      if (popoverRef.current?.contains(e.target)) return
      if (e.target === textareaRef.current) return
      close()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [mention, close, textareaRef])

  // 光标位置变化时只重新定位，不抢焦点；聚焦只在「关闭 -> 打开」时做一次
  useLayoutEffect(() => {
    if (!mention) return
    updatePosition()
  }, [mention, updatePosition])

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // 页面/容器滚动时跟随 textarea 重新定位；滚出视口则隐藏（不关闭）
  useEffect(() => {
    if (!mention) return undefined
    const onScroll = () => updatePosition()
    const onResize = () => updatePosition()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [mention, updatePosition])

  if (!mention || disabled) return null

  const showEmptyPrompt = !query.trim() && records.length === 0 && !cacheLoading

  return (
    <div
      ref={popoverRef}
      className={styles.popover}
      style={{
        top: pos.top + 'px',
        left: pos.left + 'px',
        visibility: offscreen ? 'hidden' : 'visible',
      }}
    >
      <div className={styles.searchRow}>
        <Search16Regular aria-hidden="true" />
        <div className={styles.searchField}>
          <input
            ref={inputRef}
            className={styles.searchInput}
            value={query}
            placeholder={t('editor.mentionCacheLabel')}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                focusTextarea()
                return
              }
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                runSearch()
                return
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => {
                  if (!items.length) return 0
                  return (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                })
                return
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && !searching) {
                const target = items[active]
                if (target) {
                  e.preventDefault()
                  selectItem(target)
                }
              }
            }}
          />
        </div>
        <Button
          size="small"
          appearance="subtle"
          icon={<Search16Regular />}
          disabled={searching}
          onClick={runSearch}
        >
          {searching ? t('editor.mentionSearching') : t('editor.mentionSearch')}
        </Button>
      </div>
      <div ref={listRef} className={styles.list}>
        {searching && <div className={styles.hint}>{t('editor.mentionSearching')}</div>}
        {!searching && cacheLoading && records.length === 0 && (
          <div className={styles.hint}>{t('editor.mentionCacheLoading')}</div>
        )}
        {!searching && showEmptyPrompt && <div className={styles.hint}>{t('editor.mentionPrompt')}</div>}
        {!searching && failed && <div className={styles.hint}>{t('editor.mentionUnavailable')}</div>}
        {!searching && !failed && !!query.trim() && items.length === 0 && !cacheLoading && (
          <div className={styles.hint}>
            {searchedQuery === query.trim()
              ? t('editor.mentionNoResultCloud')
              : t('editor.mentionNoResultCache')}
          </div>
        )}
        {!searching && items.map((item, i) => (
          <div
            key={item.kind + ':' + item.ref}
            className={mergeClasses(styles.item, i === active && styles.itemActive)}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              selectItem(item)
            }}
          >
            <div className={styles.identity}>
              <UserAvatar
                avatar={item.author_avatar}
                name={item.author_name}
                size={26}
                userId={item.author_id}
              />
              <span className={styles.author}>{item.author_name}</span>
            </div>
            <div className={styles.meta}>
              <div className={styles.keyRow}>
                <span className={styles.key}>{item.subtitle}</span>
                {item.kind === MENTION_DISCUSSION && (
                  <span className={styles.badge}>{t('editor.mentionTypeDiscussion')}</span>
                )}
              </div>
              <span className={styles.name}>{item.title}</span>
            </div>
          </div>
        ))}
      </div>
      <div className={styles.note}>{t('editor.mentionNote')}</div>
    </div>
  )
}

export default MentionAutocomplete
