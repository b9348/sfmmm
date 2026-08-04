import { useEffect, useState, useRef } from 'react'
import { Card, CardHeader, Title2, Text, Spinner } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'

const ACKNOWLEDGMENTS_URL = 'https://img.b9349.dpdns.org/file/sfm/thanks/acknowledgments.md'
const CACHE_KEY = 'acknowledgments_cache'

/** Markdown 中语言标题到 i18n 语言代码的映射 */
const HEADER_TO_LANG = {
  '中文': 'zh',
  'English': 'en',
  '日本語': 'ja',
}

const useStyles = makeStyles({
  desc: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    marginBottom: '4px',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    fontSize: tokens.fontSizeBase,
    lineHeight: tokens.lineHeightBase,
  },
  bullet: {
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
    lineHeight: tokens.lineHeightBase,
  },
  name: {
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  loading: {
    padding: '24px',
    display: 'flex',
    justifyContent: 'center',
  },
  error: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    padding: '16px',
    textAlign: 'center',
  },
})

/**
 * 将文本中 "**名字**" 或 "`名字`" 包裹的部分渲染为加粗
 */
function renderWithName(text, styles) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
  return parts.map((part, i) => {
    const name = part.replace(/^\*\*|\*\*$/g, '').replace(/^`|`$/g, '')
    if (name !== part) {
      return <span key={i} className={styles.name}>{name}</span>
    }
    return <span key={i}>{part}</span>
  })
}

/**
 * 解析 Markdown，按语言标题切分段落
 */
function parseSections(markdown) {
  const lines = markdown.split(/\r?\n/)
  const sections = []
  let current = null

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)/)
    if (headerMatch) {
      const lang = HEADER_TO_LANG[headerMatch[1].trim()]
      if (lang) {
        if (current) sections.push(current)
        current = { lang, title: headerMatch[1].trim(), desc: '', items: [] }
      }
      continue
    }
    if (!current) continue

    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      current.items.push(trimmed.slice(2))
    } else if (trimmed && !trimmed.startsWith('#')) {
      if (current.items.length === 0 && !current.desc) {
        current.desc = trimmed
      }
    }
  }
  if (current) sections.push(current)
  return sections
}

/**
 * 通过 Rust reqwest 拉取（绕过 WebView 缓存），返回纯文本
 */
async function fetchViaRust(url) {
  const raw = await invoke('http_request', { url, method: 'GET' })
  const parsed = JSON.parse(raw)
  if (parsed.status !== 200) throw new Error(`HTTP ${parsed.status}`)
  return parsed.body
}

/**
 * 设置页 - 感谢名单模块
 * 策略：localStorage 缓存（瞬间展示）+ Rust reqwest 后台静默刷新（绕过 WebView 缓存）
 */
export function Acknowledgments() {
  const { i18n } = useTranslation()
  const styles = useStyles()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  // 标记是否首次渲染完成（用于区分「首次加载无缓存」和「后台刷新」）
  const hydrated = useRef(false)

  useEffect(() => {
    let cancelled = false

    // 第一步：从 localStorage 读取缓存，瞬间渲染
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached) {
      try {
        const parsed = parseSections(cached)
        if (!cancelled) {
          setData(parsed)
          hydrated.current = true
        }
      } catch {
        // 缓存损坏，忽略
      }
    }

    // 第二步：通过 Rust reqwest 静默拉取最新内容（无 WebView 缓存）
    fetchViaRust(ACKNOWLEDGMENTS_URL)
      .then((text) => {
        if (cancelled) return
        // 写入缓存
        localStorage.setItem(CACHE_KEY, text)
        // 解析并更新 UI
        setData(parseSections(text))
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        // 已有缓存的情况下静默忽略网络错误
        if (!hydrated.current) {
          setError(e.message)
        }
      })

    return () => { cancelled = true }
  }, [])

  const currentLang = i18n.language?.startsWith('ja') ? 'ja' : i18n.language?.startsWith('en') ? 'en' : 'zh'
  const section = data?.find((s) => s.lang === currentLang)
  const items = section?.items ?? []

  // 首次加载无缓存且请求失败
  if (error && !data) {
    return (
      <Card appearance="outline">
        <CardHeader header={<Title2>感谢名单</Title2>} />
        <Text className={styles.error}>加载失败：{error}</Text>
      </Card>
    )
  }

  // 首次加载无缓存，等待 Rust 请求
  if (!data) {
    return (
      <Card appearance="outline">
        <CardHeader header={<Title2>感谢名单</Title2>} />
        <div className={styles.loading}>
          <Spinner size="small" />
        </div>
      </Card>
    )
  }

  return (
    <Card appearance="outline">
      <CardHeader header={<Title2>感谢名单</Title2>} />
      <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {section?.desc && <Text className={styles.desc}>{section.desc}</Text>}
        <div className={styles.list}>
          {items.map((item, idx) => (
            <div className={styles.item} key={idx}>
              <span className={styles.bullet}>•</span>
              <span>{renderWithName(item, styles)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

export default Acknowledgments