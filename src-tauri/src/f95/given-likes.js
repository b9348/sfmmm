(() => {
  if (location.origin !== 'https://f95zone.to' || location.pathname.replace(/\/$/, '') !== '/account/reactions' ||
      new URLSearchParams(location.search).get('f95ac_given') !== '1' ||
      window.__sfmmmPreviousDocument || document.readyState === 'loading') return null

  const content = document.querySelector('.p-body-pageContent')
  if (!content) return null
  const more = [...content.querySelectorAll('a, button')].find(button =>
    button.textContent.trim().toLowerCase() === 'show more' && button.getClientRects().length)
  const posts = new Set()
  const postLinks = []
  const threads = new Set()
  const bare = []
  const threadOf = url => url.pathname.match(/^\/threads\/(?:[^/]*\.)?(\d+)(?:\/|$)/)?.[1]
  for (const link of content.querySelectorAll('a[href]')) {
    const url = new URL(link.href)
    if (url.origin !== location.origin) continue
    const thread = threadOf(url)
    const row = link.closest('.contentRow, .block-row, .structItem')
    const reaction = row?.querySelector('.reaction[data-reaction-id], .reaction--1')
    if (reaction?.dataset.reactionId && reaction.dataset.reactionId !== '1') continue
    const post = url.pathname.match(/^\/posts\/(\d+)(?:\/|$)/)?.[1] ??
      (/^\/goto\/post\/?$/.test(url.pathname) ? url.searchParams.get('id') : null) ??
      (thread && (url.hash.match(/^#(?:js-)?post-(\d+)$/)?.[1] ??
        url.pathname.match(/\/post-(\d+)\/?$/)?.[1] ?? url.searchParams.get('post_id'))) ??
      link.dataset?.postId
    if (/^\d+$/.test(post ?? '')) {
      posts.add(post)
      postLinks.push(post)
      if (!thread) bare.push([post, row])
    }
    if (thread) threads.add(thread)
  }

  // Only publish a new batch after its posts have appeared. A failed request
  // leaving the same control and rows in place will time out in the caller.
  const unlinked = bare.filter(([, row]) => !row ||
    ![...row.querySelectorAll('a[href]')].some(link => {
      const url = new URL(link.href)
      return url.origin === location.origin && threadOf(url)
    })).map(([post]) => post)
  const previous = window.__sfmmmGivenLikes
  const cursor = more && [...more.attributes]
    .filter(attribute => attribute.name === 'href' || attribute.name.startsWith('data-'))
    .map(attribute => [attribute.name, attribute.value])
  const key = JSON.stringify([postLinks, cursor ?? null])
  const requestedAt = previous?.requestedAt ?? 0
  // F95 can briefly remove the control before the response has been inserted.
  if (!more && Date.now() - requestedAt < 1200) return null
  const givenCount = document.body?.textContent.match(/\bGiven\s+([\d,]+)\b/i)?.[1]
  const empty = /no (?:reactions|results)|has not reacted|haven.t (?:given|reacted)|not given any/i.test(content.textContent)
  if (!posts.size && (more || (givenCount != null ? Number(givenCount.replace(/,/g, '')) !== 0 : !empty))) return null

  window.__sfmmmGivenLikes = {
    requestedAt,
    loadMore() {
      if (!more?.isConnected || more.disabled || more.getAttribute('aria-disabled') === 'true') return
      this.requestedAt = Date.now()
      more.click()
    },
  }
  return { posts: [...posts], threads: [...threads], unlinked, more: Boolean(more), key }
})()
