import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import AuthContext from './AuthContext'
import { loadUserFromDb, saveUserToDb, clearUserFromDb } from './authHelpers'
import { saveLegacyAccount } from '../services/legacyAccount'

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const saved = await loadUserFromDb()
      if (cancelled) return
      if (saved) {
        // 旧直连架构升级 / 令牌过期：本地有用户但 Rust 侧没有令牌时，
        // 云端写操作必然 401，直接清掉本地登录态，避免「看似已登录」。
        let hasSession = true
        try {
          hasSession = await invoke('db_has_session')
        } catch { /* 命令异常时保守保留 */ }
        if (cancelled) return
        if (hasSession) {
          setUser(saved)
        } else {
          // 0.3.x 直连架构的登录态没有服务端令牌：清理前先留档，
          // 供「旧版账号」弹窗/菜单恢复原账号（见 LegacyAccountProvider）。
          try {
            await saveLegacyAccount(saved)
          } catch (e) {
            console.warn('[auth] 记录旧版账号失败:', e)
          }
          await clearUserFromDb()
        }
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
    // 清除 Rust 侧保存的云服务令牌（失败不影响本地退出）
    invoke('db_logout').catch(() => {})
  }, [])

  // 任意请求返回 AUTH_FAILED 时（令牌过期/服务端轮换 secret），统一退出登录
  useEffect(() => {
    const onExpired = () => { logout() }
    window.addEventListener('sfmmm:auth-expired', onExpired)
    return () => window.removeEventListener('sfmmm:auth-expired', onExpired)
  }, [logout])

  const isLoggedIn = !!user

  return (
    <AuthContext.Provider value={{ user, isLoggedIn, loginSuccess, logout, updateUser, initialized }}>
      {children}
    </AuthContext.Provider>
  )
}
