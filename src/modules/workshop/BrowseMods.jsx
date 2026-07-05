import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, CardHeader, Text, Button, SearchBox,
  Spinner, makeStyles, tokens, Avatar, Badge,
  Select,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  Search24Regular,
  Add24Regular,
  Heart24Regular,
  Heart24Filled,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { listMods, getModDetail, getModForEdit, getDeviceId } from '../../services/workshopApi'
import ModDetailPage from './ModDetailPage'
import { useAuth } from '../../contexts/useAuth'
import { EditModPage, CreateModPage } from './MyMods'

const CATEGORIES = [
  { value: 'v1', label: 'v1' },
  { value: 'v2', label: 'v2' },
  { value: 'dll', label: 'dll' },
  { value: 'composite', label: 'composite' },
]

const LANG_LABELS = { zh: '中文', en: 'English', ja: '日本語' }

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
  pagination: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '12px 0',
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
  fab: {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: 1000,
    boxShadow: tokens.shadow8,
  },
  authorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
})

export function BrowseMods({ initialModId, initialCommentId }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user, isLoggedIn } = useAuth()
  const deviceIdRef = useRef(getDeviceId())
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState(() => sessionStorage.getItem('workshop_browse_sort') || 'created_at')
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

  const fetchMods = useCallback(async (p, keyword = search) => {
    setLoading(true)
    setError('')
    try {
      const data = await listMods({
        lang: 'zh',
        search: keyword,
        page: p,
        limit: 20,
        sort_by: sortBy,
        device_id: deviceIdRef.current,
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
  }, [search, sortBy])

  useEffect(() => {
    sessionStorage.setItem('workshop_browse_page', String(page))
  }, [page])

  useEffect(() => {
    sessionStorage.setItem('workshop_browse_sort', sortBy)
  }, [sortBy])

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
    return <ModDetailPage mod={detailMod} onBack={() => { setDetailMod(null); setDetailCommentId(null); window.location.hash = '' }} onEdit={handleEdit} scrollToCommentId={detailCommentId} />
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
            <Text size="small">{t('workshop.sortBy')}</Text>
            <Select size="small" value={sortBy} onChange={(_, d) => { setSortBy(d.value); setPage(1); fetchMods(1) }} disabled={loading}>
              <option value="created_at">{t('workshop.sortNewest')}</option>
              <option value="likes">{t('workshop.sortLikes')}</option>
            </Select>
          </div>
        </div>
      </Card>

      {loading && (
        <div className={styles.emptyState}>
          <Spinner size="small" label={t('workshop.loading')} />
        </div>
      )}

      {error && (
        <div className={styles.emptyState}>
          <Text weight="semibold">{t('workshop.loadFailed')}</Text>
          <Text size="small" className={styles.meta}>{error}</Text>
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={() => fetchMods(1)}>{t('workshop.retry')}</Button>
        </div>
      )}

      {!loading && !error && mods.length === 0 && (
        <div className={styles.emptyState}>
          <Text weight="semibold">{t('workshop.noMods')}</Text>
          <Text size="small" className={styles.meta}>
            {search ? t('workshop.noMatchHint') : t('workshop.noUploads')}
          </Text>
        </div>
      )}

      {!loading && !error && mods.length > 0 && (
        <>
          <div className={styles.grid}>
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
                    <div className={styles.authorRow}>
                      <Avatar name={mod.author_name} size={20} />
                      <Text size="small" className={styles.meta}>{mod.author_name}</Text>
                    </div>
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
                        <div key={f.lang_code} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px' }}>
                          <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
                            {LANG_LABELS[f.lang_code] || f.lang_code}
                          </Badge>
                          <Text size="small" truncate style={{ flex: 1 }}>{langName}</Text>
                          <Text size="small">v{f.version}</Text>
                          <Text size="small" className={styles.meta}>{(f.file_size / 1024).toFixed(1)}KB</Text>
                        </div>
                      )})}
                    </div>
                  )}
                </div>
              </Card>
            )
          })}
          </div>

          {totalPages > 1 && (
            <div className={styles.pagination}>
              <Button size="small" disabled={page <= 1} onClick={() => fetchMods(page - 1)}>{t('workshop.prevPage')}</Button>
              <Text size="small">{page} / {totalPages}</Text>
              <Button size="small" disabled={page >= totalPages} onClick={() => fetchMods(page + 1)}>{t('workshop.nextPage')}</Button>
            </div>
          )}
        </>
      )}

      {isLoggedIn && (
        <Button
          size="large"
          icon={<Add24Regular />}
          appearance="primary"
          className={styles.fab}
          onClick={() => setShowCreatePage(true)}
          title={t('workshop.publishMod')}
        />
      )}
    </div>
  )
}
