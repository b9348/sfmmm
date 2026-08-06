import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, Text, Button, SearchBox,
  Spinner, makeStyles,
  Select,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  Search24Regular,
  Add24Regular,
  Add20Regular,
  Subtract20Regular,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { listMods, getModDetail, getModForEdit, getDeviceId } from '../../services/workshopApi'
import ModDetailPage from './ModDetailPage'
import { useAuth } from '../../contexts/useAuth'
import { EditModPage, CreateModPage } from './MyMods'
import { getConfig, setConfig } from '../../services/dbHelper'
import { Pagination, AsyncView, LoginDialog, FloatingActions, EmptyState } from '../../components'
import { ModCard } from './ModCard'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  toolbarCard: {
    padding: '8px',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  search: {
    flex: '1 1 200px',
    minWidth: '140px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '12px',
  },
  })

export function BrowseMods({ initialModId, initialCommentId, onConsumeNavTarget }) {
  const onConsumeRef = useRef(onConsumeNavTarget)
  useEffect(() => { onConsumeRef.current = onConsumeNavTarget }, [onConsumeNavTarget])
  const styles = useStyles()
  const { t } = useTranslation()
  const { user, isLoggedIn } = useAuth()
  const deviceIdRef = useRef(getDeviceId())
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState(() => sessionStorage.getItem('workshop_browse_sort') || 'created_at')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [mods, setMods] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(() => {
    const saved = sessionStorage.getItem('workshop_browse_page')
    return saved ? parseInt(saved, 10) : 1
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detailMod, setDetailMod] = useState(null)
  const [detailCommentId, setDetailCommentId] = useState(null)
  const [detailLoading, setDetailLoading] = useState(!!initialModId)
  const modStackRef = useRef([]) // 导航栈：返回上一页而非列表
  const [editingMod, setEditingMod] = useState(null)
  const [showCreatePage, setShowCreatePage] = useState(false)
  const [itemsPerRow, setItemsPerRow] = useState(3)
  const initialFetch = useRef(false)

  // 从 URL hash 恢复详情页（Ctrl+R 刷新后）或从导航参数进入
  useEffect(() => {
    const modId = initialModId || (() => {
      const match = window.location.hash.match(/^#\/mod\/(\d+)/)
      return match ? parseInt(match[1]) : null
    })()
    const commentId = initialCommentId || (() => {
      const match = window.location.hash.match(/[?&]comment=(\d+)/)
      return match ? parseInt(match[1]) : null
    })()
    if (!modId) return
    // modId 可能是数字 id（来自用户资料卡）或 mod_key 字符串（来自本地预览页菜单），
    // 非数字时作为 mod_key 传入，后端按 mod_key 解析详情。
    const fromNav = !!initialModId
    const modKey = Number.isFinite(Number(modId)) ? null : modId
    // 从外部导航（资料弹窗等）进入时，保存当前 mod 到导航栈，返回时回到上一页
    if (fromNav && detailMod) {
      modStackRef.current.push(detailMod)
    }
    getModDetail(modId, 'zh', user?.user_id, deviceIdRef.current, modKey)
      .then(data => {
        if (data.data?.mod) {
          setDetailMod(data.data.mod)
          if (commentId) setDetailCommentId(commentId)
        }
      })
      .catch(() => {})
      .finally(() => {
        setDetailLoading(false)
        // 导航意图已消费，清除 navTarget，避免下次进入创意工坊标签时重放上次详情
        if (fromNav) onConsumeRef.current?.()
      })
  }, [initialModId, initialCommentId, user])

  const fetchMods = useCallback(async (p, keyword = search, cat = categoryFilter, sort = sortBy) => {
    setLoading(true)
    setError('')
    try {
      const data = await listMods({
        lang: 'zh',
        search: keyword,
        page: p,
        limit: 20,
        sort_by: sort,
        device_id: deviceIdRef.current,
        category: cat,
      })
      setMods(data.mods || [])
      setTotal(data.total || 0)
      setPage(data.page || 1)
    } catch (e) {
      setError(e.message)
      setMods([])
    } finally {
      setLoading(false)
    }
  }, [search, sortBy, categoryFilter])

  useEffect(() => {
    sessionStorage.setItem('workshop_browse_page', String(page))
  }, [page])

  useEffect(() => {
    sessionStorage.setItem('workshop_browse_sort', sortBy)
  }, [sortBy])

  useEffect(() => {
    const loadItemsPerRow = async () => {
      try {
        const value = await getConfig('workshop_items_per_row')
        if (value !== null) {
          const parsed = parseInt(value, 10)
          if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 10) {
            setItemsPerRow(parsed)
          }
        }
      } catch (e) {
        console.warn('[BrowseMods] 读取每行展示数量失败:', e)
      }
    }
    loadItemsPerRow()
  }, [])

  const saveItemsPerRow = useCallback(async (value) => {
    try {
      await setConfig('workshop_items_per_row', String(value))
    } catch (e) {
      console.warn('[BrowseMods] 保存每行展示数量失败:', e)
    }
  }, [])

  const handleItemsPerRowChange = useCallback((delta) => {
    setItemsPerRow(prev => {
      const next = Math.min(10, Math.max(1, prev + delta))
      saveItemsPerRow(next)
      return next
    })
  }, [saveItemsPerRow])

  useEffect(() => {
    if (!initialFetch.current) {
      initialFetch.current = true
      fetchMods(page)
    }
  }, [fetchMods, page])

  const handleSearch = (value) => {
    setSearch(value)
  }

  const handleSearchSubmit = () => {
    setPage(1)
    fetchMods(1, search)
  }

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      const value = e.target.value
      setSearch(value)
      setPage(1)
      fetchMods(1, value)
    }
  }

  const handleEdit = async (mod) => {
    try {
      const res = await getModForEdit(mod.id, user.user_id)
      setEditingMod(res.data || mod)
    } catch (e) {
      alert('Failed to load edit data: ' + e.message)
    }
  }

  const [loginOpen, setLoginOpen] = useState(false)

  const handlePublishClick = () => {
    if (isLoggedIn) {
      setShowCreatePage(true)
    } else {
      setLoginOpen(true)
    }
  }

  const handleLoginSuccess = () => {
    setLoginOpen(false)
    setShowCreatePage(true)
  }

  if (showCreatePage) {
    return (
      <CreateModPage
        onClose={() => setShowCreatePage(false)}
        onCreated={() => { setShowCreatePage(false); fetchMods(1) }}
      />
    )
  }

  if (editingMod) return <EditModPage mod={editingMod} onClose={() => setEditingMod(null)} onUpdated={() => { setEditingMod(null); fetchMods() }} />

  if (detailMod) {
    return <ModDetailPage key={detailMod.id} mod={detailMod} onBack={() => {
      if (modStackRef.current.length > 0) {
        const prevMod = modStackRef.current.pop()
        window.location.hash = `#/mod/${prevMod.id}`
        setDetailMod(prevMod)
        setDetailCommentId(null)
      } else {
        setDetailMod(null)
        setDetailCommentId(null)
        window.location.hash = ''
      }
    }} onEdit={handleEdit} scrollToCommentId={detailCommentId} />
  }

  if (detailLoading) {
    return <Spinner size="large" label={t('workshop.loading')} style={{ marginTop: '40px' }} />
  }

  const totalPages = Math.ceil(total / 20)

  return (
    <div className={styles.root}>
      <Card className={styles.toolbarCard}>
        <div className={styles.toolbarRow}>
          <SearchBox
            className={styles.search}
            size="small"
            placeholder={t('workshop.searchPlaceholder')}
            value={search}
            onChange={(_, d) => handleSearch(d.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <Button size="small" icon={<Search24Regular />} onClick={handleSearchSubmit} disabled={loading}>
            {t('workshop.search')}
          </Button>
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={() => fetchMods(1)} disabled={loading}>
            {t('workshop.refresh')}
          </Button>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Text size="small">{t('workshop.type')}</Text>
            <Select size="small" value={categoryFilter} onChange={(_, d) => { const v = d.value; setCategoryFilter(v); setPage(1); fetchMods(1, search, v, sortBy) }} disabled={loading}>
              <option value="">{t('workshop.typeAll')}</option>
              <option value="v1">{t('workshop.category_v1')}</option>
              <option value="v2">{t('workshop.category_v2')}</option>
              <option value="dll">{t('workshop.category_dll')}</option>
              <option value="composite">{t('workshop.category_composite')}</option>
            </Select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Text size="small">{t('workshop.sortBy')}</Text>
            <Select size="small" value={sortBy} onChange={(_, d) => { const v = d.value; setSortBy(v); setPage(1); fetchMods(1, search, categoryFilter, v) }} disabled={loading}>
              <option value="created_at">{t('workshop.sortNewest')}</option>
              <option value="likes">{t('workshop.sortLikes')}</option>
              <option value="rating">{t('workshop.sortRating')}</option>
            </Select>
          </div>
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
        </div>
      </Card>

      <AsyncView loading={loading} error={error} onRetry={() => fetchMods(1)} loadingLabel={t('workshop.loading')}>
        {mods.length === 0 ? (
          <EmptyState
            title={t('workshop.noMods')}
            description={search ? t('workshop.noMatchHint') : t('workshop.noUploads')}
          />
        ) : (
          <>
            <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${itemsPerRow}, 1fr)` }}>
              {mods.map(mod => (
                <ModCard key={mod.id} mod={mod} onClick={() => {
                  if (detailMod) modStackRef.current.push(detailMod)
                  window.location.hash = `#/mod/${mod.id}`
                  setDetailMod(mod)
                  getModDetail(mod.id, 'zh', user?.user_id, deviceIdRef.current)
                    .then(data => { if (data.data?.mod) setDetailMod(data.data.mod) })
                    .catch(() => {})
                }} />
              ))}
            </div>

            <Pagination page={page} totalPages={totalPages} onChange={(p) => fetchMods(p)} />
          </>
        )}
      </AsyncView>

      <FloatingActions items={[
        { key: 'refresh', icon: <ArrowClockwise24Regular />, onClick: () => fetchMods(page), disabled: loading, label: t('workshop.refresh') },
        { key: 'publish', icon: <Add24Regular />, appearance: 'primary', onClick: handlePublishClick, label: t('workshop.publishMod') },
      ]} />

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={handleLoginSuccess} />
    </div>
  )
}
