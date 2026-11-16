import { invoke } from '@tauri-apps/api/core'

/**
 * 链接卡片（onebox）元数据。
 *
 * 正文里的裸链接抓取 OpenGraph 信息后渲染成卡片。抓取走 Rust 侧（fetch_link_preview），
 * 一是绕开 WebView 的 CORS，二是能带正常 UA。
 *
 * 缓存放在模块级：同一篇讨论里同一个链接被反复渲染（评论树里引用同一地址）时不重复请求；
 * 详情页关掉再打开也无需重抓。
 */

/** url -> LinkPreview（抓取失败不进缓存，下次挂载会重试） */
const cache = new Map()
/** url -> Promise，同一链接并发请求去重 */
const inflight = new Map()

const MAX_CACHE_ENTRIES = 200

export function getCachedLinkPreview(url) {
  return cache.get(url) || null
}

export function fetchLinkPreview(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url))
  if (inflight.has(url)) return inflight.get(url)

  const task = invoke('fetch_link_preview', { url })
    .then((data) => {
      if (!data || !data.title) return null
      cache.set(url, data)
      if (cache.size > MAX_CACHE_ENTRIES) {
        // Map 按插入顺序迭代，删最早的一条即可
        cache.delete(cache.keys().next().value)
      }
      return data
    })
    .catch((e) => {
      console.warn('[linkPreview] 抓取失败:', url, e)
      return null
    })
    .finally(() => {
      inflight.delete(url)
    })

  inflight.set(url, task)
  return task
}
