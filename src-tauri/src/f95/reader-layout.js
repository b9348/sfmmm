(postId) => {
  if (window !== window.top || location.origin !== 'https://f95zone.to' ||
      !location.pathname.startsWith('/threads/')) return

  const applyLayout = () => {
    const style = document.createElement('style')
    style.textContent = `
      .samBannerUnit[data-position], .samCodeUnit[data-position] {
        display: none !important;
      }
      article.message--post:not([data-sfmmm-reader-post]),
      [data-sfmmm-reader-path]:not([data-sfmmm-reader-post]) >
        :not([data-sfmmm-reader-path], .overlay-container, .tooltip, .flashMessage) {
        display: none !important;
      }
      .p-body { min-width: 0; }
      .message-body { overflow-wrap: anywhere; }
    `
    document.documentElement.append(style)
  }
  const focusPost = () => {
    const firstPost = document.querySelector('article.message--post')
    const post = postId ? Array.from(document.querySelectorAll('article.message--post')).find(
      item => item.dataset.content === 'post-' + postId || item.id === 'js-post-' + postId || item.id === 'post-' + postId,
    ) : firstPost
    if (!post) return false

    post.dataset.sfmmmReaderPost = ''
    for (let element = post; element && element !== document.documentElement; element = element.parentElement) {
      element.dataset.sfmmmReaderPath = ''
    }
    requestAnimationFrame(() => window.scrollTo(0, 0))
    return true
  }

  if (document.documentElement) applyLayout()
  else {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return
      observer.disconnect()
      applyLayout()
    })
    observer.observe(document, { childList: true })
  }
  if (!focusPost()) {
    const observer = new MutationObserver(() => {
      if (focusPost()) observer.disconnect()
    })
    observer.observe(document, { childList: true, subtree: true })
  }

  // The card remains the source of navigation for the reader. Let XF process
  // in-post controls before stopping links that would leave the requested floor.
  window.addEventListener('click', event => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return
    const link = event.target.closest('a[href]')
    if (!link) return
    const url = new URL(link.href, location.href)
    if (url.origin === location.origin &&
        /^\/(?:threads\/|posts\/|goto\/post)/.test(url.pathname) &&
        url.href !== location.href) event.preventDefault()
  })
}
