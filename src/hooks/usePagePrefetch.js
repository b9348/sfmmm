import { useCallback, useRef } from 'react'

/**
 * 通用分页预请求（预加载下一页）hook。
 *
 * 思路与 useTabPrefetch 一致：当前页数据就绪后，自动在后台预请求「下一页」，
 * 并把结果缓存起来；用户翻到下一页时命中缓存立即返回，无需等待网络请求，
 * 加速连续翻页体验。
 *
 * 缓存以 (page, ...rest) 的序列化结果为 key，因此搜索/分类/排序等参数不同
 * 时天然隔离，不会互相污染；查询条件变化时调用 clearCache() 释放旧缓存。
 *
 * 用法：
 *   const { fetchPage, peek, clearCache } = usePagePrefetch(async (page, keyword, cat) => {
 *     const data = await listMods({ page, search: keyword, category: cat, ... })
 *     return { mods: data.mods, total: data.total, page: data.page }
 *   })
 *   // 命中缓存时直接返回，否则请求并缓存，随后自动预请求 page + 1
 *   const data = await fetchPage(2, keyword, cat)
 *
 * @param {(...args) => Promise<any>} fetcher 取单页数据的函数（首参为页码，其余参数透传）
 * @returns {{
 *   fetchPage: (...args) => Promise<any>, // 取数：命中缓存立即返回，否则请求并缓存，成功后自动预请求下一页
 *   fetchFresh: (...args) => Promise<any>,// 强制取数：跳过缓存读取，仍写缓存并预请求下一页（刷新用）
 *   prefetch: (...args) => void,          // 仅预请求：失败静默、空页不缓存，供手动预热用
 *   peek: (...args) => any | undefined,   // 同步查看缓存
 *   clearCache: () => void,               // 清空全部缓存（查询条件变化时调用）
 * }}
 */
export function usePagePrefetch(fetcher) {
  const cacheRef = useRef(new Map())
  const inflightRef = useRef(new Map()) // key -> Promise，去重并发请求
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const keyOf = useCallback((page, rest) => JSON.stringify([page, ...rest]), [])

  // 预请求函数先占位，fetchPage 成功回调里通过 ref 调用，避免循环依赖
  const prefetchRef = useRef(null)

  const fetchPage = useCallback(async (page, ...rest) => {
    const key = keyOf(page, rest)
    const cache = cacheRef.current
    if (cache.has(key)) return cache.get(key)

    const inflight = inflightRef.current
    if (inflight.has(key)) return inflight.get(key)

    const promise = fetcherRef.current(page, ...rest)
      .then((data) => {
        cache.set(key, data)
        // 当前页就绪后自动预请求下一页，加速连续翻页
        prefetchRef.current?.(page + 1, ...rest)
        return data
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, promise)
    return promise
  }, [keyOf])

  // 强制取数：跳过缓存读取（刷新用），但仍写入缓存并预请求下一页
  const fetchFresh = useCallback(async (page, ...rest) => {
    const key = keyOf(page, rest)
    const inflight = inflightRef.current
    if (inflight.has(key)) return inflight.get(key)

    const promise = fetcherRef.current(page, ...rest)
      .then((data) => {
        cacheRef.current.set(key, data)
        prefetchRef.current?.(page + 1, ...rest)
        return data
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, promise)
    return promise
  }, [keyOf])

  const prefetch = useCallback((page, ...rest) => {
    if (page <= 0) return
    const key = keyOf(page, rest)
    if (cacheRef.current.has(key) || inflightRef.current.has(key)) return
    const inflight = inflightRef.current
    const promise = fetcherRef.current(page, ...rest)
      .then((data) => {
        // 下一页无数据说明已到末页：不缓存，避免列表增长后命中过期的空页；
        // 但仍返回结构完整的结果，供并发等待该页的调用方使用
        if (data && Array.isArray(data.mods) && data.mods.length === 0) {
          return { mods: [], total: data.total || 0, page: data.page || page }
        }
        cacheRef.current.set(key, data)
        return data
      })
      .catch(() => undefined) // 预请求失败静默，用户翻页时会走正常请求
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, promise)
  }, [keyOf])

  prefetchRef.current = prefetch

  const peek = useCallback((page, ...rest) => cacheRef.current.get(keyOf(page, rest)), [keyOf])

  const clearCache = useCallback(() => {
    cacheRef.current.clear()
  }, [])

  return { fetchPage, fetchFresh, prefetch, peek, clearCache }
}
