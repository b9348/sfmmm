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
    // userData = { user_id, username }
    setUser({ user_id: userData.user_id, username: userData.username })
    await saveUserToDb(userData)
  }, [])

  const logout = useCallback(async () => {
    setUser(null)
    await clearUserFromDb()
  }, [])

  const isLoggedIn = !!user

  return (
    <AuthContext.Provider value={{ user, isLoggedIn, loginSuccess, logout, initialized }}>
      {children}
    </AuthContext.Provider>
  )
}
