import { useEffect, useState } from 'react'
import { makeStyles, tokens } from '@fluentui/react-components'
import { Globe16Regular } from '@fluentui/react-icons'
import { ImageWithLoading } from './ImageWithLoading'
import { fetchLinkPreview, getCachedLinkPreview } from '../../services/linkPreview'

/**
 * 正文里独立成段的链接渲染成的卡片（对标 Discourse 的 onebox）。
 *
 * - 抓取中 / 抓取失败都显示基础卡片（域名 + 链接），只是不显示标题、摘要与配图，
 *   避免「先普通链接、再跳成卡片」的闪烁，也保证失败的链接仍有卡片外形
 * - 点击走全局外链拦截器（installExternalLinkInterceptor），用系统浏览器打开
 */

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    margin: '4px 0 12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
    textDecoration: 'none',
    // 正文可能是 pre-wrap（纯文本简介），卡片内部恢复常规排版
    whiteSpace: 'normal',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      border: `1px solid ${tokens.colorNeutralStroke1Hover}`,
    },
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '10px 12px 6px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    minWidth: 0,
  },
  icon: {
    width: '16px',
    height: '16px',
    borderRadius: '3px',
    flexShrink: 0,
  },
  siteName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 封面图容器：宽度恒为卡片宽度，加载中用固定高度占位
  imageWrap: {
    display: 'block',
    width: '100%',
  },
  // 加载中只保留透明高度占位，不加可见底色
  imageWrapLoading: {
    minHeight: '140px',
  },
  image: {
    display: 'block',
    width: '100%',
    maxHeight: '260px',
    objectFit: 'cover',
  },
  body: {
    padding: '8px 12px 12px',
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: '1.35',
    display: '-webkit-box',
    WebkitLineClamp: '2',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
  },
  description: {
    marginTop: '4px',
    fontSize: tokens.fontSizeBase200,
    lineHeight: '1.5',
    color: tokens.colorNeutralForeground2,
    display: '-webkit-box',
    WebkitLineClamp: '3',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
  },
  url: {
    marginTop: '6px',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function LinkCard({ url }) {
  const styles = useStyles()
  // 用 url 一起存：内容编辑后复用同一实例时，不会把上一个链接的元数据留在卡片上
  const [state, setState] = useState(() => ({ url, preview: getCachedLinkPreview(url) }))
  const [iconFailed, setIconFailed] = useState(false)
  const preview = state.url === url ? state.preview : getCachedLinkPreview(url)

  useEffect(() => {
    let cancelled = false
    fetchLinkPreview(url).then((data) => {
      if (!cancelled && data) setState({ url, preview: data })
    })
    return () => { cancelled = true }
  }, [url])

  // 未拿到元数据（抓取中或抓取失败）：只展示域名与链接本身
  if (!preview) {
    return (
      <a className={styles.card} data-no-progressive="true" href={url} target="_blank" rel="noreferrer noopener">
        <div className={styles.header}>
          <Globe16Regular />
          <span className={styles.siteName}>{hostOf(url)}</span>
        </div>
        <div className={styles.body}>
          <div className={styles.title}>{url}</div>
        </div>
      </a>
    )
  }

  return (
    <a className={styles.card} data-no-progressive="true" href={url} target="_blank" rel="noreferrer noopener">
      <div className={styles.header}>
        {preview.icon && !iconFailed
          ? (
            <img
              className={styles.icon}
              src={preview.icon}
              alt=""
              loading="lazy"
              onError={() => setIconFailed(true)}
            />
          )
          : <Globe16Regular />}
        <span className={styles.siteName}>{preview.site_name || hostOf(url)}</span>
      </div>
      {preview.image && (
        <ImageWithLoading
          className={styles.imageWrap}
          loadingClassName={styles.imageWrapLoading}
          imgClassName={styles.image}
          src={preview.image}
          alt=""
          spinnerSize="small"
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = 'none' }}
        />
      )}
      <div className={styles.body}>
        {preview.title && <div className={styles.title}>{preview.title}</div>}
        {preview.description && <div className={styles.description}>{preview.description}</div>}
        <div className={styles.url}>{url}</div>
      </div>
    </a>
  )
}
