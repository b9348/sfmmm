import { useState, useCallback, useMemo } from 'react'
import UserNavContext from './UserNavContext'
import { UserProfileDialog } from '../components/common/UserProfileDialog'

/**
 * 用户导航 Provider
 * 在 App 内挂载一次，统一渲染 UserProfileDialog。
 * 任意子组件通过 useUserNav().openUser({ userId, username, avatar }) 打开用户资料弹窗，
 * 通过 useUserNav().openMod(modRef) 跳转到创意工坊某 mod 详情页（modRef 为数字 id 或 mod_key）。
 *
 * @param {function} onOpenMod - 可选，点击用户 MOD 列表项时的跳转回调 (modRef) => void
 */
export function UserNavProvider({ children, onOpenMod }) {
  const [target, setTarget] = useState(null) // { userId, username, avatar }

  const openUser = useCallback((userInfo) => {
    if (!userInfo) return
    const userId = userInfo.userId ?? userInfo.user_id ?? userInfo.author_id ?? null
    if (!userId) return
    setTarget({
      userId: Number(userId),
      username: userInfo.username ?? userInfo.author_name ?? '',
      avatar: userInfo.avatar ?? userInfo.author_avatar ?? null,
    })
  }, [])

  const closeUser = useCallback(() => setTarget(null), [])

  // 跳转到创意工坊某 mod 的详情页。modRef 可为数字 id（来自用户资料卡）
  // 或 mod_key 字符串（来自本地预览页菜单）。
  const openMod = useCallback((modRef) => {
    if (modRef === null || modRef === undefined || modRef === '') return
    onOpenMod?.(modRef)
  }, [onOpenMod])

  const value = useMemo(() => ({ openUser, closeUser, openMod }), [openUser, closeUser, openMod])

  return (
    <UserNavContext.Provider value={value}>
      {children}
      <UserProfileDialog
        open={!!target}
        target={target}
        onClose={closeUser}
        onOpenMod={onOpenMod}
      />
    </UserNavContext.Provider>
  )
}
