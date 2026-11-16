/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from './useAuth'
import {
  detectLegacyAccounts, isLegacyNoticeMuted, setLegacyNoticeMuted, legacyLogin,
} from '../services/legacyAccount'
import { LegacyAccountDialog } from '../components/common/LegacyAccountDialog'

const LegacyAccountContext = createContext(null)

/**
 * 旧版账号上下文。
 *
 * - 启动：AuthContext 初始化完成后读本机 `legacy_accounts`；未静音且存在
 *   非当前登录账号时自动弹窗，未点「不再提醒」每次启动都会弹。
 * - 手动：用户名菜单「检测旧版账号」随时重新扫描（不受静音标记影响）。
 * - 恢复：`db_legacy_login` 用 user_id + username 换新令牌，成功后写入当前登录态。
 */
export function LegacyAccountProvider({ children }) {
  const { t } = useTranslation()
  const { user, initialized, loginSuccess } = useAuth()
  const [accounts, setAccounts] = useState([])
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState('')
  const autoCheckedRef = useRef(false)

  const currentUserId = user?.user_id ?? null
  const userKey = currentUserId == null ? null : String(currentUserId)
  const pendingAccounts = useMemo(
    () => accounts.filter((a) => userKey == null || String(a.user_id) !== userKey),
    [accounts, userKey],
  )

  // 启动自动检查：只跑一次，必须等 AuthContext 把旧登录态落库之后。
  useEffect(() => {
    if (!initialized || autoCheckedRef.current) return
    autoCheckedRef.current = true
    let cancelled = false

    const run = async () => {
      try {
        if (await isLegacyNoticeMuted()) return
        const list = await detectLegacyAccounts()
        if (cancelled) return
        setAccounts(list)
        const currentKey = currentUserId == null ? null : String(currentUserId)
        if (list.some((a) => currentKey == null || String(a.user_id) !== currentKey)) {
          setOpen(true)
        }
      } catch (e) {
        console.warn('[legacy-account] 启动检测失败:', e)
      }
    }
    run()

    return () => { cancelled = true }
  }, [initialized, currentUserId])

  // 用户名菜单手动检测：始终重新扫描，静音后也能手动打开。
  const detect = useCallback(async () => {
    setError('')
    try {
      const list = await detectLegacyAccounts()
      setAccounts(list)
      const currentKey = currentUserId == null ? null : String(currentUserId)
      const pending = list.filter((a) => currentKey == null || String(a.user_id) !== currentKey)
      if (!pending.length) return false
      setOpen(true)
      return true
    } catch (e) {
      console.warn('[legacy-account] 手动检测失败:', e)
      return false
    }
  }, [currentUserId])

  const restore = useCallback(async (account) => {
    setBusyId(account.user_id)
    setError('')
    try {
      const res = await legacyLogin(account)
      await loginSuccess(res.data)
      setAccounts((prev) => prev.filter((a) => a.user_id !== account.user_id))
      setOpen(false)
      return true
    } catch (e) {
      const message = e?.message || String(e)
      setError(message === 'Legacy account not found' ? t('legacyAccount.notFound') : message)
      return false
    } finally {
      setBusyId(null)
    }
  }, [loginSuccess, t])

  const mute = useCallback(async () => {
    try {
      await setLegacyNoticeMuted(true)
    } catch (e) {
      console.warn('[legacy-account] 保存静音标记失败:', e)
    }
    setOpen(false)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const value = useMemo(
    () => ({ detectLegacyAccounts: detect, legacyAccounts: pendingAccounts }),
    [detect, pendingAccounts],
  )

  return (
    <LegacyAccountContext.Provider value={value}>
      {children}
      <LegacyAccountDialog
        open={open && pendingAccounts.length > 0}
        accounts={pendingAccounts}
        busyId={busyId}
        error={error}
        onRestore={restore}
        onMute={mute}
        onClose={close}
      />
    </LegacyAccountContext.Provider>
  )
}

export function useLegacyAccount() {
  const ctx = useContext(LegacyAccountContext)
  if (!ctx) throw new Error('useLegacyAccount must be used within LegacyAccountProvider')
  return ctx
}
