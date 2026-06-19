import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Spinner, Card, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowUndo24Regular, Checkmark24Regular, Delete24Regular,
} from '@fluentui/react-icons'
import { useAuth } from '../../contexts/AuthContext'
import { useNotification } from '../../contexts/NotificationContext'
import { listApplications, handleApplication, getMyNotifications, markRead } from '../../services/workshopApi'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    gap: '12px',
    padding: '16px',
  },
  sectionTitle: {
    fontWeight: '600',
    fontSize: tokens.fontSizeBase400,
    marginBottom: '8px',
    marginTop: '8px',
  },
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
  },
  card: {
    padding: '12px',
    marginBottom: '8px',
    cursor: 'pointer',
    transition: 'box-shadow 0.2s ease',
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  cardContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  metaText: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
  },
  actionRow: {
    display: 'flex',
    gap: '6px',
    marginTop: '8px',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
    padding: '32px',
    textAlign: 'center',
  },
  scopeBadge: {
    fontSize: '11px',
    padding: '1px 6px',
    borderRadius: '3px',
    background: tokens.colorNeutralBackground3,
  },
  pagination: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '6px',
    padding: '12px',
  },
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
})

export default function ApplicationsPage({ onNavigate }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const { user, isLoggedIn } = useAuth()
  const { refreshUnread } = useNotification()
  const SCOPE_LABELS = {
    mod_info: t('workshop.scopeModInfo'),
    lang_all: t('workshop.scopeLangAll'),
    lang_specific: t('workshop.scopeLangSpecific'),
  }

  // Pending applications state
  const [apps, setApps] = useState([])
  const [loadingApps, setLoadingApps] = useState(false)
  const [totalApps, setTotalApps] = useState(0)
  const [appPage, setAppPage] = useState(1)

  // Notifications state
  const [notifs, setNotifs] = useState([])
  const [loadingNotifs, setLoadingNotifs] = useState(false)
  const [totalNotifs, setTotalNotifs] = useState(0)
  const [notifPage, setNotifPage] = useState(1)

  const PAGE_SIZE = 20

  const fetchPendingApps = useCallback(async () => {
    if (!user) return
    setLoadingApps(true)
    try {
      const res = await listApplications({
        user_id: user.user_id,
        role: 'author',
        status: 'pending',
        page: appPage,
        page_size: PAGE_SIZE,
      })
      setApps(res.applications || [])
      setTotalApps(res.total || 0)
    } catch {
      setApps([])
    } finally {
      setLoadingApps(false)
    }
  }, [user, appPage])

  const fetchNotifs = useCallback(async () => {
    if (!user) return
    setLoadingNotifs(true)
    try {
      const res = await getMyNotifications({
        user_id: user.user_id,
        page: notifPage,
        page_size: PAGE_SIZE,
      })
      setNotifs(res.items || [])
      setTotalNotifs(res.total || 0)
    } catch {
      setNotifs([])
    } finally {
      setLoadingNotifs(false)
    }
  }, [user, notifPage])

  useEffect(() => {
    if (isLoggedIn && user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchPendingApps()
    }
  }, [isLoggedIn, user, fetchPendingApps])

  useEffect(() => {
    if (isLoggedIn && user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchNotifs()
    }
  }, [isLoggedIn, user, fetchNotifs])

  // 每次打开页面时刷新侧边栏未读计数
  useEffect(() => {
    if (isLoggedIn && user) {
      refreshUnread(user.user_id)
    }
  }, [isLoggedIn, user, refreshUnread])

  const handleApprove = async (appId) => {
    try {
      await handleApplication({ author_id: user.user_id, app_id: appId, action: 'approve' })
      fetchPendingApps()
    } catch (e) {
      alert(e.message)
    }
  }

  const handleDeny = async (appId) => {
    try {
      await handleApplication({ author_id: user.user_id, app_id: appId, action: 'deny' })
      fetchPendingApps()
    } catch (e) {
      alert(e.message)
    }
  }

  const handleMarkAllRead = async () => {
    try {
      await markRead({ user_id: user.user_id, target_type: 'notification' })
      fetchNotifs()
      refreshUnread(user.user_id)
    } catch (e) {
      alert(e.message)
    }
  }

  const totalAppPages = Math.ceil(totalApps / PAGE_SIZE)
  const totalNotifPages = Math.ceil(totalNotifs / PAGE_SIZE)

  const truncateText = (str, maxLen = 80) => {
    if (!str) return ''
    return str.length > maxLen ? str.substring(0, maxLen) + '...' : str
  }

  if (!isLoggedIn) {
    return (
      <div className={styles.emptyState}>
        <Text weight="semibold">{t('workshop.loginRequired')}</Text>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      {/* Section 1: Pending applications */}
      <Text className={styles.sectionTitle}>{t('workshop.pendingApps')}</Text>
      <div className={styles.content}>
        {loadingApps && (
          <div className={styles.emptyState}>
            <Spinner size="small" />
          </div>
        )}

        {!loadingApps && apps.length === 0 && (
          <div className={styles.emptyState}>
            <Text className={styles.metaText}>{t('workshop.noPendingApps')}</Text>
          </div>
        )}

        {!loadingApps && apps.map((app) => (
          <Card key={app.id} className={styles.card}>
            <div className={styles.cardContent}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span className={styles.scopeBadge}>{SCOPE_LABELS[app.scope] || app.scope}</span>
                {app.target_lang && <Badge appearance="outline" size="small">{app.target_lang}</Badge>}
              </div>
              <Text weight="semibold" size="small">{app.mod_key || app.mod_name}</Text>
              <Text size="small" className={styles.metaText}>
                {t('workshop.applicant')}: {app.applicant_name}
              </Text>
              {app.reason && (
                <Text size="small" className={styles.metaText}>
                  {t('workshop.reason')}: {app.reason}
                </Text>
              )}
              <Text size="small" className={styles.metaText}>{app.created_at}</Text>
              <div className={styles.actionRow}>
                <Button
                  size="small"
                  appearance="primary"
                  icon={<Checkmark24Regular />}
                  onClick={() => handleApprove(app.id)}
                >
                  {t('workshop.approve')}
                </Button>
                <Button
                  size="small"
                  appearance="outline"
                  icon={<Delete24Regular />}
                  onClick={() => handleDeny(app.id)}
                >
                  {t('workshop.deny')}
                </Button>
              </div>
            </div>
          </Card>
        ))}

        {totalAppPages > 1 && (
          <div className={styles.pagination}>
            <Button size="small" disabled={appPage <= 1} onClick={() => setAppPage((p) => p - 1)}>
              {t('workshop.prevPage')}
            </Button>
            <Text size="small" className={styles.metaText}>
              {appPage} / {totalAppPages}
            </Text>
            <Button size="small" disabled={appPage >= totalAppPages} onClick={() => setAppPage((p) => p + 1)}>
              {t('workshop.nextPage')}
            </Button>
          </div>
        )}
      </div>

      {/* Section 2: 回复/评论通知 */}
      <div className={styles.sectionHeader}>
        <Text className={styles.sectionTitle}>{t('workshop.notifications')}</Text>
        <Button size="small" appearance="outline" icon={<ArrowUndo24Regular />} onClick={handleMarkAllRead}>
          {t('workshop.markAllRead')}
        </Button>
      </div>
      <div className={styles.content}>
        {loadingNotifs && (
          <div className={styles.emptyState}>
            <Spinner size="small" />
          </div>
        )}

        {!loadingNotifs && notifs.length === 0 && (
          <div className={styles.emptyState}>
            <Text className={styles.metaText}>{t('workshop.noNotifications')}</Text>
          </div>
        )}

        {!loadingNotifs && notifs.map((n) => (
          <Card key={n.id} className={styles.card} onClick={async () => {
            if (!n.is_read) {
              try {
                await markRead({ user_id: user.user_id, target_type: 'notification', ids: [n.id] })
                setNotifs(prev => prev.map(item => item.id === n.id ? { ...item, is_read: true } : item))
                refreshUnread(user.user_id)
              } catch (e) { console.error('markRead failed', e) }
            }
            onNavigate?.(n.mod_id, n.comment_id)
          }}>
            <div className={styles.cardContent}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                <Badge appearance="outline" size="small">
                  {n.type === 'new_comment' ? '评论' : '回复'}
                </Badge>
                {!n.is_read && (
                  <Badge appearance="filled" size="small" color="brand">
                    未读
                  </Badge>
                )}
              </div>
              <Text weight="semibold" size="small">{n.mod_key || n.mod_name}</Text>
              <Text size="small" className={styles.truncate} title={n.content}>
                {truncateText(n.content)}
              </Text>
              <Text size="small" className={styles.metaText}>
                {n.author_name} · {n.created_at}
              </Text>
            </div>
          </Card>
        ))}

        {totalNotifPages > 1 && (
          <div className={styles.pagination}>
            <Button size="small" disabled={notifPage <= 1} onClick={() => setNotifPage((p) => p - 1)}>
              上一页
            </Button>
            <Text size="small" className={styles.metaText}>
              {notifPage} / {totalNotifPages}
            </Text>
            <Button size="small" disabled={notifPage >= totalNotifPages} onClick={() => setNotifPage((p) => p + 1)}>
              下一页
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
