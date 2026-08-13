import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, Text, Button, SearchBox,
  Spinner, makeStyles, Select, tokens,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  Search24Regular,
  Add24Regular,
  Add20Regular,
  Subtract20Regular,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { listDiscussions, getDiscussionDetail } from '../../services/workshopApi'
import { getConfig, setConfig } from '../../services/dbHelper'
import { DiscussionCard } from './DiscussionCard'
import { DiscussionDetailPage } from './DiscussionDetailPage'
import { CreateDiscussionPage } from './CreateDiscussionPage'
import { useAuth } from '../../contexts/useAuth'
import { usePagePrefetch } from '../../hooks/usePagePrefetch'
import { Pagination, AsyncView, LoginDialog, FloatingActions, EmptyState } from '../../components'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    height: '100%',
    minHeight: 0,
  },
  toolbarCard: {
    padding: '8px',
    position: 'sticky',
    top: 0,
    zIndex: 100,
    flexShrink: 0,
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
  content: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    position: 'relative',
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

/**
 * 讨论区：单一帖子流（投票帖在卡片上以徽标区分），不设内部 tab；
 * 详情使用 #/discuss/<id>?comment=<cid> hash（「我的」历史跳转定位用）。
 */
export function Discussion() {
  const { t } = useTranslation()
  const styles = useStyles()
  const { user, isLoggedIn } = useAuth()

  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('created_at')
  const [itemsPerRow, setItemsPerRow] = useState(3)
  const [discussions, setDiscussions] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailCommentId, setDetailCommentId] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const rootRef = useRef(null)
  const [overlayRect, setOverlayRect] = useState(null)

  // ── 详情预取缓存（与 BrowseMods 同模式）：hover 卡片时预请求，点击命中缓存秒开详情 ──
  const detailCacheRef = useRef(new Map()) // discussion.id -> Promise<discussion> | discussion
  const fetchDetail = useCallback((id) => {
    const cached = detailCacheRef.current.get(id)
    if (cached) return Promise.resolve(cached)
    const promise = getDiscussionDetail(id, user?.user_id)
      .then(res => {
        const full = res?.data
        if (full) {
          detailCacheRef.current.set(id, full)
          return full
        }
        // 请求成功但无数据：不缓存，允许下次重试
        detailCacheRef.current.delete(id)
        return null
      })
      .catch(() => {
        // 请求失败：不缓存失败结果，否则点击永远命中 null 缓存打不开详情
        detailCacheRef.current.delete(id)
        return null
      })
    detailCacheRef.current.set(id, promise)
    return promise
  }, [user])

  const prefetchDetail = useCallback((d) => {
    if (d?.id) fetchDetail(d.id)
  }, [fetchDetail])

  // hover 预取防抖：停留 700ms 才预请求；鼠标按下则立即预请求（不等 hover 时长）
  const hoverTimerRef = useRef(null)
  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])
  const handleCardMouseEnter = useCallback((d) => {
    clearHoverTimer()
    hoverTimerRef.current = setTimeout(() => prefetchDetail(d), 700)
  }, [clearHoverTimer, prefetchDetail])
  const handleCardMouseLeave = useCallback(() => {
    clearHoverTimer()
  }, [clearHoverTimer])
  const handleCardMouseDown = useCallback((d) => {
    clearHoverTimer()
    prefetchDetail(d)
  }, [clearHoverTimer, prefetchDetail])
  // 卸载时清理 hover 定时器
  useEffect(() => clearHoverTimer, [clearHoverTimer])

  // 从 hash 打开详情：#/discuss/<id>?comment=<cid>（我的历史跳转 / 刷新保持）
  const openFromHash = useCallback((hash, fromNav = false) => {
    const m = hash.match(/^#\/discuss\/(\d+)/)
    if (!m) return
    const id = parseInt(m[1], 10)
    const cm = hash.match(/[?&]comment=(\d+)/)
    const commentId = cm ? parseInt(cm[1], 10) : null
    setDetailLoading(true)
    // 命中 hover/按下预取缓存时秒开详情；未命中则发起请求
    fetchDetail(id)
      .then(full => {
        if (full) {
          setDetail(full)
          if (commentId) setDetailCommentId(commentId)
        }
      })
      .finally(() => setDetailLoading(false))
  }, [fetchDetail])

  useEffect(() => {
    if (/^#\/discuss\//.test(window.location.hash)) openFromHash(window.location.hash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // hashchange：我的历史跳转 / 侧栏进入时同步
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash
      if (/^#\/discuss\//.test(hash)) openFromHash(hash)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [openFromHash])

  const handleDetailBack = useCallback(() => {
    setDetail(null)
    setDetailCommentId(null)
    window.location.hash = '#/workshop/discuss'
  }, [])

  const { fetchPage, fetchFresh, prefetch, peek, clearCache } = usePagePrefetch(async (p, keyword, sort) => {
    const data = await listDiscussions({
      page: p,
      limit: 20,
      search: keyword,
      sort_by: sort,
      user_id: user?.user_id,
    })
    return { discussions: data.discussions || [], total: data.total || 0, page: data.page || 1 }
  })

  const fetchList = useCallback(async (p, keyword = search, sort = sortBy, opts = {}) => {
    const { force = false } = opts
    if (!force) {
      const cached = peek(p, keyword, sort)
      if (cached) {
        setDiscussions(cached.discussions)
        setTotal(cached.total)
        setPage(cached.page)
        setError('')
        prefetch(p + 1, keyword, sort)
        return
      }
    }
    setLoading(true)
    setError('')
    try {
      const data = force ? await fetchFresh(p, keyword, sort) : await fetchPage(p, keyword, sort)
      setDiscussions(data.discussions || [])
      setTotal(data.total || 0)
      setPage(data.page || 1)
    } catch (e) {
      setError(e.message)
      setDiscussions([])
    } finally {
      setLoading(false)
    }
  }, [search, sortBy, peek, fetchPage, fetchFresh, prefetch])

  const initialFetch = useRef(false)
  useEffect(() => {
    if (!initialFetch.current) {
      initialFetch.current = true
      fetchList(1)
    }
  }, [fetchList])

  // 每行展示数量：与「云」共用 workshop_items_per_row 配置键（1-10 持久化）
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
        console.warn('[Discussion] 读取每行展示数量失败:', e)
      }
    }
    loadItemsPerRow()
  }, [])

  const saveItemsPerRow = useCallback(async (value) => {
    try {
      await setConfig('workshop_items_per_row', String(value))
    } catch (e) {
      console.warn('[Discussion] 保存每行展示数量失败:', e)
    }
  }, [])

  const handleItemsPerRowChange = useCallback((delta) => {
    setItemsPerRow(prev => {
      const next = Math.min(10, Math.max(1, prev + delta))
      saveItemsPerRow(next)
      return next
    })
  }, [saveItemsPerRow])

  // 详情页以覆盖层形式渲染在列表上方，列表保持挂载：
  // 返回时不会重载数据，滚动位置与图片缓存都得以保留。
  // 与 BrowseMods 同模式：从 rootRef 向上找滚动容器（不用全局 querySelector，
  // 避免 Workshop 多 tab 常驻挂载时误匹配其他 tab 的隐藏元素导致覆盖层位置失效）
  const getContentEl = useCallback(() => {
    let el = rootRef.current
    while (el) {
      const style = window.getComputedStyle(el)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') return el
      el = el.parentElement
    }
    return null
  }, [])

  // 详情覆盖层尺寸跟随滚动容器
  useEffect(() => {
    if (!detail) {
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
  }, [detail, getContentEl])

  const handleSearchSubmit = () => {
    setPage(1)
    fetchList(1, search, sortBy, { force: true })
  }

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      setSearch(e.target.value)
      setPage(1)
      fetchList(1, e.target.value, sortBy, { force: true })
    }
  }

  const handlePublishClick = () => {
    if (isLoggedIn) {
      setShowCreate(true)
    } else {
      setLoginOpen(true)
    }
  }

  if (showCreate) {
    return (
      <CreateDiscussionPage
        authorId={user?.user_id}
        onClose={() => setShowCreate(false)}
        onCreated={() => {
          setShowCreate(false)
          clearCache()
          fetchList(1, search, sortBy, { force: true })
        }}
      />
    )
  }

  const totalPages = Math.ceil(total / 20)

  return (
    <div className={styles.root} ref={rootRef}>
      <Card className={styles.toolbarCard}>
        <div className={styles.toolbarRow}>
          <SearchBox
            className={styles.search}
            size="small"
            placeholder={t('discussion.searchPlaceholder')}
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <Button size="small" icon={<Search24Regular />} onClick={handleSearchSubmit} disabled={loading}>
            {t('discussion.search')}
          </Button>
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={() => fetchList(1, search, sortBy, { force: true })} disabled={loading}>
            {t('discussion.refresh')}
          </Button>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Text size="small">{t('workshop.sortBy')}</Text>
            <Select size="small" value={sortBy} onChange={(_, d) => { const v = d.value; setSortBy(v); setPage(1); fetchList(1, search, v, { force: true }) }} disabled={loading}>
              <option value="created_at">{t('workshop.sortNewest')}</option>
              <option value="likes">{t('workshop.sortLikes')}</option>
              <option value="boosts">{t('discussion.boostCount', { count: '' })}</option>
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

      <div className={styles.content}>
        {detailLoading && !detail ? (
          <Spinner size="large" label={t('discussion.loading')} style={{ marginTop: '40px' }} />
        ) : (
          <>
            <AsyncView loading={loading} error={error} onRetry={() => fetchList(1)} loadingLabel={t('discussion.loading')}>
              {discussions.length === 0 ? (
                <EmptyState
                  title={t('discussion.noDiscussions')}
                  description={search ? t('discussion.noMatchHint') : t('discussion.noUploads')}
                />
              ) : (
                <>
                  <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${itemsPerRow}, 1fr)` }}>
                    {discussions.map(d => (
                      <DiscussionCard
                        key={d.id}
                        discussion={d}
                        onMouseEnter={() => handleCardMouseEnter(d)}
                        onMouseLeave={handleCardMouseLeave}
                        onMouseDown={() => handleCardMouseDown(d)}
                        onClick={() => {
                          window.location.hash = `#/discuss/${d.id}`
                          // 先用列表项数据立即渲染详情（秒开），再异步补全完整数据；
                          // 即使补全失败也能看到标题/正文，避免"点击无反应"
                          setDetail(d)
                          setDetailCommentId(null)
                          openFromHash(window.location.hash)
                        }}
                      />
                    ))}
                  </div>
                  <Pagination page={page} totalPages={totalPages} onChange={(p) => fetchList(p)} floating />
                </>
              )}
            </AsyncView>

            <FloatingActions items={[
              { key: 'refresh', icon: <ArrowClockwise24Regular />, onClick: () => fetchList(page, search, sortBy, { force: true }), disabled: loading, label: t('discussion.refresh') },
              { key: 'publish', icon: <Add24Regular />, appearance: 'primary', onClick: handlePublishClick, label: t('discussion.publish') },
            ]} />

            <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={() => setLoginOpen(false)} />
          </>
        )}

        {detail && overlayRect && (
          <div
            className={styles.detailOverlay}
            style={{ top: overlayRect.top, left: overlayRect.left, right: overlayRect.right, bottom: overlayRect.bottom }}
          >
            <DiscussionDetailPage
              key={detail.id}
              discussion={detail}
              onBack={handleDetailBack}
              scrollToCommentId={detailCommentId}
              onUpdated={(updated) => {
                setDetail(updated)
                // 同步更新详情缓存，避免关闭详情后再次点击命中旧数据
                detailCacheRef.current?.set(updated.id, updated)
                clearCache()
                fetchList(1, search, sortBy, { force: true })
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default Discussion
