import { useState, useEffect, useCallback } from 'react'
import AuthContext from './AuthContext'
import { loadUserFromDb, saveUserToDb, clearUserFromDb } from './authHelpers'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const saved = await loadUserFromDb()
      if (cancelled) return
      if (saved) {
        setUser(saved)
      }
      setInitialized(true)
    })()
    return () => { cancelled = true }
  }, [])

  const loginSuccess = useCallback(async (userData) => {
    // userData = { user_id, username, r2_enabled, avatar }
    const user = { user_id: userData.user_id, username: userData.username, r2_enabled: !!userData.r2_enabled, avatar: userData.avatar || null }
    setUser(user)
    await saveUserToDb(user)
  }, [])

  const updateUser = useCallback(async (partial) => {
    setUser(prev => {
      if (!prev) return prev
      const updated = { ...prev, ...partial }
      saveUserToDb(updated)
      return updated
    })
  }, [])

  const logout = useCallback(async () => {
    setUser(null)
    await clearUserFromDb()
  }, [])

  const isLoggedIn = !!user

  return (
    <AuthContext.Provider value={{ user, isLoggedIn, loginSuccess, logout, updateUser, initialized }}>
      {children}
    </AuthContext.Provider>
  )
}
