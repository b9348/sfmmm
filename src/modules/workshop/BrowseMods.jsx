import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Text,
  Spinner,
  Button,
  tokens,
  makeStyles,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger,
  Toast, ToastBody, ToastTitle, useToastController,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  Add24Regular,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { listMods, getModDetail, getModForEdit, getDeviceId } from '../../services/workshopApi'
import { formatDbError, isConnectivityError } from '../../services/dbCall'
import ModDetailPage from './ModDetailPage'
import { useAuth } from '../../contexts/useAuth'
import { useUserNav } from '../../contexts/useUserNav'
import { usePagePrefetch } from '../../hooks/usePagePrefetch'
import { useGridColumns } from '../../hooks/useGridColumns'
import { usePersistedNumber } from '../../hooks/usePersistedNumber'
import { useHoverPrefetch } from '../../hooks/useHoverPrefetch'
import { EditModPage, CreateModPage } from './ModEditorPage'
import { getConfig, setConfig } from '../../services/dbHelper'
import { checkV2Prereq } from '../../services/v2PrereqCheck'
import { Pagination, AsyncView, LoginDialog, FloatingActions, EmptyState, OfflineCacheNotice, ListToolbar, CategorySelect, GameVersionBanner } from '../../components'
import { useGameVersionGuard } from '../../components/common/useGameVersionGuard'
import { ModCard } from './ModCard'
import { commentIdFromHash, consumeEntryPoint, discardEntryPoint, peekEntryPoint, restoreScroll } from '../../utils/navReturn'
import { isDetailHash, previousView, restoreView } from '../../utils/navHistory'
import { usePlatform } from '../../hooks/usePlatform'

// 列表页可选的排序值；旧的 rating / published_at 会被归一化回「最近更新」
const BROWSE_SORT_VALUES = ['created_at', 'likes']

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
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
  // 详情导航栈：最上层直接成为 overlay 的 flex 子项，下层保持挂载但隐藏
  detailLayerTop: {
    display: 'contents',
  },
  detailLayerHidden: {
    display: 'none',
  },
  // 编辑覆盖层：盖在详情覆盖层之上而不是替换整页，
  // 保持 ModDetailPage/CommentSection 挂载，取消编辑后停留在原浏览位置
  editOverlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 1001,
    backgroundColor: tokens.colorNeutralBackground2,
    overflow: 'auto',
    padding: '8px 16px 16px',
  },
  })

export function BrowseMods({ initialModId, initialCommentId, onConsumeNavTarget, onDetailOpenChange, active = true }) {
  const onConsumeRef = useRef(onConsumeNavTarget)
  useEffect(() => { onConsumeRef.current = onConsumeNavTarget }, [onConsumeNavTarget])
  const styles = useStyles()
  const { t } = useTranslation()
  const { user, isLoggedIn } = useAuth()
  // 手机端不提供「发布 MOD」：编辑器依赖 PC 文件选择与本地打包
  const { isMobile } = usePlatform()
  const deviceIdRef = useRef(getDeviceId())
  // 只读一次原始值：后续持久化 effect 会把 sessionStorage 覆盖成归一化后的 sortBy，
  // 而排序方向迁移需要在覆盖前判断旧值是否为 rating / published_at。
  const [savedBrowseSort] = useState(() => sessionStorage.getItem('workshop_browse_sort') || '')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState(() => (
    BROWSE_SORT_VALUES.includes(savedBrowseSort) ? savedBrowseSort : 'created_at'
  ))
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
  // 离线缓存标注时间戳：列表/详情来自 SQLite 缓存（断连降级）时非 null
  const [listOfflineAt, setListOfflineAt] = useState(null)
  const [detailOfflineAt, setDetailOfflineAt] = useState(null)
  const [detailPartial, setDetailPartial] = useState(false)
  const [detailMod, setDetailMod] = useState(null)
  const [detailCommentId, setDetailCommentId] = useState(null)
  const [detailLoading, setDetailLoading] = useState(!!initialModId)
  const modStackRef = useRef([]) // 导航栈：返回上一页而非列表
  // 栈的镜像 state：仅用于渲染被压在下面的详情，保证返回时不卸载 CommentSection
  const [modStackView, setModStackView] = useState([])
  // 保活层数上限：超出后丢弃最旧的一层（返回那一层时走普通重建）
  const MAX_DETAIL_LAYERS = 5
  const pushModStack = useCallback((m) => {
    if (!m) return
    const last = modStackRef.current[modStackRef.current.length - 1]
    if (last && last.id === m.id) return
    modStackRef.current.push(m)
    while (modStackRef.current.length > MAX_DETAIL_LAYERS) modStackRef.current.shift()
    setModStackView([...modStackRef.current])
  }, [])
  const popModStack = useCallback(() => {
    const m = modStackRef.current.pop()
    setModStackView([...modStackRef.current])
    return m
  }, [])
  const clearModStack = useCallback(() => {
    modStackRef.current = []
    setModStackView([])
  }, [])
  // detailMod 快照：hash/导航进入详情的 effect 只在挂载与导航参数变化时执行，
  // 仅需当时的 detailMod 值压导航栈；直接加依赖会因 setDetailMod 触发 effect 重跑（重复拉取）
  const detailModRef = useRef(detailMod)
  useEffect(() => { detailModRef.current = detailMod }, [detailMod])
  // 当前展示详情的 mod id（effect 同步）：revalidate 回来时据此判断详情是否仍在展示该 mod，
  // 避免旧请求的网络刷新覆盖用户已切换到的其他详情
  const detailIdRef = useRef(null)
  useEffect(() => { detailIdRef.current = detailMod?.id ?? null }, [detailMod])
  // 窄屏：详情覆盖层打开时页面要收起顶部 tabs 行（整屏让给详情）
  useEffect(() => {
    onDetailOpenChange?.(!!detailMod)
  }, [detailMod, onDetailOpenChange])
  // 由点击自己打开详情时记下目标 hash，跳过 hashchange 的重复打开
  const suppressHashOpenRef = useRef('')
  // 列表请求纪元：每次发起网络取数自增；revalidate 完成时纪元已变说明用户已翻页/换条件，丢弃旧刷新
  const listEpochRef = useRef(0)
  const [editingMod, setEditingMod] = useState(null)
  const [showCreatePage, setShowCreatePage] = useState(false)
  const [itemsPerRow, handleItemsPerRowChange] = usePersistedNumber('workshop_items_per_row', { defaultValue: 3, logTag: 'BrowseMods' })
  const [gridRef, gridColumns] = useGridColumns(itemsPerRow)
  const initialFetch = useRef(false)
  const rootRef = useRef(null)
  const [overlayRect, setOverlayRect] = useState(null)

  // v2 前置更新提醒（云页 Dialog）：本页激活时检测一次，旧版且未点过「知道了」则弹出。
  // 「知道了」写 config 永久静默；「前往更新」跳本地模组 v2 页（不写已读——更新成功后
  // 检测自然转 false，失败则下次进页继续提醒）。
  const [showV2Update, setShowV2Update] = useState(false)
  // 要求版本由 Rust 检测命令返回（基准定义在 commands/v2_prereq.rs），前端不硬编码
  const [v2Required, setV2Required] = useState('')
  const { openLocalMods, openSettings } = useUserNav()
  // 游戏版本过低：云列表顶部高亮横幅提示（不阻断浏览，安装入口在详情页置灰）
  const gate = useGameVersionGuard()
  useEffect(() => {
    if (!active) return
    let cancelled = false
    ;(async () => {
      try {
        const [seen, gamePath] = await Promise.all([
          getConfig('v2_update_reminder_seen'),
          getConfig('game_path'),
        ])
        if (cancelled || !gamePath || seen === '1') return
        const { outdated, required } = await checkV2Prereq(gamePath.replace(/\\/g, '/'))
        if (!cancelled && outdated) {
          setV2Required(required)
          setShowV2Update(true)
        }
      } catch { /* 检测失败静默，不打扰浏览 */ }
    })()
    return () => { cancelled = true }
  }, [active])
  const dismissV2Update = useCallback(async () => {
    setShowV2Update(false)
    try { await setConfig('v2_update_reminder_seen', '1') } catch { /* 记录失败仅影响静默 */ }
  }, [])
  const goUpdateV2 = useCallback(() => {
    setShowV2Update(false)
    openLocalMods('v2')
  }, [openLocalMods])

  // 详情打开失败（离线且没有缓存 / 已删除 / 云端报错）时给出明确提示：
  // 详情 overlay 只有拿到数据才渲染，否则会静默停在列表页，用户不知道发生了什么。
  const { dispatchToast } = useToastController()
  // t 随界面语言切换而变化；用 ref 取最新值，避免把它塞进 effect 依赖导致
  // 切语言时重跑「恢复 hash 详情」的 effect、多发一次详情请求
  const tRef = useRef(t)
  useEffect(() => { tRef.current = t }, [t])
  // { id, error }：fetchDetail 失败时记录，供提示按错误类型选文案
  const detailErrorRef = useRef(null)
  const notifyDetailUnavailable = useCallback((modId) => {
    const rec = detailErrorRef.current
    const err = rec && rec.id === modId ? rec.error : null
    const tt = tRef.current
    // 云端不可达时说明「尚未缓存」；其他错误（已删除、无权限等）直接展示后端信息
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

  // 打开一个 mod 详情：点击卡片、hash 恢复（刷新 / 侧键前进）、外部导航共用。
  // modId 可能是数字 id（来自用户资料卡）或 mod_key 字符串（来自本地预览页菜单），
  // 非数字时作为 mod_key 传入，后端按 mod_key 解析详情。
  const openDetailById = useCallback((modId, commentId, { fromNav = false } = {}) => {
    if (!modId) return
    const modKey = Number.isFinite(Number(modId)) ? null : modId
    // 从外部导航（资料弹窗等）进入时，保存当前 mod 到导航栈，返回时回到上一页。
    // 同一个 mod 的重复导航（user 变化导致重跑等）不再压栈
    const current = detailModRef.current
    const sameTarget = current && (
      String(current.id) === String(modId) || current.mod_key === modId
    )
    if (fromNav && current && !sameTarget) {
      pushModStack(current)
    }
    setDetailLoading(true)
    getModDetail(modId, 'zh', user?.user_id, deviceIdRef.current, modKey)
      .then(data => {
        if (data.data?.mod) {
          // 打开成功：清掉可能残留的失败记录，避免之后「成功但无数据」误用旧错误文案
          detailErrorRef.current = null
          const m = data.data.mod
          // 供返回导航复用：回到该详情时仍能恢复离线标注
          m.__partial = !!data.partial
          m.__cachedAt = data.fromCache ? data.cachedAt : null
          setDetailMod(m)
          setDetailOfflineAt(m.__cachedAt)
          setDetailPartial(m.__partial)
          if (commentId) setDetailCommentId(commentId)
          // 缓存优先：先展示了本地缓存详情，网络刷新完成后替换为最新数据
          data.revalidate?.then(fresh => {
            const fm = fresh?.data?.mod
            if (!fm) return
            // 同步清掉返回栈里同一对象的快照标记，避免回退后仍显示「只读快照」
            m.__partial = false
            m.__cachedAt = null
            setDetailMod(prev => (prev && prev.id === fm.id ? fm : prev))
            setDetailOfflineAt(cur => (detailIdRef.current === fm.id ? null : cur))
            if (detailIdRef.current === fm.id) setDetailPartial(false)
          })
        } else {
          // 成功但无数据（内容已删除等）：给出提示，避免静默停在列表
          notifyDetailUnavailable(modId)
        }
      })
      .catch(e => {
        detailErrorRef.current = { id: modId, error: e }
        notifyDetailUnavailable(modId)
      })
      .finally(() => {
        setDetailLoading(false)
        // 导航意图已消费，清除 navTarget，避免下次进入创意工坊标签时重放上次详情
        if (fromNav) onConsumeRef.current?.()
      })
  }, [user, notifyDetailUnavailable, pushModStack])

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
    // 按 hash 恢复详情属「同步外部系统（hash 路由）」：打开即置 loading 并发请求，
    // 渲染期无法启动副作用（与 Discussion 的同名恢复逻辑一致），故豁免
    // eslint-disable-next-line react-hooks/set-state-in-effect
    openDetailById(modId, commentId, { fromNav: !!initialModId })
  }, [initialModId, initialCommentId, openDetailById])

  // hash 变回 #/mod/<id>（鼠标侧键前进、侧栏跳转）时重新打开该详情。
  // 点击卡片自己已经开过详情，用 suppressHashOpenRef 跳过这一次，避免重复请求。
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash
      if (suppressHashOpenRef.current) {
        if (hash === suppressHashOpenRef.current) {
          suppressHashOpenRef.current = ''
          return
        }
        suppressHashOpenRef.current = ''
      }
      const m = hash.match(/^#\/mod\/(\d+)/)
      if (!m) return
      const modId = parseInt(m[1], 10)
      if (detailIdRef.current === modId) return
      openDetailById(modId, commentIdFromHash(hash))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [openDetailById])

  // 详情预取缓存：hover 卡片时预请求，点击命中缓存秒开详情
  const detailCacheRef = useRef(new Map()) // mod.id -> Promise<mod> | mod（请求完成后替换为结果）
  const fetchDetail = useCallback((modId) => {
    const cached = detailCacheRef.current.get(modId)
    if (cached) return Promise.resolve(cached)
    const promise = getModDetail(modId, 'zh', user?.user_id, deviceIdRef.current)
      .then(data => {
        const full = data?.data?.mod
        // 预取时不改当前详情的标注状态：结果里的来源信息随对象返回，
        // 由真正打开详情的一侧设置，避免 hover 预取覆盖别的详情
        if (full) {
          // 补全成功：清掉可能残留的失败记录
          detailErrorRef.current = null
          // 把「只读快照」标记与缓存时间挂在预取结果上：点击命中预取缓存时不再发请求，
          // 仍能按实际来源显示离线标注
          full.__partial = !!data?.partial
          full.__cachedAt = data?.fromCache ? data.cachedAt : null
          detailCacheRef.current.set(modId, full)
        }
        // 缓存优先：网络刷新完成后更新预取缓存；若用户仍停留在该详情页则同步刷新视图
        if (data?.revalidate) {
          data.revalidate.then(fresh => {
            const fm = fresh?.data?.mod
            if (!fm) return
            delete fm.__partial
            fm.__cachedAt = null
            // 返回栈里可能还留着同一份预取对象
            if (full) {
              full.__partial = false
              full.__cachedAt = null
            }
            detailCacheRef.current.set(modId, fm)
            setDetailMod(prev => (prev && prev.id === fm.id ? fm : prev))
            setDetailOfflineAt(cur => (detailIdRef.current === fm.id ? null : cur))
            if (detailIdRef.current === fm.id) setDetailPartial(false)
          })
        }
        return full || null
      })
      .catch(e => {
        // 失败结果不缓存（否则点击永远命中 null 缓存打不开详情），
        // 记录错误供打开失败时的提示选择文案
        detailCacheRef.current.delete(modId)
        detailErrorRef.current = { id: modId, error: e }
        return null
      })
    detailCacheRef.current.set(modId, promise)
    return promise
  }, [user])
  const prefetchDetail = useCallback((mod) => {
    if (mod?.id) fetchDetail(mod.id)
  }, [fetchDetail])

  // hover 预取防抖：停留 700ms 才预请求；鼠标按下则立即预请求（不等 hover 时长）
  const {
    onMouseEnter: handleCardMouseEnter,
    onMouseLeave: handleCardMouseLeave,
    onMouseDown: handleCardMouseDown,
  } = useHoverPrefetch(prefetchDetail)

  // 分页预请求：当前页就绪后自动预请求下一页，翻页命中缓存免等待
  const { fetchPage, fetchFresh, prefetch, peek, clearCache } = usePagePrefetch(async (p, keyword, cat, sort, order, opts = {}) => {
    const data = await listMods({
      lang: 'zh',
      search: keyword,
      page: p,
      limit: 20,
      sort_by: sort,
      sort_order: order,
      device_id: deviceIdRef.current,
      category: cat,
    }, opts)
    return { mods: data.mods || [], total: data.total || 0, page: data.page || 1, fromCache: data.fromCache, cachedAt: data.cachedAt, revalidate: data.revalidate }
  })

  const fetchMods = useCallback(async (p, keyword = search, cat = categoryFilter, sort = sortBy, order = sortOrder, opts = {}) => {
    const { force = false } = opts
    // 纪元在缓存命中路径也要递增：否则早先一次请求挂起的 revalidate（旧筛选条件的数据）
    // 会在缓存命中渲染后返回并通过纪元校验，把新筛选条件的列表覆盖回旧结果
    const epoch = ++listEpochRef.current
    // 命中预请求缓存：免 loading 直接渲染，并继续预请求下一页维持预取链
    if (!force) {
      const cached = peek(p, keyword, cat, sort, order)
      if (cached) {
        setMods(cached.mods)
        setTotal(cached.total)
        setPage(cached.page)
        setError('')
        // 内存预取页也可能是离线降级产物，保留其缓存标注
        setListOfflineAt(cached.fromCache ? cached.cachedAt : null)
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
      setListOfflineAt(data.fromCache ? data.cachedAt : null)
      // 缓存优先：首渲染可能是本地缓存列表，网络刷新完成后替换为最新数据；
      // 纪元已变（用户翻了页/换了条件）则丢弃旧刷新，避免覆盖新视图
      if (data.revalidate) {
        data.revalidate.then(fresh => {
          if (!fresh || epoch !== listEpochRef.current) return
          setMods(fresh.mods || [])
          setTotal(fresh.total || 0)
          setPage(fresh.page || 1)
          setListOfflineAt(null)
        })
      }
    } catch (e) {
      // 存 Error 对象而非 e.message：AsyncView 需要 dbErrorCode 做差异化翻译
      setError(e)
      setMods([])
      setListOfflineAt(null)
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
          const savedSort = savedBrowseSort
          // 空值表示没有历史排序选择，不触发迁移，保留已持久化的方向偏好
          const savedSortWasLegacy = savedSort !== '' && !BROWSE_SORT_VALUES.includes(savedSort)
          const effectiveOrder = savedSortWasLegacy ? 'desc' : value
          setSortOrder(effectiveOrder)
          if (savedSortWasLegacy && value !== 'desc') {
            // 旧排序值已归一化为「最近更新」，持久化的 asc 一并重置，
            // 避免下次启动时又回到「最早在前」。
            setConfig('workshop_browse_sort_order', 'desc').catch((e) => {
              console.warn('[BrowseMods] 归一化时间排序方向失败:', e)
            })
          }
          // 恢复的方向非默认时立即按该方向拉取：
          // initialFetch 门控不会因 sortOrder 变化重拉，需显式请求才能让持久化偏好生效
          if (effectiveOrder !== 'desc') {
            fetchMods(1, search, categoryFilter, sortBy, effectiveOrder, { force: true })
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

  // 退出详情时清空覆盖层测量值（渲染期调整 state，React 官方推荐写法）
  if (!detailMod && overlayRect !== null) {
    setOverlayRect(null)
  }

  useEffect(() => {
    if (!detailMod) return
    const content = getContentEl()
    if (!content) return
    const compute = () => {
      const r = content.getBoundingClientRect()
      // 页面 tabs 与内容区之间是父级 flex 的 row-gap 留白。覆盖层要把这段留白一起盖住，
      // 否则详情导航栏吸顶后会与 tabs 之间空出一条缝（切页时还会露出列表的底边）。
      // 窄屏详情打开时 tabs 行已被收起，此时没有留白可盖：没有上一个兄弟节点就按 0 算。
      const gap = content.previousElementSibling
        ? (parseFloat(window.getComputedStyle(content.parentElement).rowGap) || 0)
        : 0
      setOverlayRect({
        top: r.top - gap,
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
    // 编辑覆盖层打开时侧键返回会直接关详情：同步清掉编辑态，避免下次打开详情残留编辑器
    setEditingMod(null)
    let entry = peekEntryPoint()
    // entry 可能属于更早的跳转（用户中途从列表打开了别的 mod）：不匹配就丢弃
    if (entry) {
      const cur = detailModRef.current
      const target = entry.target || ''
      const matches = cur && (
        target === 'mod:' + cur.id
        || (cur.mod_key && target === 'mod:' + cur.mod_key)
      )
      if (!matches) {
        discardEntryPoint()
        entry = null
      }
    }

    // 来自讨论区正文的提及卡片：回到那个主题帖，并恢复它的滚动位置
    if (entry && entry.hash.startsWith('#/discuss/')) {
      consumeEntryPoint()
      // 跨页签跳转时栈里可能残留「之前看过的 mod 详情」，已离开那条链路，清掉
      clearModStack()
      setDetailMod(null)
      setDetailCommentId(null)
      window.location.hash = entry.hash
      restoreScroll(entry)
      return
    }

    // 来自另一个 mod 详情的提及卡片：回到上一详情并恢复入口位置
    if (entry && entry.hash.startsWith('#/mod/') && modStackRef.current.length > 0) {
      consumeEntryPoint()
      const prevMod = popModStack()
      window.location.hash = `#/mod/${prevMod.id}`
      setDetailMod(prevMod)
      // 恢复上一详情自身的快照标记，避免沿用当前详情的「只读快照」提示
      setDetailPartial(!!prevMod.__partial)
      setDetailOfflineAt(prevMod.__cachedAt ?? null)
      setDetailCommentId(commentIdFromHash(entry.hash))
      restoreScroll(entry)
      return
    }

    if (modStackRef.current.length > 0) {
      const prevMod = popModStack()
      window.location.hash = `#/mod/${prevMod.id}`
      setDetailMod(prevMod)
      // 恢复上一详情自身的快照标记，避免沿用当前详情的「只读快照」提示
      setDetailPartial(!!prevMod.__partial)
      setDetailOfflineAt(prevMod.__cachedAt ?? null)
      setDetailCommentId(null)
    } else {
      setDetailMod(null)
      setDetailCommentId(null)
      // 回到「点开详情之前那一页」：记录里有就按记录恢复（通知列表页、讨论区、
      // 云列表的某个子 tab 都能原样回去），没有才退回工坊列表。
      // 这里不能只清成空 hash —— 那会落回云列表，从通知/点赞页点进来的用户会迷路。
      const prev = previousView()
      if (prev && !isDetailHash(prev.hash)) {
        restoreView(prev)
        return
      }
      window.location.hash = ''
    }
  }, [popModStack, clearModStack])

  // 栈里的详情 + 当前详情，按 id 去重（导航刚发起、目标详情还没回来时两者可能相同）
  const detailLayers = []
  if (detailMod) {
    const seen = new Set()
    for (const m of [...modStackView, detailMod]) {
      if (!m || seen.has(m.id)) continue
      seen.add(m.id)
      detailLayers.push(m)
    }
  }

  const handleSearchSubmit = (value) => {
    setSearch(value)
    setPage(1)
    fetchMods(1, value)
  }

  // 编辑/发布后用接口重拉详情：写操作已失效本地缓存，force 跳过缓存避免展示旧数据
  const refreshDetailMod = useCallback(async (modId) => {
    try {
      const res = await getModDetail(modId, 'zh', user?.user_id, deviceIdRef.current, null, { force: true })
      const fresh = res.data?.mod
      if (!fresh) return
      // force 在断连时仍会降级返回缓存内容：按实际来源回写标注，
      // 否则会把旧快照当成刚拉到的实时数据、同时残留「只读快照」标记
      const partial = !!res.partial
      fresh.__partial = partial
      fresh.__cachedAt = res.fromCache ? res.cachedAt : null
      detailCacheRef.current.set(modId, fresh)
      setDetailMod(prev => (prev && prev.id === fresh.id ? fresh : prev))
      if (detailIdRef.current === fresh.id) {
        setDetailOfflineAt(fresh.__cachedAt)
        setDetailPartial(partial)
      }
    } catch {
      // 刷新失败静默：保留当前内容，网络指示灯会提示
    }
  }, [user])

  const handleEdit = async (mod) => {
    try {
      // dev（pnpm tauri dev）：强制编辑，跳过后端归属/权限校验
      const res = await getModForEdit(mod.id, user?.user_id || 0, import.meta.env.DEV)
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
        onCreated={() => {
          setShowCreatePage(false)
          // 新发布：清空分页预取缓存并强制刷新列表
          clearCache()
          fetchMods(1, search, categoryFilter, sortBy, sortOrder, { force: true })
        }}
      />
    )
  }

  if (detailLoading && !detailMod) {
    return <Spinner size="large" label={t('workshop.loading')} style={{ marginTop: '40px' }} />
  }

  const totalPages = Math.ceil(total / 20)

  return (
    <div className={styles.root} ref={rootRef}>
      <ListToolbar
        i18nPrefix="workshop"
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={handleSearchSubmit}
        onRefresh={() => fetchMods(1, search, categoryFilter, sortBy, sortOrder, { force: true })}
        disabled={loading}
        sortOptions={[
          { value: 'created_at', label: t('workshop.sortRecent') },
          { value: 'likes', label: t('workshop.sortLikes') },
        ]}
        sortBy={sortBy}
        onSortByChange={(v) => { setSortBy(v); setPage(1); fetchMods(1, search, categoryFilter, v, sortOrder) }}
        sortOrder={sortOrder}
        onSortOrderChange={(v) => { setSortOrder(v); saveSortOrder(v); setPage(1); fetchMods(1, search, categoryFilter, sortBy, v) }}
        itemsPerRow={itemsPerRow}
        onItemsPerRowChange={handleItemsPerRowChange}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Text size="small">{t('workshop.type')}</Text>
          <CategorySelect
            value={categoryFilter}
            includeAll
            disabled={loading}
            onChange={(v) => { setCategoryFilter(v); setPage(1); fetchMods(1, search, v, sortBy, sortOrder) }}
          />
        </div>
      </ListToolbar>

      {gate.status === 'blocked' && (
        <GameVersionBanner version={gate.version} required={gate.required} onGoSettings={openSettings} />
      )}

      {listOfflineAt && <OfflineCacheNotice cachedAt={listOfflineAt} />}

      <AsyncView loading={loading} error={error} onRetry={() => fetchMods(1)} loadingLabel={t('workshop.loading')}>
        {mods.length === 0 ? (
          <EmptyState
            title={t('workshop.noMods')}
            description={search ? t('workshop.noMatchHint') : t('workshop.noUploads')}
          />
        ) : (
          <>
            <div ref={gridRef} className={styles.grid} style={{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }}>
              {mods.map(mod => (
                <ModCard
                  key={mod.id}
                  mod={mod}
                  onMouseEnter={() => handleCardMouseEnter(mod)}
                  onMouseLeave={handleCardMouseLeave}
                  onMouseDown={() => handleCardMouseDown(mod)}
                  onClick={() => {
                    if (detailMod) pushModStack(detailMod)
                    const hash = `#/mod/${mod.id}`
                    // 这一跳由点击自己开详情，跳过 hashchange 的重复打开
                    suppressHashOpenRef.current = hash
                    window.location.hash = hash
                    setDetailMod(mod)
                    // 点开的这一屏先展示列表快照，内容天然是只读的：
                    // 列表本身来自缓存时按缓存时间提示；列表是实时数据时不提示
                    // 补全失败时补标只读快照，成功后按实际来源覆盖
                    setDetailOfflineAt(listOfflineAt)
                    setDetailPartial(!!listOfflineAt)
                    // 命中 hover/按下预取缓存时秒开详情；未命中则发起请求
                    fetchDetail(mod.id).then(full => {
                      if (full) {
                        setDetailMod(full)
                        setDetailPartial(!!full.__partial)
                        // 命中预取缓存时不会重发请求，缓存时间取自预取结果
                        setDetailOfflineAt(full.__cachedAt ?? null)
                      } else if (detailIdRef.current === mod.id) {
                        // 补全失败：仍在展示列表快照（缺评分/权限等字段），补标只读快照
                        setDetailPartial(true)
                      }
                    })
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
        ...(isMobile ? [] : [{ key: 'publish', icon: <Add24Regular />, appearance: 'primary', onClick: handlePublishClick, label: t('workshop.publishMod') }]),
      ]} />

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={handleLoginSuccess} />

      {/* v2 前置更新提醒 Dialog */}
      <Dialog open={showV2Update}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('mods.v2UpdateTitle')}</DialogTitle>
            <DialogContent>
              <Text size="small">{t('mods.v2Outdated', { version: v2Required })}</Text>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button size="small" appearance="secondary" onClick={dismissV2Update}>{t('guide.gotIt')}</Button>
              </DialogTrigger>
              <Button size="small" appearance="primary" onClick={goUpdateV2}>{t('mods.v2GoUpdate')}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {detailMod && overlayRect && (
        <div
          className={styles.detailOverlay}
          style={{ top: overlayRect.top, left: overlayRect.left, right: overlayRect.right, bottom: overlayRect.bottom }}
        >
          {detailLayers.map((m, i) => {
            const isTop = i === detailLayers.length - 1
            return (
              <div key={m.id} className={isTop ? styles.detailLayerTop : styles.detailLayerHidden}>
                <ModDetailPage
                  mod={m}
                  onBack={isTop ? handleDetailBack : undefined}
                  onEdit={isTop ? handleEdit : undefined}
                  onDeleted={isTop ? () => fetchMods(page, search, categoryFilter, sortBy, sortOrder, { force: true }) : undefined}
                  scrollToCommentId={isTop ? detailCommentId : null}
                  offlineCachedAt={isTop ? detailOfflineAt : (m.__cachedAt ?? null)}
                  offlinePartial={isTop ? detailPartial : !!m.__partial}
                  navActive={isTop && active}
                />
              </div>
            )
          })}
          {editingMod && (
            <div className={styles.editOverlay}>
              <EditModPage
                mod={editingMod}
                onClose={() => setEditingMod(null)}
                onUpdated={() => {
                  const editedId = editingMod.id
                  setEditingMod(null)
                  // 编辑保存：列表缓存已失效，强制刷新；若详情覆盖层仍开着，同步用接口重拉最新详情
                  clearCache()
                  fetchMods(page, search, categoryFilter, sortBy, sortOrder, { force: true })
                  if (detailModRef.current?.id === editedId) refreshDetailMod(editedId)
                }}
                onRefresh={() => {
                  // 选择性替换发布成功：刷新列表/详情，但不关闭编辑器
                  const editedId = editingMod.id
                  clearCache()
                  fetchMods(page, search, categoryFilter, sortBy, sortOrder, { force: true })
                  if (detailModRef.current?.id === editedId) refreshDetailMod(editedId)
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
