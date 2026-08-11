/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback } from 'react'
import { getUnreadCount } from '../services/workshopApi'

const NotificationContext = createContext(null)

export function NotificationProvider({ children }) {
  // 分类未读数：{ applications, notifications }（点赞/评分无未读概念）
  const [unread, setUnread] = useState({ applications: 0, notifications: 0 })

  const refreshUnread = useCallback(async (userId) => {
    if (!userId) {
      setUnread({ applications: 0, notifications: 0 })
      return
    }
    try {
      const res = await getUnreadCount(userId)
      setUnread({
        applications: res.applications || 0,
        notifications: res.notifications || 0,
      })
    } catch {
      // ignore
    }
  }, [])

  return (
    <NotificationContext.Provider value={{ unread, refreshUnread }}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotification() {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotification must be used within NotificationProvider')
  return ctx
}
