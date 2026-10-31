import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, Text, Button,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular, Heart24Regular,
  Star24Regular,
} from '@fluentui/react-icons'
import { listLikedMods, listRatedMods, listLikedDiscussions, getModDetail, getDiscussionDetail, getDeviceId } from '../../services/workshopApi'
import {
  loadLikedModsFromCache, saveLikedModsToCache,
} from '../../services/likedModsCache'
import {
  loadRatedModsFromCache, saveRatedModsToCache,
} from '../../services/ratingCache'
import { getConfig, setConfig } from '../../services/dbHelper'
import { useAuth } from '../../contexts/useAuth'
import ModDetailPage from '../workshop/ModDetailPage'
import { ModCard } from '../workshop/ModCard'
import { DiscussionCard } from '../workshop/DiscussionCard'
import DiscussionDetailPage from '../workshop/DiscussionDetailPage'
import { AsyncView, LoginForm, EmptyState, ItemsPerRowControl } from '../../components'

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
    alignItems: 'center',
    gap: '6px',
    marginBottom: '8px',
    flexWrap: 'wrap',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
  },
  list: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '12px',
  },
  loginCard: {
    padding: '24px',
    maxWidth: '360px',
    margin: '0 auto',
    marginTop: '24px',
  },
  loginTitle: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '12px',
  },
})

function LoginPage() {
  const styles = useStyles()
  const { t } = useTranslation()

  return (
    <Card className={styles.loginCard}>
      <div className={styles.loginTitle}>
        <Text weight="semibold">{t('workshop.login')}</Text>
        <Text size="small" className={styles.meta} block>
          {t('likes.loginHint')}
        </Text>
      </div>
      <LoginForm />
    </Card>
  )
}

export function LikeRecords({ panel, visible = true }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { isLoggedIn, user } = useAuth()
  const deviceIdRef = useRef(getDeviceId())
  const [likedMods, setLikedMods] = useState([])
  const [ratedMods, setRatedMods] = useState([])
  const [likedDiscussions, setLikedDiscussions] = useState([])
  const [likedLoading, setLikedLoading] = useState(false)
  const [ratedLoading, setRatedLoading] = useState(false)
  const [likedDiscussionsLoading, setLikedDiscussionsLoading] = useState(false)
  const [likedError, setLikedError] = useState('')
  const [ratedError, setRatedError] = useState('')
  const [likedDiscussionsError, setLikedDiscussionsError] = useState('')
  const [detailMod, setDetailMod] = useState(null)
  const [detailDiscussion, setDetailDiscussion] = useState(null)
  const [detailPanel, setDetailPanel] = useState('liked')
  const [itemsPerRow, setItemsPerRow] = useState(3)
  const initialFetch = useRef(false)

  // 每行展示数量：持久化到 config（与创意工坊一致的交互）
  useEffect(() => {
    const loadItemsPerRow = async () => {
      try {
        const value = await getConfig('liked_items_per_row')
        if (value !== null) {
          const parsed = parseInt(value, 10)
          if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 10) {
            setItemsPerRow(parsed)
          }
        }
      } catch (e) {
        console.warn('[LikeRecords] 读取每行展示数量失败:', e)
      }
    }
    loadItemsPerRow()
  }, [])

  const saveItemsPerRow = useCallback(async (value) => {
    try {
      await setConfig('liked_items_per_row', String(value))
    } catch (e) {
      console.warn('[LikeRecords] 保存每行展示数量失败:', e)
    }
  }, [])

  const handleItemsPerRowChange = useCallback((next) => {
    setItemsPerRow(next)
    saveItemsPerRow(next)
  }, [saveItemsPerRow])

  // 查远程库并回写 SQLite 缓存（点赞栏）
  const refreshLiked = useCallback(async () => {
    setLikedLoading(true)
    setLikedError('')
    try {
      const data = await listLikedMods({ device_id: deviceIdRef.current, lang: 'zh' })
      const list = data.mods || []
      setLikedMods(list)
      await saveLikedModsToCache(list)
    } catch (e) {
      setLikedError(e.message)
    } finally {
      setLikedLoading(false)
    }
  }, [])

  // 查远程库并回写 SQLite 缓存（评分栏，按用户维度）
  const refreshRated = useCallback(async () => {
    if (!user) return
    setRatedLoading(true)
    setRatedError('')
    try {
      const data = await listRatedMods({ user_id: user.user_id, lang: 'zh' })
      const list = data.mods || []
      setRatedMods(list)
      await saveRatedModsToCache(list, user.user_id)
    } catch (e) {
      setRatedError(e.message)
    } finally {
      setRatedLoading(false)
    }
  }, [user])

  // 查远程库（点赞讨论帖右栏；讨论点赞无本地缓存）
  const refreshLikedDiscussions = useCallback(async () => {
    if (!user) return
    setLikedDiscussionsLoading(true)
    setLikedDiscussionsError('')
    try {
      const data = await listLikedDiscussions({ user_id: user.user_id })
      setLikedDiscussions(data.discussions || [])
    } catch (e) {
      setLikedDiscussionsError(e.message)
    } finally {
      setLikedDiscussionsLoading(false)
    }
  }, [user])

  // 读 SQLite 缓存（缓存为空时查一次远程库填充）
  const reloadFromCache = useCallback(async () => {
    const [likedCached, ratedCached] = await Promise.all([
      loadLikedModsFromCache(),
      loadRatedModsFromCache(user?.user_id),
    ])
    setLikedMods(likedCached)
    setRatedMods(ratedCached)
    // 缓存为空时（首次使用）查一次库填充；隐藏的 panel 不查远程库，
    // 避免单栏模式下无用查询（panel='liked' 时评分栏隐藏，panel='rated' 时点赞栏隐藏）
    if (panel !== 'rated' && likedCached.length === 0) refreshLiked()
    if (panel !== 'liked' && ratedCached.length === 0) refreshRated()
  }, [panel, refreshLiked, refreshRated, user?.user_id])

  // 首次挂载：只读 SQLite 缓存，避免每次查远程库
  useEffect(() => {
    if (!isLoggedIn || initialFetch.current) return
    initialFetch.current = true
    reloadFromCache()
  }, [isLoggedIn, reloadFromCache])

  // 常驻挂载下，从隐藏回到可见（再次进入该 tab）时重读缓存，保持与旧版重挂载一致的新鲜度；
  // 首次展示（预加载目标）不重复拉取，直接呈现预加载结果。
  // 讨论区点赞没有本地缓存：仅在本 tab 真正可见时拉远程，避免预加载阶段多打一次库。
  const wasShown = useRef(false)
  useEffect(() => {
    if (!visible || !isLoggedIn) return
    if (wasShown.current) {
      reloadFromCache()
    }
    wasShown.current = true
    // 放进微任务：refreshLikedDiscussions 会同步 setLoading，避免在 effect 体内直接触发级联渲染
    if (panel !== 'rated') Promise.resolve().then(refreshLikedDiscussions)
  }, [visible, isLoggedIn, panel, reloadFromCache, refreshLikedDiscussions])

  // 点进详情直接查库，获取最新信息（不写缓存）
  const handleDetail = async (mod, panel) => {
    try {
      const res = await getModDetail(mod.id, 'zh', user?.user_id ?? null, deviceIdRef.current)
      setDetailMod(res.data?.mod || mod)
    } catch {
      setDetailMod(mod)
    }
    setDetailPanel(panel)
  }

  // 点进讨论详情：强制走网络拿最新数据（编辑/点赞后不展示旧缓存）
  const handleDiscussionDetail = async (d) => {
    try {
      const res = await getDiscussionDetail(d.id, user?.user_id, { force: true })
      setDetailDiscussion(res.data || d)
    } catch {
      setDetailDiscussion(d)
    }
  }

  const handleDiscussionBack = async () => {
    setDetailDiscussion(null)
    await refreshLikedDiscussions()
  }

  // 返回列表：重新读缓存（详情中取消点赞/撤评等变更通过查库同步）
  const handleBack = async () => {
    setDetailMod(null)
    if (detailPanel === 'liked') {
      await refreshLiked()
    } else {
      await refreshRated()
    }
  }

  if (!isLoggedIn) {
    return <LoginPage />
  }

  if (detailDiscussion) {
    return (
      <DiscussionDetailPage
        key={detailDiscussion.id}
        discussion={detailDiscussion}
        onBack={handleDiscussionBack}
        onUpdated={setDetailDiscussion}
      />
    )
  }

  if (detailMod) {
    return (
      <ModDetailPage
        key={detailMod.id}
        mod={detailMod}
        onBack={handleBack}
      />
    )
  }

  return (
    <div className={styles.root}>
      {/* 左栏：点赞的模组（panel='rated' 单栏评分时隐藏） */}
      {panel !== 'rated' && (
        <div className={styles.panel}>
          <div className={styles.sectionHeader}>
            <Text size="small" weight="semibold">{t('likes.likedTitle')}</Text>
            <Text size="small" className={styles.meta} style={{ flex: 1 }}>
              {t('likes.count', { count: likedMods.length })}
            </Text>
            <Button size="small" icon={<ArrowClockwise24Regular />} onClick={refreshLiked} disabled={likedLoading}>
              {t('workshop.refresh')}
            </Button>
          </div>
          <div className={styles.content}>
            <AsyncView loading={likedLoading} error={likedError} onRetry={refreshLiked} loadingLabel={t('workshop.loading')}>
              {likedMods.length === 0 ? (
                <EmptyState
                  icon={<Heart24Regular style={{ fontSize: '32px' }} />}
                  title={t('likes.empty')}
                  description={t('likes.emptyHint')}
                />
              ) : (
                // 点赞 tab 为左右两栏，按固定最小卡宽自适应列数，避免半宽面板挤成窄条
                <div className={styles.list}>
                  {likedMods.map(mod => (
                    <ModCard key={mod.id} mod={mod} onClick={() => handleDetail(mod, 'liked')} />
                  ))}
                </div>
              )}
            </AsyncView>
          </div>
        </div>
      )}

      {/* 右栏：点赞的讨论帖（仅点赞 tab 展示，与左栏模组点赞分栏记录） */}
      {panel !== 'rated' && (
        <div className={styles.panel}>
          <div className={styles.sectionHeader}>
            <Text size="small" weight="semibold">{t('likes.likedDiscussionsTitle')}</Text>
            <Text size="small" className={styles.meta} style={{ flex: 1 }}>
              {t('likes.likedDiscussionsCount', { count: likedDiscussions.length })}
            </Text>
            <Button size="small" icon={<ArrowClockwise24Regular />} onClick={refreshLikedDiscussions} disabled={likedDiscussionsLoading}>
              {t('workshop.refresh')}
            </Button>
          </div>
          <div className={styles.content}>
            <AsyncView loading={likedDiscussionsLoading} error={likedDiscussionsError} onRetry={refreshLikedDiscussions} loadingLabel={t('workshop.loading')}>
              {likedDiscussions.length === 0 ? (
                <EmptyState
                  icon={<Heart24Regular style={{ fontSize: '32px' }} />}
                  title={t('likes.likedDiscussionsEmpty')}
                  description={t('likes.likedDiscussionsEmptyHint')}
                />
              ) : (
                <div className={styles.list}>
                  {likedDiscussions.map(d => (
                    <DiscussionCard key={d.id} discussion={d} onClick={() => handleDiscussionDetail(d)} />
                  ))}
                </div>
              )}
            </AsyncView>
          </div>
        </div>
      )}

      {/* 评分栏：仅评分 tab 展示（panel='liked' 单栏点赞时隐藏） */}
      {panel !== 'liked' && (
        <div className={styles.panel}>
          <div className={styles.sectionHeader}>
            <Text size="small" weight="semibold">{t('likes.ratedTitle')}</Text>
            <Text size="small" className={styles.meta} style={{ flex: 1 }}>
              {t('likes.ratedCount', { count: ratedMods.length })}
            </Text>
            <ItemsPerRowControl value={itemsPerRow} onChange={handleItemsPerRowChange} disabled={likedLoading || ratedLoading} />
            <Button size="small" icon={<ArrowClockwise24Regular />} onClick={refreshRated} disabled={ratedLoading}>
              {t('workshop.refresh')}
            </Button>
          </div>
          <div className={styles.content}>
            <AsyncView loading={ratedLoading} error={ratedError} onRetry={refreshRated} loadingLabel={t('workshop.loading')}>
              {ratedMods.length === 0 ? (
                <EmptyState
                  icon={<Star24Regular style={{ fontSize: '32px' }} />}
                  title={t('likes.ratedEmpty')}
                  description={t('likes.ratedEmptyHint')}
                />
              ) : (
                <div className={styles.list} style={{ gridTemplateColumns: `repeat(${itemsPerRow}, 1fr)` }}>
                  {ratedMods.map(mod => (
                    <ModCard key={mod.id} mod={mod} onClick={() => handleDetail(mod, 'rated')} />
                  ))}
                </div>
              )}
            </AsyncView>
          </div>
        </div>
      )}
    </div>
  )
}

export default LikeRecords
