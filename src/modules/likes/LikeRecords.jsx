import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, Text, Button,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular, Heart24Regular,
  Add20Regular, Subtract20Regular,
} from '@fluentui/react-icons'
import { listLikedMods, getModDetail, getDeviceId } from '../../services/workshopApi'
import {
  loadLikedModsFromCache, saveLikedModsToCache,
} from '../../services/likedModsCache'
import { getConfig, setConfig } from '../../services/dbHelper'
import { useAuth } from '../../contexts/useAuth'
import ModDetailPage from '../workshop/ModDetailPage'
import { ModCard } from '../workshop/ModCard'
import { AsyncView, LoginForm, EmptyState } from '../../components'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  list: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '12px',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
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

export function LikeRecords() {
  const styles = useStyles()
  const { t } = useTranslation()
  const { isLoggedIn } = useAuth()
  const deviceIdRef = useRef(getDeviceId())
  const [mods, setMods] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailMod, setDetailMod] = useState(null)
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

  const handleItemsPerRowChange = useCallback((delta) => {
    setItemsPerRow(prev => {
      const next = Math.min(10, Math.max(1, prev + delta))
      saveItemsPerRow(next)
      return next
    })
  }, [saveItemsPerRow])

  // 查远程库并回写 SQLite 缓存
  const refreshFromRemote = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listLikedMods({ device_id: deviceIdRef.current, lang: 'zh' })
      const list = data.mods || []
      setMods(list)
      await saveLikedModsToCache(list)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 打开标签页默认只读 SQLite 缓存，避免每次查远程库
  useEffect(() => {
    if (!isLoggedIn || initialFetch.current) return
    initialFetch.current = true
    ;(async () => {
      const cached = await loadLikedModsFromCache()
      setMods(cached)
      // 缓存为空时（首次使用）查一次库填充
      if (cached.length === 0) {
        refreshFromRemote()
      }
    })()
  }, [isLoggedIn, refreshFromRemote])

  // 点进详情直接查库，获取最新信息（不写缓存）
  const handleDetail = async (mod) => {
    try {
      const res = await getModDetail(mod.id, 'zh', null, deviceIdRef.current)
      setDetailMod(res.data?.mod || mod)
    } catch {
      setDetailMod(mod)
    }
  }

  // 返回列表：重新读缓存（详情中取消点赞等变更通过查库同步）
  const handleBack = async () => {
    setDetailMod(null)
    await refreshFromRemote()
  }

  if (!isLoggedIn) {
    return <LoginPage />
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
      <div className={styles.toolbarRow}>
        <Text size="small" className={styles.meta} style={{ flex: 1 }}>
          {t('likes.count', { count: mods.length })}
        </Text>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Text size="small">{t('workshop.itemsPerRow')}</Text>
          <Button
            size="small"
            icon={<Subtract20Regular />}
            appearance="subtle"
            onClick={() => handleItemsPerRowChange(-1)}
            disabled={itemsPerRow <= 1 || loading}
          />
          <Text size="small" style={{ minWidth: '20px', textAlign: 'center' }}>{itemsPerRow}</Text>
          <Button
            size="small"
            icon={<Add20Regular />}
            appearance="subtle"
            onClick={() => handleItemsPerRowChange(1)}
            disabled={itemsPerRow >= 10 || loading}
          />
        </div>
        <Button size="small" icon={<ArrowClockwise24Regular />} onClick={refreshFromRemote} disabled={loading}>
          {t('workshop.refresh')}
        </Button>
      </div>

      <AsyncView loading={loading} error={error} onRetry={refreshFromRemote} loadingLabel={t('workshop.loading')}>
        {mods.length === 0 ? (
          <EmptyState
            icon={<Heart24Regular style={{ fontSize: '32px' }} />}
            title={t('likes.empty')}
            description={t('likes.emptyHint')}
          />
        ) : (
        <div className={styles.list} style={{ gridTemplateColumns: `repeat(${itemsPerRow}, 1fr)` }}>
          {mods.map(mod => (
            <ModCard key={mod.id} mod={mod} onClick={() => handleDetail(mod)} />
          ))}
        </div>
        )}
      </AsyncView>
    </div>
  )
}

export default LikeRecords
