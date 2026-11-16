/* eslint-disable react-refresh/only-export-components */
import {
  createContext, useContext, useState, useCallback, useEffect, useRef, useMemo,
} from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  Toast, ToastTitle, ToastBody, useToastController,
} from '@fluentui/react-components'
import { fetchActiveAnnouncements } from '../services/announcementApi'
import { getAnnouncementReadIds, markAnnouncementRead } from '../services/announcementRead'
import { AnnouncementModal } from '../components/announcement/AnnouncementModal'
import { AnnouncementToaster, ANNOUNCEMENT_TOASTER_ID } from '../components/common/AnnouncementToaster'

const AnnouncementContext = createContext(null)

const TOAST_TIMEOUT_MS = 6000
const MAX_TOASTS_PER_REFRESH = 3
const REFRESH_DEBOUNCE_MS = 600
const FOCUS_REFRESH_MIN_MS = 60_000
const MAX_TIMER_MS = 2_147_483_647

function sortAnnouncements(a, b) {
  return (b.priority || 0) - (a.priority || 0)
    || (b.published_at_ms || 0) - (a.published_at_ms || 0)
    || (b.id || 0) - (a.id || 0)
}

function isLive(item, nowServerMs) {
  return !item.ends_at_ms || item.ends_at_ms > nowServerMs
}

/**
 * 公告展示上下文。
 *
 * 已读/已展示按设备记录在 SQLite（`announcement_reads`）：
 * - modal：未点「不再提醒」就每次启动都弹；在线发布时立即弹，已有弹窗则排队。
 * - banner：首次实际渲染时自动记录，之后永久不再展示。
 * - toast：首次派发时自动记录，之后永久不再提示。
 *
 * 服务端只广播 `scope='announcements'` 的失效信号，正文始终由普通 RPC 重拉。
 */
export function AnnouncementProvider({ children }) {
  const [readIds, setReadIds] = useState(null)
  const [items, setItems] = useState([])
  const [currentModal, setCurrentModal] = useState(null)
  const [banner, setBanner] = useState(null)

  const mountedRef = useRef(true)
  const readIdsRef = useRef(new Set())
  const serverOffsetRef = useRef(0)
  const inFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const refreshTimerRef = useRef(null)
  const expiryTimerRef = useRef(null)
  const lastFocusRefreshRef = useRef(0)
  const sessionShownRef = useRef({ banner: new Set(), toast: new Set() })
  const toastBatchItemsRef = useRef(null)

  const refreshRef = useRef(null)
  const scheduleRefreshRef = useRef(null)

  const dispatchToast = useToastController(ANNOUNCEMENT_TOASTER_ID)

  const markRead = useCallback(async (id) => {
    const numericId = Number(id)
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return

    const next = new Set(readIdsRef.current)
    next.add(numericId)
    readIdsRef.current = next
    setReadIds(next)

    try {
      await markAnnouncementRead(numericId)
    } catch (e) {
      console.warn('[announcement] 写入本机已读失败:', e)
    }
  }, [])

  const refresh = useCallback(async () => {
    if (inFlightRef.current) {
      pendingRefreshRef.current = true
      return
    }
    inFlightRef.current = true
    try {
      const data = await fetchActiveAnnouncements()
      if (!mountedRef.current) return
      serverOffsetRef.current = data.serverMs - Date.now()
      setItems(data.items)
    } catch (e) {
      // 旧服务端没有该命令 / 网络暂时不可达：保持现有内容，静默等待下一次触发。
      console.warn('[announcement] 拉取公告失败:', e)
    } finally {
      inFlightRef.current = false
      if (pendingRefreshRef.current && mountedRef.current) {
        pendingRefreshRef.current = false
        scheduleRefreshRef.current?.(0)
      }
    }
  }, [])

  const scheduleRefresh = useCallback((delay = REFRESH_DEBOUNCE_MS) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      refreshRef.current?.()
    }, delay)
  }, [])

  // 事件回调通过 ref 取最新函数，避免闭包拿到旧状态；ref 只在 effect 里写。
  useEffect(() => {
    refreshRef.current = refresh
    scheduleRefreshRef.current = scheduleRefresh
  }, [refresh, scheduleRefresh])

  // 启动：并行读取本机已读 ID + 拉公告，两者都拿到后才开始展示。
  useEffect(() => {
    mountedRef.current = true
    let disposed = false

    const load = async () => {
      const [ids, data] = await Promise.all([
        getAnnouncementReadIds().catch((e) => {
          console.warn('[announcement] 读取本机已读失败:', e)
          return new Set()
        }),
        fetchActiveAnnouncements().catch((e) => {
          console.warn('[announcement] 首次拉取公告失败:', e)
          return null
        }),
      ])
      if (disposed) return
      readIdsRef.current = ids
      setReadIds(ids)
      if (data) {
        serverOffsetRef.current = data.serverMs - Date.now()
        setItems(data.items)
      }
    }

    load()

    return () => {
      disposed = true
      mountedRef.current = false
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current)
    }
  }, [])

  // 复用现有通知长连接：只监听公告作用域，不新建 WS；重连/网络恢复时补拉一次。
  useEffect(() => {
    let disposed = false
    let unNotify = null
    let unState = null

    listen('cloud-notify', (ev) => {
      if (disposed) return
      if (ev.payload?.scope !== 'announcements') return
      scheduleRefresh()
    })
      .then((un) => {
        if (disposed) un()
        else unNotify = un
      })
      .catch((e) => console.warn('[announcement] 公告事件监听失败:', e))

    listen('cloud-notify-state', (ev) => {
      if (disposed) return
      if (ev.payload?.state === 'connected') scheduleRefresh(0)
    })
      .then((un) => {
        if (disposed) un()
        else unState = un
      })
      .catch((e) => console.warn('[announcement] 连接状态监听失败:', e))

    const refreshOnWake = () => {
      if (disposed) return
      const now = Date.now()
      if (now - lastFocusRefreshRef.current < FOCUS_REFRESH_MIN_MS) return
      lastFocusRefreshRef.current = now
      scheduleRefresh(0)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshOnWake()
    }

    window.addEventListener('online', refreshOnWake)
    window.addEventListener('focus', refreshOnWake)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      unNotify?.()
      unState?.()
      window.removeEventListener('online', refreshOnWake)
      window.removeEventListener('focus', refreshOnWake)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [scheduleRefresh])

  // ends_at_ms 本地到期后立即重拉，让服务端过滤掉已过期公告。
  useEffect(() => {
    if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current)
    expiryTimerRef.current = null
    if (!items.length) return

    const nowServerMs = Date.now() + serverOffsetRef.current
    let nearest = Infinity
    for (const item of items) {
      if (item.ends_at_ms && item.ends_at_ms > nowServerMs) {
        nearest = Math.min(nearest, item.ends_at_ms - nowServerMs)
      }
    }
    if (!Number.isFinite(nearest)) return

    const delay = Math.max(0, nearest) + 1000
    if (delay > MAX_TIMER_MS) return
    expiryTimerRef.current = setTimeout(() => {
      expiryTimerRef.current = null
      // 先本地剔除已到期项，网络不可达时也不会继续展示过期公告。
      if (mountedRef.current) {
        const now = Date.now() + serverOffsetRef.current
        setItems((prev) => prev.filter((item) => !item.ends_at_ms || item.ends_at_ms > now))
      }
      scheduleRefresh(0)
    }, delay)

    return () => {
      if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }
  }, [items, scheduleRefresh])

  // 弹窗排队：已有弹窗不抢占，点掉后才显示下一条（按 priority/published/id 排序）。
  useEffect(() => {
    if (!readIds) return
    const nowServerMs = Date.now() + serverOffsetRef.current
    const candidates = items
      .filter((item) => item.display_type === 'modal'
        && !readIds.has(item.id)
        && isLive(item, nowServerMs))
      .sort(sortAnnouncements)

    if (currentModal) {
      const updated = candidates.find((item) => item.id === currentModal.id)
      if (updated) {
        if (updated !== currentModal) setCurrentModal(updated)
      } else {
        setCurrentModal(candidates[0] || null)
      }
      return
    }
    if (candidates.length) setCurrentModal(candidates[0])
  }, [items, readIds, currentModal])

  // 横幅：同一时刻只显示优先级最高的一条；当前横幅自动记录后仍保持可见，下次启动轮到下一条。
  useEffect(() => {
    if (!readIds) return
    const nowServerMs = Date.now() + serverOffsetRef.current
    const activeBanners = items
      .filter((item) => item.display_type === 'banner' && isLive(item, nowServerMs))
      .sort(sortAnnouncements)

    if (banner) {
      const current = activeBanners.find((item) => item.id === banner.id)
      if (current) {
        if (current !== banner) setBanner(current)
        return
      }
    }

    const next = activeBanners.find((item) => !readIds.has(item.id)) || null
    setBanner(next)
  }, [items, readIds, banner])

  // Toast：首次派发即写本机已读，之后永久不再提示；每次最多 3 条未展示的。
  useEffect(() => {
    if (!readIds) return
    // 同一批 items 只派发一轮：markRead 会触发 readIds 更新重跑本 effect，
    // 不能因此把第 4 条之后未展示的公告也立刻补发。
    if (toastBatchItemsRef.current === items) return
    const nowServerMs = Date.now() + serverOffsetRef.current
    const shown = sessionShownRef.current.toast
    const pending = items
      .filter((item) => item.display_type === 'toast'
        && !readIds.has(item.id)
        && !shown.has(item.id)
        && isLive(item, nowServerMs))
      .sort(sortAnnouncements)
      .slice(0, MAX_TOASTS_PER_REFRESH)

    if (pending.length) toastBatchItemsRef.current = items
    for (const item of pending) {
      shown.add(item.id)
      try {
        dispatchToast(
          <Toast>
            <ToastTitle>{item.title}</ToastTitle>
            {item.body && <ToastBody>{item.body}</ToastBody>}
          </Toast>,
          { intent: 'info', timeout: TOAST_TIMEOUT_MS },
        )
      } catch (e) {
        console.warn('[announcement] 派发 Toast 失败:', e)
      }
      markRead(item.id)
    }
  }, [items, readIds, dispatchToast, markRead])

  const acknowledgeModal = useCallback((id) => {
    setCurrentModal(null)
    markRead(id)
  }, [markRead])

  const markBannerShown = useCallback((id) => {
    const numericId = Number(id)
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return
    const shown = sessionShownRef.current.banner
    if (shown.has(numericId)) return
    shown.add(numericId)
    markRead(numericId)
  }, [markRead])

  const value = useMemo(() => ({
    currentModal,
    banner,
    acknowledgeModal,
    markBannerShown,
    refresh,
  }), [currentModal, banner, acknowledgeModal, markBannerShown, refresh])

  return (
    <AnnouncementContext.Provider value={value}>
      {children}
      <AnnouncementModal announcement={currentModal} onAcknowledge={acknowledgeModal} />
      <AnnouncementToaster />
    </AnnouncementContext.Provider>
  )
}

export function useAnnouncement() {
  const ctx = useContext(AnnouncementContext)
  if (!ctx) throw new Error('useAnnouncement must be used within AnnouncementProvider')
  return ctx
}
