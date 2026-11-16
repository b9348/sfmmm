import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Spinner,
  makeStyles, tokens,
  Toast, ToastBody, ToastTitle, useToastController,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  Add24Regular,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { listDiscussions, getDiscussionDetail } from '../../services/workshopApi'
import { commentIdFromHash, consumeEntryPoint, discardEntryPoint, peekEntryPoint, restoreScroll } from '../../utils/navReturn'
import { isDetailHash, previousView, restoreView } from '../../utils/navHistory'
import { formatDbError, isConnectivityError } from '../../services/dbCall'
import { getConfig, setConfig } from '../../services/dbHelper'
import { DiscussionCard } from './DiscussionCard'
import { DiscussionDetailPage } from './DiscussionDetailPage'
import { CreateDiscussionPage } from './CreateDiscussionPage'
import { useAuth } from '../../contexts/useAuth'
import { usePagePrefetch } from '../../hooks/usePagePrefetch'
import { useGridColumns } from '../../hooks/useGridColumns'
import { usePersistedNumber } from '../../hooks/usePersistedNumber'
import { useHoverPrefetch } from '../../hooks/useHoverPrefetch'
import { Pagination, AsyncView, LoginDialog, FloatingActions, EmptyState, OfflineCacheNotice, ListToolbar } from '../../components'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    height: '100%',
    minHeight: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    position: 'relative',
  },
  grid: {
    display: 'grid',
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
  // 详情导航栈：下层保持挂载但隐藏，返回时不重新拉评论
  detailLayerTop: {
    display: 'contents',
  },
  detailLayerHidden: {
    display: 'none',
  },
})

/** 详情是从「我的 - 我的发帖/回复」进来的（hash 带 from=my）：返回时回「我的」页 */
function openedFromMine(hash) {
  return /[?&]from=my\b/.test(String(hash || ''))
}

/** 列表中最新的帖子 id（帖子 id 递增，用于「缓存 vs 实时数据」是否有新内容） */
function latestId(list) {
  return (list || []).reduce((max, d) => (d?.id > max ? d.id : max), 0)
}

/**
 * 讨论区：单一帖子流（投票帖在卡片上以徽标区分），不设内部 tab；
 * 详情使用 #/discuss/<id>?comment=<cid> hash（「我的」历史跳转定位用）。
 *
 * onNewContent：缓存优先渲染后，后台刷新拿到的列表比缓存多出新帖时回调
 * （由 Workshop 在「讨论区」页签上点蓝点提示）。只在未展示讨论区时回调。
 */
export function Discussion({ active = true, onNewContent }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const { user, isLoggedIn } = useAuth()

  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('created_at')
  // 时间正/倒序：desc（新→旧，默认）| asc（旧→新），持久化到 sqlite config 表
  const [sortOrder, setSortOrder] = useState('desc')
  const [itemsPerRow, handleItemsPerRowChange] = usePersistedNumber('workshop_items_per_row', { defaultValue: 3, logTag: 'Discussion' })
  const [gridRef, gridColumns] = useGridColumns(itemsPerRow)
  const [discussions, setDiscussions] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailCommentId, setDetailCommentId] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // 离线缓存标注时间戳：列表/详情来自 SQLite 缓存（断连降级）时非 null
  const [listOfflineAt, setListOfflineAt] = useState(null)
  const [detailOfflineAt, setDetailOfflineAt] = useState(null)
  const [detailPartial, setDetailPartial] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const rootRef = useRef(null)
  const [overlayRect, setOverlayRect] = useState(null)

  // ── 详情预取缓存（与 BrowseMods 同模式）：hover 卡片时预请求，点击命中缓存秒开详情 ──
  const detailCacheRef = useRef(new Map()) // discussion.id -> Promise<discussion> | discussion
  // 提及卡片在主题帖之间跳转时，把来源帖保留挂载（隐藏），返回不重载评论区
  const [detailStack, setDetailStack] = useState([])
  const detailStackRef = useRef([])
  const detailRef = useRef(detail)
  // 返回上一层时我们要自己复用挂载中的详情；记录要跳过的目标 hash，避免误吞别的导航
  const suppressHashOpenRef = useRef('')
  useEffect(() => { detailRef.current = detail }, [detail])
  const MAX_DETAIL_LAYERS = 5
  const pushDetailLayer = useCallback((d) => {
    if (!d) return
    const last = detailStackRef.current[detailStackRef.current.length - 1]
    if (last && last.id === d.id) return
    detailStackRef.current.push(d)
    while (detailStackRef.current.length > MAX_DETAIL_LAYERS) detailStackRef.current.shift()
    setDetailStack([...detailStackRef.current])
  }, [])
  const popDetailLayer = useCallback(() => {
    const d = detailStackRef.current.pop()
    setDetailStack([...detailStackRef.current])
    return d
  }, [])
  const clearDetailLayers = useCallback(() => {
    detailStackRef.current = []
    setDetailStack([])
  }, [])
  // 当前展示详情的 id（effect 同步）：revalidate 回来时据此判断详情是否仍在展示，
  // 避免旧请求的网络刷新覆盖用户已切换到的其他详情
  const detailIdRef = useRef(null)
  useEffect(() => { detailIdRef.current = detail?.id ?? null }, [detail])
  // 列表请求纪元：revalidate 完成时纪元已变说明用户已翻页/换条件，丢弃旧刷新
  const listEpochRef = useRef(0)
  // 详情打开失败（离线且没有缓存 / 已删除 / 云端报错）时给出提示：
  // 详情覆盖层只有拿到数据才渲染，否则会静默退回列表，用户不知道发生了什么
  const { dispatchToast } = useToastController()
  // t 随界面语言切换而变化；用 ref 取最新值，避免把它塞进 openFromHash 依赖
  // 导致 hashchange 监听反复重绑
  const tRef = useRef(t)
  useEffect(() => { tRef.current = t }, [t])
  // 同上：新帖提示的回调与「当前是否正在浏览讨论区」也走 ref，
  // 避免把它们塞进 fetchList 依赖导致列表重新拉取
  const onNewContentRef = useRef(onNewContent)
  useEffect(() => { onNewContentRef.current = onNewContent }, [onNewContent])
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])
  // { id, error }：fetchDetail 失败时记录，供提示按错误类型选文案
  const detailErrorRef = useRef(null)
  const notifyDetailUnavailable = useCallback((id) => {
    const rec = detailErrorRef.current
    const err = rec && rec.id === id ? rec.error : null
    const tt = tRef.current
    const body = err && !isConnectivityError(err)
      ? formatDbError(err, tt)
      : tt('offline.detailUnavailableBody')
    dispatchToast(
      <Toast>
        <ToastTitle>{tt('offline.detailUnavailableTitle')}</ToastTitle>
        <ToastBody>{body}</ToastBody>
      </Toast>,
      { intent: 'warning', timeout: 6000 },
    )
  }, [dispatchToast])
  const fetchDetail = useCallback((id) => {
    const cached = detailCacheRef.current.get(id)
    if (cached) return Promise.resolve(cached)
    const promise = getDiscussionDetail(id, user?.user_id)
      .then(res => {
        const full = res?.data
        // 预取时不改当前详情的标注状态：来源信息随对象返回，由打开详情的一侧设置
        if (full) {
          // 补全成功：清掉可能残留的失败记录，避免之后误用旧错误文案
          detailErrorRef.current = null
          // 只读快照标记与缓存时间一并挂在预取结果上：点击命中预取缓存时不再发请求，
          // 仍能按实际来源显示离线标注
          full.__partial = !!res?.partial
          full.__cachedAt = res?.fromCache ? res.cachedAt : null
          detailCacheRef.current.set(id, full)
          // 缓存优先：网络刷新完成后更新预取缓存；若用户仍停留在该详情则同步刷新视图
          res.revalidate?.then(fresh => {
            const fd = fresh?.data
            if (!fd) return
            delete fd.__partial
            fd.__cachedAt = null
            detailCacheRef.current.set(id, fd)
            setDetail(prev => (prev && prev.id === fd.id ? fd : prev))
            setDetailOfflineAt(cur => (detailIdRef.current === fd.id ? null : cur))
            if (detailIdRef.current === fd.id) setDetailPartial(false)
          })
          return full
        }
        // 请求成功但无数据：不缓存，允许下次重试
        detailCacheRef.current.delete(id)
        return null
      })
      .catch(e => {
        // 请求失败：不缓存失败结果，否则点击永远命中 null 缓存打不开详情；
        // 记录错误供打开失败时的提示选择文案
        detailCacheRef.current.delete(id)
        detailErrorRef.current = { id, error: e }
        return null
      })
    detailCacheRef.current.set(id, promise)
    return promise
  }, [user])

  const prefetchDetail = useCallback((d) => {
    if (d?.id) fetchDetail(d.id)
  }, [fetchDetail])

  // hover 预取防抖：停留 700ms 才预请求；鼠标按下则立即预请求（不等 hover 时长）
  const {
    onMouseEnter: handleCardMouseEnter,
    onMouseLeave: handleCardMouseLeave,
    onMouseDown: handleCardMouseDown,
  } = useHoverPrefetch(prefetchDetail)

  // 从 hash 打开详情：#/discuss/<id>?comment=<cid>（我的历史跳转 / 刷新保持）
  const openFromHash = useCallback((hash) => {
    // 返回上一帖时由 handleDetailBack 直接复用挂载中的详情，只跳过对应 hash 触发的重开
    if (suppressHashOpenRef.current) {
      if (hash === suppressHashOpenRef.current) {
        suppressHashOpenRef.current = ''
        return
      }
      // 目标 hash 没触发（或被别的导航覆盖）：清掉标记，避免影响后续打开
      suppressHashOpenRef.current = ''
    }
    const m = hash.match(/^#\/discuss\/(\d+)/)
    if (!m) return
    const id = parseInt(m[1], 10)
    const cm = hash.match(/[?&]comment=(\d+)/)
    const commentId = cm ? parseInt(cm[1], 10) : null
    // 已经在这条帖子里：只同步楼层定位，不重新请求/重建详情
    if (detailIdRef.current === id) {
      if (commentId) setDetailCommentId(commentId)
      return
    }

    // 从当前主题帖里的 @提及卡片跳过去：保留来源帖挂载，返回时直接复用
    const entry = peekEntryPoint()
    let keepCurrent = false
    if (entry && entry.target === 'discuss:' + id) {
      const src = entry.hash.match(/^#\/discuss\/(\d+)/)
      if (src && Number(src[1]) === detailIdRef.current) {
        pushDetailLayer(detailRef.current)
        keepCurrent = true
      }
    }
    if (!keepCurrent) clearDetailLayers()

    setDetailLoading(true)
    // 命中 hover/按下预取缓存时秒开详情；未命中则发起请求
    fetchDetail(id)
      .then(full => {
        if (full) {
          setDetail(full)
          setDetailPartial(!!full.__partial)
          // 命中预取缓存时不会重发请求，缓存时间取自预取结果
          setDetailOfflineAt(full.__cachedAt ?? null)
          if (commentId) setDetailCommentId(commentId)
        } else if (detailIdRef.current !== id) {
          // 无数据或请求失败：提示而不是静默退回列表。
          // 若是从列表卡片点进来的（已先用列表项渲染了详情），内容仍在展示，不误报打开失败。
          notifyDetailUnavailable(id)
        } else {
          // 从列表卡片点进来且补全失败：仍在展示列表快照（缺 boosts 等字段），
          // 需要补标只读快照，否则用户会以为看到的是完整详情
          setDetailPartial(true)
        }
      })
      .finally(() => setDetailLoading(false))
  }, [fetchDetail, notifyDetailUnavailable, pushDetailLayer, clearDetailLayers])

  useEffect(() => {
    // 挂载时按 hash 恢复详情路由：openFromHash 需同步置 loading 并发起请求，
    // 属「同步外部系统（hash 路由）」的合法场景，渲染期无法启动副作用，故豁免
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const detailLayers = []
  {
    const seen = new Set()
    for (const d of [...detailStack, detail]) {
      if (!d || seen.has(d.id)) continue
      seen.add(d.id)
      detailLayers.push(d)
    }
  }

  const handleDetailBack = useCallback(() => {
    let entry = peekEntryPoint()
    // entry 不属于当前主题帖（中途从别的页面跳进来）时丢弃，避免返回错页
    if (entry && entry.target && entry.target !== 'discuss:' + detailIdRef.current) {
      discardEntryPoint()
      entry = null
    }
    if (entry) {
      const fromMod = entry.hash.startsWith('#/mod/')
      const m = entry.hash.match(/^#\/discuss\/(\d+)/)
      const fromOtherDiscussion = m && Number(m[1]) !== detailIdRef.current

      if (fromMod) {
        consumeEntryPoint()
        clearDetailLayers()
        setDetail(null)
        setDetailCommentId(commentIdFromHash(entry.hash))
        window.location.hash = entry.hash
        restoreScroll(entry)
        return
      }

      if (fromOtherDiscussion) {
        consumeEntryPoint()
        const prev = popDetailLayer()
        if (prev) {
          // 来源帖一直挂在栈里：切回来即可，评论区不重新加载
          setDetail(prev)
          setDetailPartial(!!prev.__partial)
          setDetailOfflineAt(prev.__cachedAt ?? null)
          setDetailCommentId(commentIdFromHash(entry.hash))
          suppressHashOpenRef.current = entry.hash
          window.location.hash = entry.hash
          restoreScroll(entry)
          return
        }
        // 栈丢失（刷新/外部导航）时退回普通打开流程
        setDetail(null)
        setDetailCommentId(commentIdFromHash(entry.hash))
        window.location.hash = entry.hash
        restoreScroll(entry)
        return
      }
    }
    clearDetailLayers()
    setDetail(null)
    setDetailCommentId(null)
    // 回到「点开详情之前那一页」：通知列表、我的发帖等来源都能原样回去；
    // 没有记录时才退回讨论区列表（历史里有上一页就不该硬编码跳到讨论区）
    const prev = previousView()
    if (prev && !isDetailHash(prev.hash)) {
      restoreView(prev)
      return
    }
    window.location.hash = openedFromMine(window.location.hash)
      ? '#/workshop/my?sub=discussions'
      : '#/workshop/discuss'
  }, [clearDetailLayers, popDetailLayer])

  const { fetchPage, fetchFresh, prefetch, peek, clearCache } = usePagePrefetch(async (p, keyword, sort, order, opts = {}) => {
    const data = await listDiscussions({
      page: p,
      limit: 20,
      search: keyword,
      sort_by: sort,
      sort_order: order,
      user_id: user?.user_id,
    }, opts)
    return { discussions: data.discussions || [], total: data.total || 0, page: data.page || 1, fromCache: data.fromCache, cachedAt: data.cachedAt, revalidate: data.revalidate }
  })

  const fetchList = useCallback(async (p, keyword = search, sort = sortBy, order = sortOrder, opts = {}) => {
    const { force = false } = opts
    // 纪元在缓存命中路径也要递增：否则早先一次请求挂起的 revalidate（旧筛选条件的数据）
    // 会在缓存命中渲染后返回并通过纪元校验，把新筛选条件的列表覆盖回旧结果
    const epoch = ++listEpochRef.current
    if (!force) {
      const cached = peek(p, keyword, sort, order)
      if (cached) {
        setDiscussions(cached.discussions)
        setTotal(cached.total)
        setPage(cached.page)
        setError('')
        // 内存预取页也可能是离线降级产物，保留其缓存标注
        setListOfflineAt(cached.fromCache ? cached.cachedAt : null)
        prefetch(p + 1, keyword, sort, order)
        return
      }
    }
    setLoading(true)
    setError('')
    try {
      const data = force ? await fetchFresh(p, keyword, sort, order) : await fetchPage(p, keyword, sort, order)
      setDiscussions(data.discussions || [])
      setTotal(data.total || 0)
      setPage(data.page || 1)
      setListOfflineAt(data.fromCache ? data.cachedAt : null)
      // 缓存优先：首渲染可能是本地缓存列表，网络刷新完成后替换为最新数据；
      // 纪元已变（用户翻了页/换了条件）则丢弃旧刷新，避免覆盖新视图
      if (data.revalidate) {
        const cachedLatest = latestId(data.discussions)
        // 只有「默认时间倒序的首页」才能用最大帖子 id 判断有没有新帖：
        // 其它排序/搜索/翻页下同一位置的 id 变化不等于有新内容
        const isNewestFeed = p === 1 && !keyword && sort === 'created_at' && order === 'desc'
        data.revalidate.then(fresh => {
          if (!fresh) return
          // 新帖提示不受纪元约束：纪元前进只说明视图被用户改掉了（如恢复持久化的
          // 时间正序），这次默认排序的刷新结果仍足以判断有没有新帖
          if (isNewestFeed && latestId(fresh.discussions) > cachedLatest && !activeRef.current) {
            onNewContentRef.current?.()
          }
          if (epoch !== listEpochRef.current) return
          setDiscussions(fresh.discussions || [])
          setTotal(fresh.total || 0)
          setPage(fresh.page || 1)
          setListOfflineAt(null)
        })
      }
    } catch (e) {
      // 存 Error 对象而非 e.message：AsyncView 需要 dbErrorCode 做差异化翻译
      setError(e)
      setDiscussions([])
      setListOfflineAt(null)
    } finally {
      setLoading(false)
    }
  }, [search, sortBy, sortOrder, peek, fetchPage, fetchFresh, prefetch])

  // 详情内的编辑/投票等更新后同步详情与列表
  const handleDetailUpdated = useCallback((updated) => {
    delete updated.__partial
    updated.__cachedAt = null
    setDetail(updated)
    setDetailPartial(false)
    setDetailOfflineAt(null)
    // 同步更新详情缓存，避免关闭详情后再次点击命中旧数据
    detailCacheRef.current?.set(updated.id, updated)
    clearCache()
    fetchList(1, search, sortBy, sortOrder, { force: true })
  }, [clearCache, fetchList, search, sortBy, sortOrder])

  // 删除成功：从「我的」进来的回「我的发帖」，否则回讨论区列表。
  // 详情已不存在，清空导航栈与详情，并丢弃分页预取缓存
  const handleDetailDeleted = useCallback(() => {
    const fromMine = openedFromMine(window.location.hash)
    detailCacheRef.current?.delete(detailIdRef.current)
    clearDetailLayers()
    setDetail(null)
    setDetailCommentId(null)
    // 失效内存中的分页预取，避免返回讨论区时先闪出已删除的帖子
    clearCache()
    window.location.hash = fromMine ? '#/workshop/my?sub=discussions' : '#/workshop/discuss'
    // 回讨论区才需要立即刷新；回「我的」由 MyDiscussions 变为可见时自行刷新，
    // 避免删除后并发两条慢查询（免费库连接有限）
    if (!fromMine) fetchList(1, search, sortBy, sortOrder, { force: true })
  }, [clearDetailLayers, clearCache, fetchList, search, sortBy, sortOrder])

  const initialFetch = useRef(false)
  // 挂载即拉取：Workshop 用 useTabPrefetch 只挂载当前 + 预加载的下一个 tab（非全挂载），
  // 预加载目标在后台提前请求，切换即时展示；避免冷启动多个页面查询挤在唯一连接上排队
  useEffect(() => {
    if (initialFetch.current) return
    initialFetch.current = true
    fetchList(1)
  }, [fetchList])

  // 常驻挂载下，从隐藏回到可见（再次进入该 tab）时强制刷新，避免列表数据过期；
  // 首次展示（预加载目标）不重复拉取，直接呈现预加载结果。
  // 实现要点：依赖数组仍包含 search/sortBy/sortOrder（保证 force 刷新时读到最新值），
  // 但用 justBecameActive 守卫过滤掉非 active 边沿的重跑——这样用户搜索/排序时
  // fetchList 引用变化触发的 effect 重跑会直接 return，不会额外多拉一次 page 1。
  const wasShown = useRef(false)
  const prevActiveRef = useRef(active)
  useEffect(() => {
    const justBecameActive = active && !prevActiveRef.current
    prevActiveRef.current = active
    if (!justBecameActive) return
    if (wasShown.current) {
      fetchList(1, search, sortBy, sortOrder, { force: true })
    }
    wasShown.current = true
  }, [active, search, sortBy, sortOrder, fetchList])

  // 时间正/倒序持久化到 sqlite config 表（个性化浏览习惯，跨会话保持）
  useEffect(() => {
    const loadSortOrder = async () => {
      try {
        const value = await getConfig('discussion_sort_order')
        if (value === 'asc' || value === 'desc') {
          setSortOrder(value)
          // 恢复的方向非默认时立即按该方向拉取：
          // initialFetch 门控不会因 sortOrder 变化重拉，需显式请求才能让持久化偏好生效
          if (value !== 'desc') {
            fetchList(1, search, sortBy, value, { force: true })
          }
        }
      } catch (e) {
        console.warn('[Discussion] 读取时间排序方向失败:', e)
      }
    }
    loadSortOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveSortOrder = useCallback(async (value) => {
    try {
      await setConfig('discussion_sort_order', value)
    } catch (e) {
      console.warn('[Discussion] 保存时间排序方向失败:', e)
    }
  }, [])

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

  // 退出详情时清空覆盖层测量值（渲染期调整 state，React 官方推荐写法）
  if (!detail && overlayRect !== null) {
    setOverlayRect(null)
  }

  // 详情覆盖层尺寸跟随滚动容器
  useEffect(() => {
    if (!detail) return
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

  const handleSearchSubmit = (value) => {
    setSearch(value)
    setPage(1)
    fetchList(1, value, sortBy, sortOrder, { force: true })
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
          fetchList(1, search, sortBy, sortOrder, { force: true })
        }}
      />
    )
  }

  const totalPages = Math.ceil(total / 20)

  return (
    <div className={styles.root} ref={rootRef}>
      <ListToolbar
        i18nPrefix="discussion"
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={handleSearchSubmit}
        onRefresh={() => fetchList(1, search, sortBy, sortOrder, { force: true })}
        disabled={loading}
        sortOptions={[
          { value: 'created_at', label: t('workshop.sortRecent') },
          { value: 'published_at', label: t('workshop.sortNewest') },
          { value: 'likes', label: t('workshop.sortLikes') },
          { value: 'boosts', label: t('discussion.boostCount', { count: '' }) },
        ]}
        sortBy={sortBy}
        onSortByChange={(v) => { setSortBy(v); setPage(1); fetchList(1, search, v, sortOrder, { force: true }) }}
        sortOrder={sortOrder}
        onSortOrderChange={(v) => { setSortOrder(v); saveSortOrder(v); setPage(1); fetchList(1, search, sortBy, v, { force: true }) }}
        itemsPerRow={itemsPerRow}
        onItemsPerRowChange={handleItemsPerRowChange}
      />

      {listOfflineAt && <OfflineCacheNotice cachedAt={listOfflineAt} />}

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
                  <div ref={gridRef} className={styles.grid} style={{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }}>
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
                          // 点开的这一屏先展示列表快照（无 boosts 等字段）：
                          // 列表本身来自缓存时按缓存时间提示；列表是实时数据时不提示
                          // （避免每次在线点击都闪通知），补全失败再补标只读快照
                          setDetailOfflineAt(listOfflineAt)
                          setDetailPartial(!!listOfflineAt)
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
              { key: 'refresh', icon: <ArrowClockwise24Regular />, onClick: () => fetchList(page, search, sortBy, sortOrder, { force: true }), disabled: loading, label: t('discussion.refresh') },
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
            {detailLayers.map((d, i) => {
              const isTop = i === detailLayers.length - 1
              return (
                <div key={d.id} className={isTop ? styles.detailLayerTop : styles.detailLayerHidden}>
                  <DiscussionDetailPage
                    discussion={d}
                    onBack={isTop ? handleDetailBack : undefined}
                    scrollToCommentId={isTop ? detailCommentId : null}
                    offlineCachedAt={isTop ? detailOfflineAt : (d.__cachedAt ?? null)}
                    offlinePartial={isTop ? detailPartial : !!d.__partial}
                    onUpdated={isTop ? handleDetailUpdated : undefined}
                    onDeleted={isTop ? handleDetailDeleted : undefined}
                    navActive={isTop && active}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default Discussion
