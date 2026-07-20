import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, CardHeader, Text, Button, SearchBox,
  Spinner, makeStyles, tokens, Badge,
  Select,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  Search24Regular,
  Add24Regular,
  Heart24Regular,
  Heart24Filled,
  Add20Regular,
  Subtract20Regular,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { listMods, getModDetail, getModForEdit, getDeviceId } from '../../services/workshopApi'
import ModDetailPage from './ModDetailPage'
import { useAuth } from '../../contexts/useAuth'
import { EditModPage, CreateModPage } from './MyMods'
import { getConfig, setConfig } from '../../services/dbHelper'
import { Pagination, AsyncView, LoginDialog, FloatingActions, FileRow } from '../../components'

const CATEGORIES = [
  { value: 'v1', label: 'v1' },
  { value: 'v2', label: 'v2' },
  { value: 'dll', label: 'dll' },
  { value: 'composite', label: 'composite' },
]

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
  card: {
    padding: '12px',
    cursor: 'pointer',
    height: '100%',
    minHeight: '220px',
    transition: 'box-shadow 0.2s ease',
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginTop: '8px',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  description: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
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
  footerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  stats: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
  },
  })

export function BrowseMods({ initialModId, initialCommentId }) {
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
    getModDetail(modId, 'zh', user?.user_id, deviceIdRef.current)
      .then(data => {
        if (data.data?.mod) {
          setDetailMod(data.data.mod)
          if (commentId) setDetailCommentId(commentId)
        }
      })
      .catch(() => {})
      .finally(() => setDetailLoading(false))
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
    return <ModDetailPage key={detailMod.id} mod={detailMod} onBack={() => { setDetailMod(null); setDetailCommentId(null); window.location.hash = '' }} onEdit={handleEdit} scrollToCommentId={detailCommentId} />
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
          <div className={styles.emptyState}>
            <Text weight="semibold">{t('workshop.noMods')}</Text>
            <Text size="small" className={styles.meta}>
              {search ? t('workshop.noMatchHint') : t('workshop.noUploads')}
            </Text>
          </div>
        ) : (
          <>
            <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${itemsPerRow}, 1fr)` }}>
              {mods.map(mod => {
                const cat = CATEGORIES.find(c => c.value === mod.category)
                return (
                <Card key={mod.id} className={styles.card} appearance="outline" onClick={() => {
                  window.location.hash = `#/mod/${mod.id}`
                  setDetailMod(mod)
                  getModDetail(mod.id, 'zh', user?.user_id, deviceIdRef.current)
                    .then(data => { if (data.data?.mod) setDetailMod(data.data.mod) })
                    .catch(() => {})
                }}>
                  <CardHeader
                    header={
                      <Text size="small" className={styles.meta} truncate>{mod.mod_key}</Text>
                    }
                    description={
                      <Text size="small" className={styles.meta}>{mod.author_name}</Text>
                    }
                    action={
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }} title={mod.is_liked ? t('workshop.likedHint') : t('workshop.unlikedHint')}>
                          {mod.is_liked ? (
                            <Heart24Filled style={{ color: tokens.colorPaletteRedForeground1, fontSize: '16px' }} />
                          ) : (
                            <Heart24Regular style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />
                          )}
                          <Text size="small">{mod.like_count || 0}</Text>
                        </div>
                        <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
                          {cat ? t(`workshop.category_${cat.value}`) : (mod.category ? t(`workshop.category_${mod.category}`, mod.category) : t('workshop.uncategorized'))}
                        </Badge>
                      </div>
                    }
                  />
                  <div className={styles.cardBody}>
                    {mod.description && (
                      <Text size="small" className={styles.description}>{mod.description}</Text>
                    )}
                    {mod.files && mod.files.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {mod.files.map(f => {
                          const langName = mod.translations?.[f.lang_code]?.name || mod.display_name
                          return (
                          <FileRow key={f.lang_code} langCode={f.lang_code} name={langName} version={f.version} fileSize={f.file_size} />
                        )})}
                      </div>
                    )}
                  </div>
                </Card>
              )
            })}
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
