import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Spinner, Card, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowUndo24Regular, Checkmark24Regular, Delete24Regular, ArrowClockwise24Regular,
} from '@fluentui/react-icons'
import { useAuth } from '../../contexts/useAuth'
import { useNotification } from '../../contexts/NotificationContext'
import { listApplications, handleApplication, getMyNotifications, markRead } from '../../services/workshopApi'
import { Pagination, EmptyState, UserLink, OfflineCacheNotice, FloatingActions } from '../../components'
import { extractFirstImage } from '../../utils/extractFirstImage'
import {
  loadNotificationsFromCache,
  saveNotificationsToCache,
  reconcileNotificationsCache,
  markNotificationsReadInCache,
} from '../../services/notifCache'

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
    position: 'relative',
    padding: '12px',
    marginBottom: '8px',
    cursor: 'pointer',
    transition: 'box-shadow 0.2s ease',
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  unreadDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: tokens.colorBrandBackground,
    flexShrink: 0,
  },
  notifBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
  },
  notifHead: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, max-content) minmax(0, 1fr)',
    columnGap: '8px',
    rowGap: '2px',
    alignItems: 'center',
    minWidth: 0,
  },
  notifAvatar: {
    gridColumn: 1,
    gridRow: 'span 2',
  },
  notifNameCol: {
    gridColumn: 2,
    minWidth: 0,
  },
  notifNameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  notifMsg: {
    gridColumn: 3,
    gridRow: '1 / span 2',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flex: 1,
    minWidth: 0,
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
  thumb: {
    maxWidth: '33.33%',
    maxHeight: '140px',
    objectFit: 'cover',
    borderRadius: '6px',
    display: 'block',
    backgroundColor: tokens.colorNeutralBackground1Hover,
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
  // 回退展示本地缓存时的标注（缓存时间 ms，null 表示当前是网络实时数据）
  const [notifOfflineAt, setNotifOfflineAt] = useState(null)

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
      setNotifOfflineAt(null)
      // 成功后回写本地 SQLite 缓存，供远程库连接打满/断连时回退展示：
      // 第 1 页做调和（第 1 页为空 → 清缓存；否则剔除窗口内已被服务端删除的通知），
      // 其余页按页 upsert 合并，不清旧数据避免翻页丢页
      if (notifPage === 1) {
        await reconcileNotificationsCache(user.user_id, res.items || [])
      } else {
        await saveNotificationsToCache(user.user_id, res.items || [])
      }
    } catch (e) {
      console.error('getMyNotifications failed', e)
      // 网络失败时回退展示本地缓存的历史通知（与创意工坊缓存优先策略一致）
      const { items, cachedAt } = await loadNotificationsFromCache(user.user_id)
      if (items.length > 0) {
        setNotifs(items)
        setTotalNotifs(items.length)
        setNotifOfflineAt(cachedAt)
        // 回退展示全部缓存历史，页码重置到第 1 页，保持分页控件与内容一致
        setNotifPage(1)
      } else {
        setNotifs([])
        setNotifOfflineAt(null)
      }
    } finally {
      setLoadingNotifs(false)
    }
  }, [user, notifPage])

  // 挂载即拉取（预加载设计），但按 panel 裁剪：apps 面板不需要通知查询，notifs 面板不需要申请查询，
  // 避免当前面板 + 预加载面板同时把无用查询挤进唯一数据库连接排队
  useEffect(() => {
    if (isLoggedIn && user && panel !== 'notifs') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchPendingApps()
    }
  }, [isLoggedIn, user, panel, fetchPendingApps])

  useEffect(() => {
    if (isLoggedIn && user && panel !== 'apps') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchNotifs()
    }
  }, [isLoggedIn, user, panel, fetchNotifs])

  // 未读计数只需当前可见面板刷新（预加载面板不可见，避免重复查询）
  useEffect(() => {
    if (visible && isLoggedIn && user) {
      refreshUnread(user.user_id)
    }
  }, [visible, isLoggedIn, user, refreshUnread])

  // 常驻挂载下，从隐藏回到可见（再次进入该 tab）时重新拉取，避免列表/未读状态过期；
  // 首次展示（预加载目标）不重复拉取，直接呈现预加载结果
  const wasShown = useRef(false)
  useEffect(() => {
    if (!visible || !isLoggedIn || !user) return
    if (wasShown.current) {
      // 有意行为：回到可见 tab 时按 panel 刷新对应数据；与挂载 effect 同规则豁免
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (panel !== 'notifs') fetchPendingApps()
      if (panel !== 'apps') fetchNotifs()
      refreshUnread(user.user_id)
    }
    wasShown.current = true
  }, [visible, isLoggedIn, user, panel, fetchPendingApps, fetchNotifs, refreshUnread])

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
      // 已读状态同步回写本地缓存（entity/ids 传空 = 缓存中该用户全部通知）
      markNotificationsReadInCache(user.user_id, null, null)
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
          {notifOfflineAt != null && <OfflineCacheNotice cachedAt={notifOfflineAt} />}
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

            {!loadingNotifs && notifs.map((n) => {
              const { image, text } = extractFirstImage(n.content)
              const typeLabel = n.type === 'new_like'
                ? t('workshop.notifLike')
                : n.type === 'new_comment'
                  ? t('workshop.notifComment')
                  : t('workshop.notifReply')
              const targetName = n.display_key || n.mod_key || n.mod_name || ''
              // 目标串按实体类型带前缀：mod 通知显示「mod - 名字」，讨论通知显示「讨论 - 标题」
              const commentTarget = n.entity === 'discussion'
                ? t('workshop.notifTargetDiscussion', { title: targetName })
                : t('workshop.notifTargetMod', { name: targetName })
              // 收件人身份（后端按行计算）：作者 / 协作者（申请编辑通过）/ 层主（被回复楼层作者）。
              // 身份可能重叠（如作者兼层主），按「层主 > 协作者 > 作者」的展示精度取优先级
              const isAuthor = !!n.is_author
              const isCollab = !!n.is_collab && !isAuthor
              const msg = n.type === 'new_like'
                ? isCollab
                  ? t('workshop.notifLikeCollabHint', { target: targetName })
                  : t('workshop.notifLikeHint', { target: targetName })
                : n.type === 'new_reply'
                  ? n.is_parent_author
                    ? t('workshop.notifReplyParentMsg', { target: commentTarget })
                    : isCollab
                      ? t('workshop.notifReplyCollabMsg', { target: commentTarget })
                      : t('workshop.notifReplyMsg', { target: commentTarget })
                  : isCollab
                    ? t('workshop.notifCommentCollabMsg', { target: commentTarget })
                    : t('workshop.notifCommentMsg', { target: commentTarget })
              return (
              <Card key={`${n.entity}-${n.id}`} className={styles.card} onClick={async () => {
                if (!n.is_read) {
                  try {
                    // 携带 entity：两张通知表各自 AUTO_INCREMENT，相同数字 id 可能分属不同表，
                    // 后端按 entity 只更新对应表，避免跨表误标已读
                    await markRead({ user_id: user.user_id, target_type: 'notification', entity: n.entity || 'mod', ids: [n.id] })
                    setNotifs(prev => prev.map(item => `${item.entity || 'mod'}-${item.id}` === `${n.entity || 'mod'}-${n.id}` ? { ...item, is_read: true } : item))
                    // 已读状态同步回写本地缓存，避免回退展示时误报未读
                    markNotificationsReadInCache(user.user_id, n.entity || 'mod', [n.id])
                    refreshUnread(user.user_id)
                  } catch (e) { console.error('markRead failed', e) }
                }
                // mod 通知走原有详情跳转；讨论区通知跳转到讨论详情对应楼层
                onNavigate?.(n.entity || 'mod', n.target_id, n.comment_id)
              }}>
                <div className={styles.notifBody}>
                  {n.author_name ? (
                    <div className={styles.notifHead}>
                      {/* 三栏：头像占两行 | 名字+标签 / 时间 | 右侧淡色消息文字 */}
                      <UserLink
                        userId={n.author_id}
                        username={n.author_name}
                        avatar={n.author_avatar}
                        size={32}
                        showName={false}
                        className={styles.notifAvatar}
                      />
                      <div className={styles.notifNameCol}>
                        <div className={styles.notifNameRow}>
                          <UserLink
                            userId={n.author_id}
                            username={n.author_name}
                            avatar={n.author_avatar}
                            hideAvatar
                            nameBold
                          />
                          <Badge appearance="tint" size="small" color="brand">
                            {typeLabel}
                          </Badge>
                          {!n.is_read && <span className={styles.unreadDot} aria-hidden="true" />}
                        </div>
                        <Text size={100} className={styles.metaText}>
                          {n.created_at}
                        </Text>
                      </div>
                      <Text
                        size="small"
                        className={styles.notifMsg}
                        style={{ color: tokens.colorNeutralForeground4 }}
                        title={msg}
                      >
                        {msg}
                      </Text>
                    </div>
                  ) : (
                    <div className={styles.notifNameRow}>
                      <Badge appearance="tint" size="small" color="brand">
                        {typeLabel}
                      </Badge>
                      {!n.is_read && <span className={styles.unreadDot} aria-hidden="true" />}
                      {n.created_at && <Text size={100} className={styles.metaText}>{n.created_at}</Text>}
                      <Text
                        size="small"
                        className={styles.notifMsg}
                        style={{ color: tokens.colorNeutralForeground4, flex: 1 }}
                        title={msg}
                      >
                        {msg}
                      </Text>
                    </div>
                  )}
                  {n.type !== 'new_like' && (
                    <>
                      {image && <img src={image} alt="" className={styles.thumb} loading="lazy" />}
                      {text && (
                        <Text size="small" className={styles.truncate} title={text}>
                          {truncateText(text)}
                        </Text>
                      )}
                    </>
                  )}
                </div>
              </Card>
              )
            })}

            <Pagination page={notifPage} totalPages={totalNotifPages} onChange={(p) => setNotifPage(p)} />
          </div>

          {/* 与创意工坊一致：右下角悬浮刷新 + 数据库信号灯；网络失败回退缓存时弹「本地缓存」提示 */}
          <FloatingActions
            items={[
              {
                key: 'refresh',
                icon: <ArrowClockwise24Regular />,
                onClick: fetchNotifs,
                disabled: loadingNotifs,
                label: t('workshop.refresh'),
              },
            ]}
          />
        </div>
      )}
    </div>
  )
}
