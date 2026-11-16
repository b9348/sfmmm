import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { Mail24Regular, ArrowClockwise24Regular } from '@fluentui/react-icons'
import { useAuth } from '../../contexts/useAuth'
import { useNotification } from '../../contexts/NotificationContext'
import { getMyMessages, markMessageRead } from '../../services/workshopApi'
import { EmptyState, Pagination } from '../../components'

const PAGE_SIZE = 20

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    gap: '8px',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    flexShrink: 0,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '4px',
  },
  card: {
    cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardUnread: {
    borderLeft: `3px solid ${tokens.colorBrandForeground1}`,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  title: {
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  time: {
    marginLeft: 'auto',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  unreadDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: tokens.colorBrandForeground1,
    flexShrink: 0,
  },
  preview: {
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    marginTop: '4px',
  },
  detailBody: {
    whiteSpace: 'pre-wrap',
    maxHeight: '48vh',
    overflowY: 'auto',
    wordBreak: 'break-word',
    lineHeight: 1.6,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
})

/**
 * 站内信：系统 / 管理员发给当前用户的消息。
 * 非默认 tab；由 NotifyPage 在「回复」页预加载。消息不落本地 SQLite 缓存。
 */
export function MessageInbox({ visible = true }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const { user, isLoggedIn } = useAuth()
  const { unread, refreshUnread, notifySeq } = useNotification()

  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [markingAll, setMarkingAll] = useState(false)
  const prevSeq = useRef(notifySeq)

  const fetchMessages = useCallback(async () => {
    if (!isLoggedIn || !user) return
    setLoading(true)
    try {
      const res = await getMyMessages({
        user_id: user.user_id,
        page,
        page_size: PAGE_SIZE,
      })
      setItems(res.items || [])
      setTotal(res.total || 0)
      setError('')
    } catch (e) {
      setItems([])
      setTotal(0)
      setError(e?.message || t('inbox.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [isLoggedIn, user, page, t])

  // 预加载设计：挂载后直接拉取，不等 tab 可见。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMessages()
  }, [fetchMessages])

  // 只有当前可见时才刷新未读，避免预加载面板重复查询。
  useEffect(() => {
    if (visible && isLoggedIn && user) refreshUnread(user.user_id)
  }, [visible, isLoggedIn, user, refreshUnread])

  // 收到服务端 WS 失效信号后重拉；若当前不在第 1 页，先回到第 1 页。
  useEffect(() => {
    if (!visible || prevSeq.current === notifySeq) return
    prevSeq.current = notifySeq
    // 页码变化会由 fetchMessages 依赖触发重拉；这里只负责回到第 1 页。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (page !== 1) setPage(1)
    else fetchMessages()
  }, [notifySeq, visible, page, fetchMessages])

  const markOneRead = async (message) => {
    if (!user || message.is_read) return
    try {
      await markMessageRead({ user_id: user.user_id, ids: [message.id] })
      setItems((prev) => prev.map((m) => (m.id === message.id ? { ...m, is_read: true } : m)))
      setDetail((prev) => (prev && prev.id === message.id ? { ...prev, is_read: true } : prev))
      refreshUnread(user.user_id)
    } catch {
      // 已读失败不阻塞查看正文；保留未读标记，下次刷新会重试
    }
  }

  const openMessage = (message) => {
    setDetail(message)
    markOneRead(message)
  }

  const handleMarkAll = async () => {
    if (!user || markingAll) return
    setMarkingAll(true)
    try {
      await markMessageRead({ user_id: user.user_id, ids: null })
      setItems((prev) => prev.map((m) => ({ ...m, is_read: true })))
      setDetail((prev) => (prev ? { ...prev, is_read: true } : prev))
      refreshUnread(user.user_id)
    } catch (e) {
      setError(e?.message || t('inbox.loadFailed'))
    } finally {
      setMarkingAll(false)
    }
  }

  const totalPages = Math.ceil(Math.max(total, 1) / PAGE_SIZE)
  const unsupported = error && error.includes('未知命令')
  const hasUnread = unread.messages > 0 || items.some((m) => !m.is_read)

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        {loading && <Spinner size="tiny" />}
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowClockwise24Regular />}
          onClick={fetchMessages}
          disabled={loading || !isLoggedIn}
        >
          {t('inbox.refresh')}
        </Button>
        <Button
          size="small"
          appearance="subtle"
          onClick={handleMarkAll}
          disabled={markingAll || !hasUnread}
        >
          {t('inbox.markAllRead')}
        </Button>
      </div>

      <div className={styles.list}>
        {error && (
          <Text className={styles.error}>
            {unsupported ? t('inbox.serverUnsupported') : error}
          </Text>
        )}

        {!loading && items.length === 0 && !error && (
          <EmptyState icon={<Mail24Regular />} title={t('inbox.empty')} />
        )}

        {items.map((message) => (
          <Card
            key={message.id}
            className={`${styles.card}${message.is_read ? '' : ` ${styles.cardUnread}`}`}
            onClick={() => openMessage(message)}
          >
            <div className={styles.header}>
              {!message.is_read && <span className={styles.unreadDot} aria-hidden="true" />}
              <Badge
                appearance="tint"
                size="small"
                color={message.category === 'account' ? 'warning' : 'brand'}
              >
                {message.category === 'account'
                  ? t('inbox.categoryAccount')
                  : t('inbox.categoryNotice')}
              </Badge>
              <Text className={styles.title} title={message.title}>
                {message.title}
              </Text>
              <Text className={styles.meta}>{t('inbox.senderSystem')}</Text>
              <Text className={styles.time}>{message.created_at}</Text>
            </div>
            <Text className={styles.preview}>{message.body}</Text>
          </Card>
        ))}

        <Pagination
          page={page}
          totalPages={totalPages}
          onChange={(p) => setPage(p)}
          disabled={loading}
        />
      </div>

      <Dialog
        open={!!detail}
        onOpenChange={(_, d) => {
          if (!d.open) setDetail(null)
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{detail?.title || t('inbox.detailTitle')}</DialogTitle>
            <DialogContent>
              <div className={styles.header} style={{ marginBottom: '8px' }}>
                <Badge
                  appearance="tint"
                  size="small"
                  color={detail?.category === 'account' ? 'warning' : 'brand'}
                >
                  {detail?.category === 'account'
                    ? t('inbox.categoryAccount')
                    : t('inbox.categoryNotice')}
                </Badge>
                <Text className={styles.meta}>{t('inbox.senderSystem')}</Text>
                <Text className={styles.meta}>{detail?.created_at}</Text>
              </div>
              <div className={styles.detailBody}>{detail?.body}</div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" size="small" onClick={() => setDetail(null)}>
                {t('inbox.close')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}

export default MessageInbox
