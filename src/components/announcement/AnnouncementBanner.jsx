import { useEffect } from 'react'
import { Text, makeStyles, tokens } from '@fluentui/react-components'
import { Info24Regular } from '@fluentui/react-icons'
import { useAnnouncement } from '../../contexts/AnnouncementContext'

const useStyles = makeStyles({
  banner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '10px 12px',
    flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  icon: {
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
    marginTop: '2px',
  },
  text: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  title: {
    wordBreak: 'break-word',
  },
  body: {
    display: 'block',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '96px',
    overflowY: 'auto',
  },
})

/**
 * 创意工坊顶部公告横幅：由 Workshop 在 TabList 上方渲染，所有子页签共用。
 * 第一次实际渲染时自动写本机 SQLite，之后永久不再展示。
 */
export function AnnouncementBanner() {
  const { banner, markBannerShown } = useAnnouncement()
  const styles = useStyles()

  useEffect(() => {
    if (banner?.id) markBannerShown(banner.id)
  }, [banner?.id, markBannerShown])

  if (!banner) return null

  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <Info24Regular aria-hidden className={styles.icon} />
      <div className={styles.text}>
        <Text weight="semibold" className={styles.title}>{banner.title}</Text>
        {banner.body && <Text size="small" className={styles.body}>{banner.body}</Text>}
      </div>
    </div>
  )
}
