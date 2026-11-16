import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import GameMasterContext from './GameMasterContext'
import { getGameMasters } from '../services/workshopApi'
import { CACHE_INVALIDATED_EVENT } from '../services/dbCall'

// 首次拉取失败后的重试间隔：免费云库排队/超时很常见，
// 失败即保持空集合会让整个会话都没有角标（只在下次启动才会重试）
const RETRY_DELAY_MS = 15_000

/**
 * 全局拉取「游戏领域大神」用户 id 集合，供各处头像打标。
 *
 * 集合会过期，因此三条路径都会更新它：
 * - 挂载时拉取；若命中本地缓存，则继续消费后台 revalidate 的结果
 * - 首次失败延迟重试一次
 * - 点赞/取消点赞/发布/编辑/删除等写操作后收到缓存失效广播时立即重拉
 *
 * 拉取失败不阻断界面，保持当前集合。
 */
export function GameMasterProvider({ children }) {
  const [ids, setIds] = useState(() => new Set())
  // 请求序号：并发请求（缓存 revalidate 与失效广播触发的刷新）返回顺序不定，
  // 只接受最后一次发起的结果，避免旧集合覆盖新集合
  const seqRef = useRef(0)
  // 刷新去重：请求在途时再收到失效通知只记一个待办，在途请求结束后补拉一次，
  // 避免连续点赞并发打同一张表
  const runningRef = useRef(false)
  const pendingRef = useRef(false)

  const applyList = useCallback((list) => {
    if (!Array.isArray(list)) return
    const next = new Set(list.map(Number))
    // 内容相同则保持原引用：UserAvatar 遍布各页面，避免无谓的整树重渲染
    setIds((prev) => (
      prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next
    ))
  }, [])

  // force：跳过本地缓存直接走网络，否则刚失效的旧集合可能又被读回来
  const refresh = useCallback(async () => {
    if (runningRef.current) {
      pendingRef.current = true
      return
    }
    runningRef.current = true
    try {
      do {
        pendingRef.current = false
        const seq = ++seqRef.current
        const { list } = await getGameMasters({ force: true })
        if (seq === seqRef.current) applyList(list)
      } while (pendingRef.current)
    } catch (e) {
      console.warn('[GameMaster] 刷新大神列表失败:', e)
    } finally {
      runningRef.current = false
    }
  }, [applyList])

  useEffect(() => {
    let cancelled = false
    let retryTimer = null

    const load = async () => {
      const seq = ++seqRef.current
      try {
        const { list, res } = await getGameMasters()
        if (cancelled || seq !== seqRef.current) return
        applyList(list)
        // 缓存命中时返回值标了 __revalidate（后台网络刷新 promise）。
        // 不消费它的话，缓存里的旧集合会一直生效，新达标用户不会打标
        const fresh = await res?.__revalidate
        if (!cancelled && seq === seqRef.current && fresh) applyList(fresh.data?.user_ids)
      } catch (e) {
        console.warn('[GameMaster] 加载大神列表失败:', e)
        if (!cancelled) retryTimer = setTimeout(() => { if (!cancelled) refresh() }, RETRY_DELAY_MS)
      }
    }
    load()

    const onCacheInvalidated = (e) => {
      if (e?.detail?.families?.includes('db_list_game_masters')) refresh()
    }
    window.addEventListener(CACHE_INVALIDATED_EVENT, onCacheInvalidated)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      window.removeEventListener(CACHE_INVALIDATED_EVENT, onCacheInvalidated)
    }
  }, [applyList, refresh])

  const value = useMemo(
    () => ({
      masters: ids,
      isMaster: (userId) => userId != null && ids.has(Number(userId)),
      refresh,
    }),
    [ids, refresh],
  )

  return <GameMasterContext.Provider value={value}>{children}</GameMasterContext.Provider>
}

export default GameMasterProvider
