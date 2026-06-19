/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback } from 'react'
import { getUnreadCount } from '../services/workshopApi'

const NotificationContext = createContext(null)

export function NotificationProvider({ children }) {
  const [unreadCount, setUnreadCount] = useState(0)

  const refreshUnread = useCallback(async (userId) => {
    if (!userId) {
      setUnreadCount(0)
      return
    }
    try {
      const res = await getUnreadCount(userId)
      setUnreadCount(res.total || 0)
    } catch {
      // ignore
    }
  }, [])

  return (
    <NotificationContext.Provider value={{ unreadCount, refreshUnread }}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotification() {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotification must be used within NotificationProvider')
  return ctx
}
