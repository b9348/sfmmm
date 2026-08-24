import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, Text, Button, SearchBox,
  Spinner, makeStyles,
  Select, tokens,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  Search24Regular,
  Add24Regular,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { listMods, getModDetail, getModForEdit, getDeviceId } from '../../services/workshopApi'
import ModDetailPage from './ModDetailPage'
import { useAuth } from '../../contexts/useAuth'
import { usePagePrefetch } from '../../hooks/usePagePrefetch'
import { EditModPage, CreateModPage } from './MyMods'
import { getConfig, setConfig } from '../../services/dbHelper'
import { Pagination, AsyncView, LoginDialog, FloatingActions, EmptyState, ItemsPerRowControl } from '../../components'
import { ModCard } from './ModCard'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  toolbarCard: {
    padding: '8px',
    position: 'sticky',
    top: 0,
    zIndex: 100,
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
  detailOverlay: {
    position: 'fixed',
    zIndex: 1000,
    backgroundColor: tokens.colorNeutralBackground2,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  })

export function BrowseMods({ initialModId, initialCommentId, onConsumeNavTarget, active = true }) {
  const onConsumeRef = useRef(onConsumeNavTarget)
  useEffect(() => { onConsumeRef.current = onConsumeNavTarget }, [onConsumeNavTarget])
  const styles = useStyles()
  const { t } = useTranslation()
  const { user, isLoggedIn } = useAuth()
  const deviceIdRef = useRef(getDeviceId())
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState(() => sessionStorage.getItem('workshop_browse_sort') || 'created_at')
  // 时间正/倒序：desc（新→旧，默认）| asc（旧→新），持久化到 sqlite config 表
  const [sortOrder, setSortOrder] = useState('desc')
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
  const rootRef = useRef(null)
  const [overlayRect, setOverlayRect] = useState(null)

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

  // 详情预取缓存：hover 卡片时预请求，点击命中缓存秒开详情
  const detailCacheRef = useRef(new Map()) // mod.id -> Promise<mod> | mod（请求完成后替换为结果）
  const fetchDetail = useCallback((modId) => {
    const cached = detailCacheRef.current.get(modId)
    if (cached) return Promise.resolve(cached)
    const promise = getModDetail(modId, 'zh', user?.user_id, deviceIdRef.current)
      .then(data => {
        const full = data?.data?.mod
        if (full) detailCacheRef.current.set(modId, full)
        return full || null
      })
      .catch(() => null)
    detailCacheRef.current.set(modId, promise)
    return promise
  }, [user])
  const prefetchDetail = useCallback((mod) => {
    if (mod?.id) fetchDetail(mod.id)
  }, [fetchDetail])

  // hover 预取防抖：停留 700ms 才预请求；鼠标按下则立即预请求（不等 hover 时长）
  const hoverTimerRef = useRef(null)
  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])
  const handleCardMouseEnter = useCallback((mod) => {
    clearHoverTimer()
    hoverTimerRef.current = setTimeout(() => prefetchDetail(mod), 700)
  }, [clearHoverTimer, prefetchDetail])
  const handleCardMouseLeave = useCallback(() => {
    clearHoverTimer()
  }, [clearHoverTimer])
  const handleCardMouseDown = useCallback((mod) => {
    clearHoverTimer()
    prefetchDetail(mod)
  }, [clearHoverTimer, prefetchDetail])
  // 卸载时清理 hover 定时器
  useEffect(() => clearHoverTimer, [clearHoverTimer])

  // 分页预请求：当前页就绪后自动预请求下一页，翻页命中缓存免等待
  const { fetchPage, fetchFresh, prefetch, peek, clearCache } = usePagePrefetch(async (p, keyword, cat, sort, order) => {
    const data = await listMods({
      lang: 'zh',
      search: keyword,
      page: p,
      limit: 20,
      sort_by: sort,
      sort_order: order,
      device_id: deviceIdRef.current,
      category: cat,
    })
    return { mods: data.mods || [], total: data.total || 0, page: data.page || 1 }
  })

  const fetchMods = useCallback(async (p, keyword = search, cat = categoryFilter, sort = sortBy, order = sortOrder, opts = {}) => {
    const { force = false } = opts
    // 命中预请求缓存：免 loading 直接渲染，并继续预请求下一页维持预取链
    if (!force) {
      const cached = peek(p, keyword, cat, sort, order)
      if (cached) {
        setMods(cached.mods)
        setTotal(cached.total)
        setPage(cached.page)
        setError('')
        prefetch(p + 1, keyword, cat, sort, order)
        return
      }
    }
    setLoading(true)
    setError('')
    try {
      const data = force ? await fetchFresh(p, keyword, cat, sort, order) : await fetchPage(p, keyword, cat, sort, order)
      setMods(data.mods || [])
      setTotal(data.total || 0)
      setPage(data.page || 1)
    } catch (e) {
      setError(e.message)
      setMods([])
    } finally {
      setLoading(false)
    }
  }, [search, sortBy, sortOrder, categoryFilter, peek, fetchPage, fetchFresh, prefetch])

  useEffect(() => {
    sessionStorage.setItem('workshop_browse_page', String(page))
  }, [page])

  useEffect(() => {
    sessionStorage.setItem('workshop_browse_sort', sortBy)
  }, [sortBy])

  // 时间正/倒序持久化到 sqlite config 表（个性化浏览习惯，跨会话保持）
  useEffect(() => {
    const loadSortOrder = async () => {
      try {
        const value = await getConfig('workshop_browse_sort_order')
        if (value === 'asc' || value === 'desc') {
          setSortOrder(value)
          // 恢复的方向非默认时立即按该方向拉取：
          // initialFetch 门控不会因 sortOrder 变化重拉，需显式请求才能让持久化偏好生效
          if (value !== 'desc') {
            fetchMods(1, search, categoryFilter, sortBy, value, { force: true })
          }
        }
      } catch (e) {
        console.warn('[BrowseMods] 读取时间排序方向失败:', e)
      }
    }
    loadSortOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveSortOrder = useCallback(async (value) => {
    try {
      await setConfig('workshop_browse_sort_order', value)
    } catch (e) {
      console.warn('[BrowseMods] 保存时间排序方向失败:', e)
    }
  }, [])

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

  const handleItemsPerRowChange = useCallback((next) => {
    setItemsPerRow(next)
    saveItemsPerRow(next)
  }, [saveItemsPerRow])

  // 挂载即拉取：Workshop 用 useTabPrefetch 只挂载当前 + 预加载的下一个 tab（非全挂载），
  // 预加载目标在后台提前请求，切换即时展示；避免冷启动多个页面查询挤在唯一连接上排队
  useEffect(() => {
    if (initialFetch.current) return
    initialFetch.current = true
    fetchMods(page)
  }, [fetchMods, page])

  // 常驻挂载下，从隐藏回到可见（再次进入该 tab）时强制刷新，避免列表数据过期；
  // 首次展示（预加载目标）不重复拉取，直接呈现预加载结果。
  // 实现要点：依赖数组仍包含 page/search/filter/sort（保证 effect 在这些值变化后
  // 能读到最新值用于 force 刷新），但用 justBecameActive 守卫过滤掉非 active 边沿
  // 的重跑——这样翻页时 fetchMods 内部 setPage 触发的 effect 重跑会直接 return，
  // 不会绕过预取缓存额外重拉一次当前页。
  const wasShown = useRef(false)
  const prevActiveRef = useRef(active)
  useEffect(() => {
    const justBecameActive = active && !prevActiveRef.current
    prevActiveRef.current = active
    if (!justBecameActive) return
    if (wasShown.current) {
      fetchMods(page, search, categoryFilter, sortBy, sortOrder, { force: true })
    }
    wasShown.current = true
  }, [active, page, search, categoryFilter, sortBy, sortOrder, fetchMods])

  // 详情页以覆盖层形式渲染在列表上方，列表保持挂载：
  // 返回时不会重载数据，滚动位置与图片缓存都得以保留。
  const getContentEl = useCallback(() => {
    let el = rootRef.current
    while (el) {
      const style = window.getComputedStyle(el)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') return el
      el = el.parentElement
    }
    return null
  }, [])

  useEffect(() => {
    if (!detailMod) {
      setOverlayRect(null)
      return
    }
    const content = getContentEl()
    if (!content) return
    const compute = () => {
      const r = content.getBoundingClientRect()
      setOverlayRect({
        top: r.top,
        left: r.left,
        right: window.innerWidth - r.right,
        bottom: window.innerHeight - r.bottom,
      })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(content)
    window.addEventListener('resize', compute)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', compute)
    }
  }, [detailMod, getContentEl])

  const handleDetailBack = useCallback(() => {
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
  }, [])

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

  if (detailLoading && !detailMod) {
    return <Spinner size="large" label={t('workshop.loading')} style={{ marginTop: '40px' }} />
  }

  const totalPages = Math.ceil(total / 20)

  return (
    <div className={styles.root} ref={rootRef}>
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
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={() => fetchMods(1, search, categoryFilter, sortBy, sortOrder, { force: true })} disabled={loading}>
            {t('workshop.refresh')}
          </Button>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Text size="small">{t('workshop.type')}</Text>
            <Select size="small" value={categoryFilter} onChange={(_, d) => { const v = d.value; setCategoryFilter(v); setPage(1); fetchMods(1, search, v, sortBy, sortOrder) }} disabled={loading}>
              <option value="">{t('workshop.typeAll')}</option>
              <option value="v1">{t('workshop.category_v1')}</option>
              <option value="v2">{t('workshop.category_v2')}</option>
              <option value="dll">{t('workshop.category_dll')}</option>
              <option value="composite">{t('workshop.category_composite')}</option>
            </Select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Text size="small">{t('workshop.sortBy')}</Text>
            <Select data-tour="workshop-sort-select" size="small" value={sortBy} onChange={(_, d) => { const v = d.value; setSortBy(v); setPage(1); fetchMods(1, search, categoryFilter, v, sortOrder) }} disabled={loading}>
              <option value="created_at">{t('workshop.sortRecent')}</option>
              <option value="published_at">{t('workshop.sortNewest')}</option>
              <option value="likes">{t('workshop.sortLikes')}</option>
              <option value="rating">{t('workshop.sortRating')}</option>
            </Select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Text size="small">{t('workshop.sortTime')}</Text>
            <Select
              size="small"
              value={sortOrder}
              onChange={(_, d) => { const v = d.value; setSortOrder(v); saveSortOrder(v); setPage(1); fetchMods(1, search, categoryFilter, sortBy, v) }}
              disabled={loading || (sortBy !== 'created_at' && sortBy !== 'published_at')}
            >
              <option value="desc">{t('workshop.sortNewestFirst')}</option>
              <option value="asc">{t('workshop.sortOldestFirst')}</option>
            </Select>
          </div>
          <ItemsPerRowControl value={itemsPerRow} onChange={handleItemsPerRowChange} disabled={loading} />
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
                <ModCard
                  key={mod.id}
                  mod={mod}
                  onMouseEnter={() => handleCardMouseEnter(mod)}
                  onMouseLeave={handleCardMouseLeave}
                  onMouseDown={() => handleCardMouseDown(mod)}
                  onClick={() => {
                    if (detailMod) modStackRef.current.push(detailMod)
                    window.location.hash = `#/mod/${mod.id}`
                    setDetailMod(mod)
                    // 命中 hover/按下预取缓存时秒开详情；未命中则发起请求
                    fetchDetail(mod.id).then(full => { if (full) setDetailMod(full) })
                  }}
                />
              ))}
            </div>

            <Pagination page={page} totalPages={totalPages} onChange={(p) => fetchMods(p)} floating />
          </>
        )}
      </AsyncView>

      <FloatingActions items={[
        { key: 'refresh', icon: <ArrowClockwise24Regular />, onClick: () => fetchMods(page, search, categoryFilter, sortBy, sortOrder, { force: true }), disabled: loading, label: t('workshop.refresh') },
        { key: 'publish', icon: <Add24Regular />, appearance: 'primary', onClick: handlePublishClick, label: t('workshop.publishMod') },
      ]} />

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={handleLoginSuccess} />

      {detailMod && overlayRect && (
        <div
          className={styles.detailOverlay}
          style={{ top: overlayRect.top, left: overlayRect.left, right: overlayRect.right, bottom: overlayRect.bottom }}
        >
          <ModDetailPage key={detailMod.id} mod={detailMod} onBack={handleDetailBack} onEdit={handleEdit} scrollToCommentId={detailCommentId} />
        </div>
      )}
    </div>
  )
}
