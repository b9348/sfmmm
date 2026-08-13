import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, CardHeader, Text, Badge, Button,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular, ArrowRight24Regular,
  Comment24Regular, Chat24Regular,
} from '@fluentui/react-icons'
import { listMyDiscussions, listMyDiscussionComments } from '../../services/workshopApi'
import { EmptyState } from '../../components'

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
  snippet: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
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
 * 发帖 + 回复（含楼中楼）合并为按时间倒序的单一列表，
 * 用 tag（发帖/回复）区分条目类型；点击跳转讨论详情，回复条目定位到对应楼层。
 */
export function MyDiscussions({ userId, isLoggedIn, onOpenDiscussion }) {
  const { t } = useTranslation()
  const styles = useStyles()

  // 混合列表：{ kind: 'post' | 'reply', ... }，按 created_at 倒序
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const initialFetch = useRef(false)

  const fetchAll = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    setError('')
    try {
      // 两个接口各取一页（个人历史量级较小），合并后按时间倒序
      const [postsRes, repliesRes] = await Promise.all([
        listMyDiscussions({ author_id: userId, page: 1, page_size: 50, user_id: userId }),
        listMyDiscussionComments({ author_id: userId, page: 1, page_size: 50 }),
      ])
      const posts = (postsRes.discussions || []).map(d => ({
        kind: 'post',
        id: d.id,
        title: d.title,
        content: d.content,
        created_at: d.created_at,
        meta: [
          t('discussion.likeCount', { count: d.like_count || 0 }),
          t('discussion.boostCount', { count: d.boost_count || 0 }),
          t('discussion.commentCount', { count: d.comment_count || 0 }),
        ].join(' · '),
        poll_type: d.poll?.poll_type,
      }))
      const replies = (repliesRes.comments || []).map(c => ({
        kind: 'reply',
        id: c.comment_id,
        title: c.discussion_title,
        content: c.content,
        created_at: c.created_at,
        meta: t('discussion.replyIn') + ' · ' + c.created_at,
        discussion_id: c.discussion_id,
        comment_id: c.comment_id,
      }))
      const merged = [...posts, ...replies]
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      setItems(merged)
    } catch (e) {
      setError(e.message)
      setItems([])
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

      {loading && items.length === 0 ? (
        <EmptyState title={t('discussion.loading')} />
      ) : error ? (
        <EmptyState title={error} description={t('discussion.retry')} />
      ) : items.length === 0 ? (
        <EmptyState title={t('discussion.noMyPosts')} description={t('discussion.noMyReplies')} />
      ) : (
        <div className={styles.list}>
          {items.map(item => (
            <Card
              key={`${item.kind}-${item.id}`}
              className={styles.card}
              appearance="outline"
              onClick={() => {
                if (item.kind === 'post') {
                  onOpenDiscussion?.(item.id, null)
                } else {
                  onOpenDiscussion?.(item.discussion_id, item.comment_id)
                }
              }}
            >
              <CardHeader
                header={
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    {item.kind === 'post' ? (
                      <Badge appearance="outline" color="brand" size="small" style={{ whiteSpace: 'nowrap' }}>
                        <Comment24Regular style={{ fontSize: '12px', marginRight: '2px', verticalAlign: 'middle' }} />
                        {t('discussion.myPosts')}
                      </Badge>
                    ) : (
                      <Badge appearance="outline" color="informative" size="small" style={{ whiteSpace: 'nowrap' }}>
                        <Chat24Regular style={{ fontSize: '12px', marginRight: '2px', verticalAlign: 'middle' }} />
                        {t('discussion.myReplies')}
                      </Badge>
                    )}
                    <Text className={styles.title} truncate>{item.title}</Text>
                    {item.kind === 'post' && item.poll_type && (
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
              {item.content && <Text size="small" className={styles.snippet}>{item.content}</Text>}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

export default MyDiscussions
