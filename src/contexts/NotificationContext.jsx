/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getUnreadCount } from '../services/workshopApi'
import { useAuth } from './useAuth'
import { setWsState as pushWsState } from '../services/netStatus'

const NotificationContext = createContext(null)

export function NotificationProvider({ children }) {
  const { user } = useAuth()
  // 分类未读数：{ applications, notifications, messages }（点赞/评分无未读概念）
  const [unread, setUnread] = useState({ applications: 0, notifications: 0, messages: 0 })
  // 每次收到推送或重连成功 +1：通知页据此刷新可见列表（不做业务去重）
  const [notifySeq, setNotifySeq] = useState(0)
  // 通知长连接状态；同时写入 netStatus 信号灯，不单独做诊断入口
  const [wsState, setWsState] = useState(null)

  const refreshUnread = useCallback(async (userId) => {
    if (!userId) {
      setUnread({ applications: 0, notifications: 0, messages: 0 })
      return
    }
    try {
      const res = await getUnreadCount(userId)
      setUnread({
        applications: res.applications || 0,
        notifications: res.notifications || 0,
        messages: res.messages || 0,
      })
    } catch {
      // ignore
    }
  }, [])

  // 事件回调里不直接依赖最新闭包：用 ref 拿当前登录用户与刷新函数
  const userRef = useRef(user)
  const refreshRef = useRef(refreshUnread)
  useEffect(() => {
    userRef.current = user
  }, [user])
  useEffect(() => {
    refreshRef.current = refreshUnread
  }, [refreshUnread])

  useEffect(() => {
    let disposed = false
    let unNotify = null
    let unState = null
    let timer = null

    const bump = () => {
      if (disposed) return
      const userId = userRef.current?.user_id
      if (!userId) return
      setNotifySeq((seq) => seq + 1)
      refreshRef.current(userId)
    }
    // 一次事件风暴（多人同时评论）合并成一次刷新
    const scheduleRefresh = () => {
      if (!userRef.current?.user_id) return
      clearTimeout(timer)
      timer = setTimeout(bump, 500)
    }

    listen('cloud-notify', (ev) => {
      // 公告广播复用同一通道，但只触发公告重拉，不刷新通知未读数。
      if (ev.payload?.scope === 'announcements') return
      scheduleRefresh()
    })
      .then((un) => {
        if (disposed) un()
        else unNotify = un
      })
      .catch((e) => console.warn('[notify] 通知事件监听失败:', e))

    listen('cloud-notify-state', (ev) => {
      if (disposed) return
      const payload = ev.payload || {}
      setWsState(payload.state || null)
      // 复用全局信号灯：推送掉线/鉴权失效直接反映到同一颗灯
      pushWsState(payload)
      // 重连成功后补偿一次：断线期间的事件已经丢了
      if (payload.state === 'connected') scheduleRefresh()
    })
      .then((un) => {
        if (disposed) un()
        else unState = un
      })
      .catch((e) => console.warn('[notify] 连接状态监听失败:', e))

    // 网络恢复：提前结束退避，不必等满 60s
    const onOnline = () => {
      invoke('notify_ws_wake').catch(() => {})
    }
    window.addEventListener('online', onOnline)
    // React 可能晚于 Rust 建连才订阅：主动取一次最近状态，避免信号灯停在 unknown
    onOnline()

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      unNotify?.()
      unState?.()
      window.removeEventListener('online', onOnline)
    }
  }, [])

  return (
    <NotificationContext.Provider value={{ unread, refreshUnread, notifySeq, wsState }}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotification() {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotification must be used within NotificationProvider')
  return ctx
}
