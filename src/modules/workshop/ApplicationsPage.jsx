import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Spinner, Card, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowUndo24Regular, Checkmark24Regular, Delete24Regular,
} from '@fluentui/react-icons'
import { useAuth } from '../../contexts/useAuth'
import { useNotification } from '../../contexts/NotificationContext'
import { listApplications, handleApplication, getMyNotifications, markRead } from '../../services/workshopApi'
import { Pagination, EmptyState, UserLink } from '../../components'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'row',
    height: '100%',
    minHeight: 0,
    gap: '16px',
    padding: '16px',
    '@media (max-width: 768px)': {
      flexDirection: 'column',
    },
  },
  panel: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  sectionTitle: {
    fontWeight: '600',
    fontSize: tokens.fontSizeBase400,
    margin: 0,
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
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
})

export default function ApplicationsPage({ onNavigate, panel, visible = true }) {
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

  // 常驻挂载下，从隐藏回到可见（再次进入该 tab）时重新拉取，避免列表/未读状态过期；
  // 首次展示（预加载目标）不重复拉取，直接呈现预加载结果
  const wasShown = useRef(false)
  useEffect(() => {
    if (!visible || !isLoggedIn || !user) return
    if (wasShown.current) {
      fetchPendingApps()
      fetchNotifs()
      refreshUnread(user.user_id)
    }
    wasShown.current = true
  }, [visible, isLoggedIn, user, fetchPendingApps, fetchNotifs, refreshUnread])

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
      <EmptyState title={t('workshop.loginRequired')} />
    )
  }

  return (
    <div className={styles.root}>
      {/* Section 1: Pending applications（panel='notifs' 时隐藏） */}
      {panel !== 'notifs' && (
        <div className={styles.panel}>
          <div className={styles.sectionHeader}>
            <Text className={styles.sectionTitle}>{t('workshop.pendingApps')}</Text>
          </div>
          <div className={styles.content}>
            {loadingApps && (
              <EmptyState>
                <Spinner size="small" />
              </EmptyState>
            )}

            {!loadingApps && apps.length === 0 && (
              <EmptyState description={t('workshop.noPendingApps')} />
            )}

            {!loadingApps && apps.map((app) => (
              <Card key={app.id} className={styles.card}>
                <div className={styles.cardContent}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span className={styles.scopeBadge}>{SCOPE_LABELS[app.scope] || app.scope}</span>
                    {app.target_lang && <Badge appearance="outline" size="small">{app.target_lang}</Badge>}
                  </div>
                  <Text weight="semibold" size="small">{app.mod_key || app.mod_name}</Text>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Text size="small" className={styles.metaText}>{t('workshop.applicant')}:</Text>
                    <UserLink
                      userId={app.applicant_id}
                      username={app.applicant_name}
                      avatar={app.applicant_avatar}
                      size={16}
                      nameSize={100}
                    />
                  </div>
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

            <Pagination page={appPage} totalPages={totalAppPages} onChange={(p) => setAppPage(p)} />
          </div>
        </div>
      )}

      {/* Section 2: 评论/回复/点赞通知（panel='apps' 时隐藏） */}
      {panel !== 'apps' && (
        <div className={styles.panel}>
          <div className={styles.sectionHeader}>
            <Text className={styles.sectionTitle}>{t('workshop.notifications')}</Text>
            <Button size="small" appearance="outline" icon={<ArrowUndo24Regular />} onClick={handleMarkAllRead}>
              {t('workshop.markAllRead')}
            </Button>
          </div>
          <div className={styles.content}>
            {loadingNotifs && (
              <EmptyState>
                <Spinner size="small" />
              </EmptyState>
            )}

            {!loadingNotifs && notifs.length === 0 && (
              <EmptyState description={t('workshop.noNotifications')} />
            )}

            {!loadingNotifs && notifs.map((n) => (
              <Card key={`${n.entity}-${n.id}`} className={styles.card} onClick={async () => {
                if (!n.is_read) {
                  try {
                    // 携带 entity：两张通知表各自 AUTO_INCREMENT，相同数字 id 可能分属不同表，
                    // 后端按 entity 只更新对应表，避免跨表误标已读
                    await markRead({ user_id: user.user_id, target_type: 'notification', entity: n.entity || 'mod', ids: [n.id] })
                    setNotifs(prev => prev.map(item => `${item.entity || 'mod'}-${item.id}` === `${n.entity || 'mod'}-${n.id}` ? { ...item, is_read: true } : item))
                    refreshUnread(user.user_id)
                  } catch (e) { console.error('markRead failed', e) }
                }
                // mod 通知走原有详情跳转；讨论区通知跳转到讨论详情对应楼层
                onNavigate?.(n.entity || 'mod', n.target_id, n.comment_id)
              }}>
                <div className={styles.cardContent}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <Badge appearance="outline" size="small">
                      {n.type === 'new_like' ? t('workshop.notifLike') : n.type === 'new_comment' ? t('workshop.notifComment') : t('workshop.notifReply')}
                    </Badge>
                    {n.entity === 'discussion' && (
                      <Badge appearance="outline" size="small" color="brand">
                        {t('nav.discuss')}
                      </Badge>
                    )}
                    {!n.is_read && (
                      <Badge appearance="filled" size="small" color="brand">
                        未读
                      </Badge>
                    )}
                  </div>
                  <Text weight="semibold" size="small">{n.display_key || n.mod_key || n.mod_name}</Text>
                  {n.type === 'new_like' ? (
                    <Text size="small" className={styles.metaText}>
                      {t('workshop.notifLikeHint')}
                    </Text>
                  ) : (
                    <Text size="small" className={styles.truncate} title={n.content}>
                      {truncateText(n.content)}
                    </Text>
                  )}
                  {n.author_name ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                      <UserLink
                        userId={n.author_id}
                        username={n.author_name}
                        avatar={n.author_avatar}
                        size={14}
                        nameSize={100}
                      />
                      <Text size="small" className={styles.metaText}>· {n.created_at}</Text>
                    </div>
                  ) : n.created_at && (
                    <Text size="small" className={styles.metaText}>{n.created_at}</Text>
                  )}
                </div>
              </Card>
            ))}

            <Pagination page={notifPage} totalPages={totalNotifPages} onChange={(p) => setNotifPage(p)} />
          </div>
        </div>
      )}
    </div>
  )
}
