import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, CardHeader, Text, Badge, Button,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular, ArrowRight24Regular,
} from '@fluentui/react-icons'
import { listMyDiscussions, listMyDiscussionComments } from '../../services/workshopApi'
import { EmptyState } from '../../components'
import { extractFirstImage } from '../../utils/extractFirstImage'

const POLL_TYPE_LABELS = {
  single: 'discussion.pollSingle',
  multiple: 'discussion.pollMultiple',
  number: 'discussion.pollNumber',
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    height: '100%',
    minHeight: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
  },
  // 发帖（左）/ 回复（右）默认两栏，窄屏回落到上下排列
  columns: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    '@media (max-width: 768px)': {
      gridTemplateColumns: '1fr',
    },
  },
  // 每栏独立纵向滚动，各自内部排列
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minHeight: 0,
    overflowY: 'auto',
  },
  // 分区标题：沿用卡片里类型徽标的外观（brand=发帖 / informative=回复）。
  // Badge 的 icon 插槽带负 margin（-spacingHorizontalXXS，用于抵消 root 的额外 padding），
  // 而 section 是滚动容器（overflow 裁剪），会给这块内容留出对应的水平余量，否则图标左侧被切。
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    paddingLeft: tokens.spacingHorizontalXXS,
  },
  // 分区内无内容时的占位文案
  sectionEmpty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  card: {
    cursor: 'pointer',
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
  },
  title: {
    fontWeight: 600,
  },
  // 有配图时正文缩进对齐缩略图右侧
  body: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    marginTop: '4px',
  },
  // 缩略图样式与讨论区列表页 DiscussionCard 保持一致
  thumb: {
    maxWidth: '33.33%',
    maxHeight: '140px',
    objectFit: 'cover',
    borderRadius: '6px',
    display: 'block',
    backgroundColor: tokens.colorNeutralBackground1Hover,
  },
  snippet: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    margin: 0,
  },
  stats: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
  },
})

/**
 * 我的讨论（并入「我的」二级菜单）：
 * 发帖与回复（含楼中楼）分为两个独立分区，各自按 created_at 倒序；
 * 点击跳转讨论详情，回复条目定位到对应楼层。
 */
export function MyDiscussions({ userId, isLoggedIn, onOpenDiscussion }) {
  const { t } = useTranslation()
  const styles = useStyles()

  // 两个分区分别维护：各自按 created_at 倒序
  const [posts, setPosts] = useState([])
  const [replies, setReplies] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const initialFetch = useRef(false)

  const fetchAll = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    setError('')
    try {
      // 两个接口各取一页（个人历史量级较小），各自倒序后填入对应分区
      const [postsRes, repliesRes] = await Promise.all([
        listMyDiscussions({ author_id: userId, page: 1, page_size: 50, user_id: userId }),
        listMyDiscussionComments({ author_id: userId, page: 1, page_size: 50 }),
      ])
      const byCreatedDesc = (a, b) => String(b.created_at).localeCompare(String(a.created_at))
      setPosts((postsRes.discussions || []).map(d => {
        const { image, text } = extractFirstImage(d.content)
        return {
          id: d.id,
          title: d.title,
          image,
          text,
          created_at: d.created_at,
          meta: [
            t('discussion.likeCount', { count: d.like_count || 0 }),
            t('discussion.boostCount', { count: d.boost_count || 0 }),
            t('discussion.commentCount', { count: d.comment_count || 0 }),
          ].join(' · '),
          poll_type: d.poll?.poll_type,
        }
      }).sort(byCreatedDesc))
      setReplies((repliesRes.comments || []).map(c => {
        const { image, text } = extractFirstImage(c.content)
        return {
          id: c.comment_id,
          title: c.discussion_title,
          image,
          text,
          created_at: c.created_at,
          meta: t('discussion.replyIn') + ' · ' + c.created_at,
          discussion_id: c.discussion_id,
          comment_id: c.comment_id,
        }
      }).sort(byCreatedDesc))
    } catch (e) {
      setError(e.message)
      setPosts([])
      setReplies([])
    } finally {
      setLoading(false)
    }
  }, [userId, t])

  useEffect(() => {
    if (isLoggedIn && !initialFetch.current) {
      initialFetch.current = true
      fetchAll()
    }
  }, [isLoggedIn, fetchAll])

  if (!isLoggedIn) {
    return (
      <EmptyState
        title={t('discussion.loginRequired')}
        description={t('discussion.mine')}
      />
    )
  }

  // 卡片：发帖 / 回复结构一致，靠 kind 决定点击目标（帖子进详情，回复定位到楼层）
  const renderCard = (item, kind) => (
    <Card
      key={kind + '-' + item.id}
      className={styles.card}
      appearance="outline"
      onClick={() => {
        if (kind === 'post') {
          onOpenDiscussion?.(item.id, null)
        } else {
          onOpenDiscussion?.(item.discussion_id, item.comment_id)
        }
      }}
    >
      <CardHeader
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <Text className={styles.title} truncate>{item.title}</Text>
            {kind === 'post' && item.poll_type && (
              <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
                {t(POLL_TYPE_LABELS[item.poll_type] || 'discussion.pollSingle')}
              </Badge>
            )}
          </div>
        }
        description={
          <Text size="small" className={styles.meta}>
            {item.created_at} · {item.meta}
          </Text>
        }
        action={<ArrowRight24Regular style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />}
      />
      {(item.image || item.text) && (
        <div className={styles.body}>
          {item.image && <img src={item.image} alt="" className={styles.thumb} loading="lazy" />}
          {item.text && <Text size="small" className={styles.snippet}>{item.text}</Text>}
        </div>
      )}
    </Card>
  )

  // 分区渲染：类型徽标 + 条数 + 列表，空分区回落到占位文案
  const renderSection = (titleKey, emptyKey, items, kind) => (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <Badge
          appearance="outline"
          color={kind === 'post' ? 'brand' : 'informative'}
          size="small"
          style={{ whiteSpace: 'nowrap' }}
        >
          {t(titleKey)}
        </Badge>
        <Text className={styles.meta} size="small">({items.length})</Text>
      </div>
      {items.length === 0 ? (
        <Text className={styles.sectionEmpty}>{t(emptyKey)}</Text>
      ) : (
        <div className={styles.list}>
          {items.map(item => renderCard(item, kind))}
        </div>
      )}
    </div>
  )

  const isEmpty = posts.length === 0 && replies.length === 0

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Text size="small" style={{ flex: 1 }}>
          {t('discussion.mine')}
        </Text>
        <Button size="small" icon={<ArrowClockwise24Regular />} onClick={fetchAll} disabled={loading}>
          {t('discussion.refresh')}
        </Button>
      </div>

      {loading && isEmpty ? (
        <EmptyState title={t('discussion.loading')} />
      ) : error ? (
        <EmptyState title={error} description={t('discussion.retry')} />
      ) : isEmpty ? (
        <EmptyState title={t('discussion.noMyPosts')} description={t('discussion.noMyReplies')} />
      ) : (
        <div className={styles.columns}>
          {renderSection('discussion.myPosts', 'discussion.noMyPosts', posts, 'post')}
          {renderSection('discussion.myReplies', 'discussion.noMyReplies', replies, 'reply')}
        </div>
      )}
    </div>
  )
}

export default MyDiscussions
