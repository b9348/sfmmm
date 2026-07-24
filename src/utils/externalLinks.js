import { open } from '@tauri-apps/plugin-shell'

/**
 * 用系统默认浏览器打开外部链接（经由 tauri-plugin-shell）。
 */
export async function openExternalUrl(url) {
  try {
    await open(url)
  } catch (e) {
    console.error('[externalLinks] 打开外部链接失败:', url, e)
  }
}

/**
 * 全局拦截 WebView 内所有 <a> 标签的点击：
 * - 外部 http/https 链接（跨 origin）与 mailto 链接 → 阻止 WebView 导航，改用系统默认浏览器打开
 * - 应用内部链接（同 origin / hash 路由）不受影响
 *
 * 之所以做全局捕获，是因为详情页 / 评论区的富文本与 Markdown 内容
 * 通过 dangerouslySetInnerHTML 渲染，其中的 <a href> 无法逐个绑定事件。
 *
 * @returns {() => void} 卸载拦截器的清理函数
 */
export function installExternalLinkInterceptor() {
  const resolveExternalHref = (target) => {
    const anchor = target?.closest?.('a[href]')
    if (!anchor) return null
    const href = anchor.getAttribute('href')
    if (!href) return null
    let url
    try {
      url = new URL(href, window.location.href)
    } catch {
      return null
    }
    const isHttp = url.protocol === 'http:' || url.protocol === 'https:'
    const isExternal = isHttp && url.origin !== window.location.origin
    const isMailto = url.protocol === 'mailto:'
    return (isExternal || isMailto) ? url.href : null
  }

  const onClick = (e) => {
    const external = resolveExternalHref(e.target)
    if (!external) return
    e.preventDefault()
    e.stopPropagation()
    openExternalUrl(external)
  }

  // 中键点击（auxclick）同样可能触发 WebView 新窗口/导航，需要一并拦截
  const onAuxClick = (e) => {
    if (e.button !== 1) return
    const external = resolveExternalHref(e.target)
    if (!external) return
    e.preventDefault()
    e.stopPropagation()
    openExternalUrl(external)
  }

  document.addEventListener('click', onClick, true)
  document.addEventListener('auxclick', onAuxClick, true)
  return () => {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('auxclick', onAuxClick, true)
  }
}
