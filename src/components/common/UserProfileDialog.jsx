import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  makeStyles,
  tokens,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogTrigger,
  Button,
  Text,
  Avatar,
  Badge,
  Spinner,
} from '@fluentui/react-components'
import {
  ArrowDownload16Regular,
  Heart16Regular,
  Edit16Regular,
} from '@fluentui/react-icons'
import { useAuth } from '../../contexts/useAuth'
import { getUserPublicProfile, listMyMods } from '../../services/workshopApi'
import { getAvatarUrl } from '../../utils/avatars'
import { ProfileDialog } from './ProfileDialog'

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    marginBottom: '12px',
  },
  headerInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
  },
  statsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flexWrap: 'wrap',
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    minWidth: '64px',
  },
  statValue: {
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  statLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  divider: {
    height: '1px',
    backgroundColor: tokens.colorNeutralStroke2,
    margin: '12px 0',
  },
  sectionTitle: {
    fontSize: '12px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
    marginBottom: '8px',
    display: 'block',
  },
  modList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxHeight: '260px',
    overflowY: 'auto',
  },
  modItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '4px',
    padding: '10px 12px',
    border: 'none',
    width: '100%',
    textAlign: 'left',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background-color 0.15s ease',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground2Hover,
    },
  },
  modItemTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  modName: {
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: tokens.colorNeutralForeground1,
  },
  modKey: {
    fontFamily: 'monospace',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  modDesc: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    fontSize: '12px',
    lineHeight: '18px',
    color: tokens.colorNeutralForeground2,
  },
  modTag: {
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  modItemStats: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    marginTop: '2px',
  },
  modStat: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    flexShrink: 0,
  },
  loadingBox: {
    display: 'flex',
    justifyContent: 'center',
    padding: '24px 0',
  },
  emptyText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    padding: '12px 0',
    textAlign: 'center',
    display: 'block',
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: '12px',
  },
})

/**
 * 用户个人资料弹窗：展示任意用户的公开资料 + 统计 + TA 发布的 MOD 列表。
 * 若查看的是当前登录用户本人，提供「编辑资料」入口（复用 ProfileDialog）。
 *
 * 由 UserNavProvider 统一挂载，业务组件无需直接使用。
 *
 * @param {boolean} open
 * @param {{userId, username, avatar}|null} target - 点击时携带的基础信息（先展示，接口数据到达后覆盖）
 * @param {function} onClose
 * @param {function} onOpenMod - 可选，点击 MOD 项时跳转 (modId) => void
 */
export function UserProfileDialog({ open, target, onClose, onOpenMod }) {
  const styles = useStyles()
  const { t, i18n } = useTranslation()
  const { user } = useAuth()

  const [profile, setProfile] = useState(null)
  const [mods, setMods] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editOpen, setEditOpen] = useState(false)

  const userId = target?.userId
  const isSelf = !!user && !!userId && Number(user.user_id) === Number(userId)

  useEffect(() => {
    if (!open || !userId) return
    let cancelled = false
    setLoading(true)
    setError('')
    setProfile(null)
    setMods([])
    ;(async () => {
      try {
        const [p, m] = await Promise.all([
          getUserPublicProfile(userId),
          listMyMods({ author_id: Number(userId), lang: i18n.language, page: 1, page_size: 50 }),
        ])
        if (cancelled) return
        setProfile(p)
        setMods(m.mods || [])
      } catch (e) {
        if (!cancelled) setError(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, userId])

  if (!target) return null

  // 接口数据优先，点击携带的信息兜底（弹窗秒开不留白）
  const username = profile?.username || target.username || ''
  const avatar = profile?.avatar ?? target.avatar
  const avatarUrl = getAvatarUrl(avatar)

  const handleModClick = (modId) => {
    onClose?.()
    onOpenMod?.(modId)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose?.() }}>
        <DialogSurface style={{ maxWidth: '600px' }}>
          <DialogBody>
            <DialogTitle>{t('userProfile.title')}</DialogTitle>
            <DialogContent>
              {/* 头部：头像 + 用户名 */}
              <div className={styles.header}>
                {avatarUrl ? (
                  <img src={avatarUrl} alt={username} style={{ width: '56px', height: '56px' }} />
                ) : (
                  <Avatar name={username || '?'} size={56} color="brand" />
                )}
                <div className={styles.headerInfo}>
                  <Text size={500} weight="semibold" truncate wrap={false}>{username}</Text>
                  {isSelf && (
                    <Badge appearance="tint" color="brand" size="small">
                      {t('userProfile.itsYou')}
                    </Badge>
                  )}
                </div>
              </div>

              {error && <Text className={styles.errorText}>{error}</Text>}

              {/* 统计 */}
              <div className={styles.statsRow}>
                <div className={styles.statItem}>
                  <span className={styles.statValue}>{profile ? profile.mod_count : '–'}</span>
                  <span className={styles.statLabel}>{t('userProfile.modCount')}</span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statValue}>{profile ? profile.total_downloads : '–'}</span>
                  <span className={styles.statLabel}>{t('userProfile.totalDownloads')}</span>
                </div>
                <div className={styles.statItem}>
                  <span className={styles.statValue}>{profile ? profile.total_likes : '–'}</span>
                  <span className={styles.statLabel}>{t('userProfile.totalLikes')}</span>
                </div>
              </div>

              <div className={styles.divider} />

              {/* TA 发布的 MOD */}
              <Text className={styles.sectionTitle}>
                {isSelf ? t('userProfile.myMods') : t('userProfile.userMods')}
              </Text>
              {loading ? (
                <div className={styles.loadingBox}><Spinner size="small" /></div>
              ) : mods.length === 0 ? (
                <Text className={styles.emptyText}>{t('userProfile.noMods')}</Text>
              ) : (
                <div className={styles.modList}>
                  {mods.map((mod) => (
                    <button
                      key={mod.id}
                      type="button"
                      className={styles.modItem}
                      onClick={() => handleModClick(mod.id)}
                      title={`${mod.display_name} (${mod.mod_key})`}
                    >
                      <div className={styles.modItemTop}>
                        <Text size={300} weight="semibold" className={styles.modName}>{mod.display_name}</Text>
                        <Badge appearance="outline" size="small" className={styles.modTag}>
                          {mod.category
                            ? t(`workshop.category_${mod.category}`, mod.category)
                            : t('workshop.uncategorized')}
                        </Badge>
                      </div>
                      <Text size={100} className={styles.modKey}>{mod.mod_key}</Text>
                      {mod.description && (
                        <Text size={200} className={styles.modDesc}>{mod.description}</Text>
                      )}
                      <div className={styles.modItemStats}>
                        <span className={styles.modStat}>
                          <ArrowDownload16Regular /> {mod.download_count ?? 0}
                        </span>
                        <span className={styles.modStat}>
                          <Heart16Regular /> {mod.like_count ?? 0}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              {isSelf && (
                <Button
                  size="small"
                  appearance="secondary"
                  icon={<Edit16Regular />}
                  onClick={() => setEditOpen(true)}
                >
                  {t('userProfile.editProfile')}
                </Button>
              )}
              <DialogTrigger disableButtonEnhancement>
                <Button size="small" appearance="subtle">{t('userProfile.close')}</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* 本人 → 编辑资料（复用现有 ProfileDialog） */}
      {isSelf && (
        <ProfileDialog open={editOpen} onClose={() => setEditOpen(false)} />
      )}
    </>
  )
}
