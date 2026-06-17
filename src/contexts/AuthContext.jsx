import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import Database from '@tauri-apps/plugin-sql'

async function loadUserFromDb() {
  try {
    const db = await Database.load('sqlite:config.db')
    const rows = await db.select(
      "SELECT `key`, value FROM config WHERE `key` IN ('cloud_user_id', 'cloud_username')"
    )
    const map = {}
    rows.forEach(r => { map[r.key] = r.value })
    if (map.cloud_user_id && map.cloud_username) {
      return { user_id: Number(map.cloud_user_id), username: map.cloud_username }
    }
    return null
  } catch {
    return null
  }
}

async function saveUserToDb(user) {
  try {
    const db = await Database.load('sqlite:config.db')
    const upsert = "INSERT OR REPLACE INTO config (id, `key`, value) VALUES ((SELECT id FROM config WHERE `key` = $1), $1, $2)"
    await db.execute(upsert, ['cloud_user_id', String(user.user_id)])
    await db.execute(upsert, ['cloud_username', user.username])
  } catch (e) {
    console.error('Failed to persist cloud user:', e)
  }
}

async function clearUserFromDb() {
  try {
    const db = await Database.load('sqlite:config.db')
    await db.execute("DELETE FROM config WHERE `key` IN ('cloud_user_id', 'cloud_username')")
  } catch (e) {
    console.error('Failed to clear cloud user:', e)
  }
}

const AuthContext = createContext(null)

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

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
