((expectedThread, postId, click, desired) => {
  if (location.origin !== 'https://f95zone.to' || window.__sfmmmPreviousDocument ||
      document.readyState === 'loading') return null
  const thread = location.pathname.match(/^\/threads\/(?:[^/]*\.)?(\d+)(?:\/|$)/)?.[1]
  if (thread !== expectedThread) return null
  const posts = [...document.querySelectorAll('article.message--post')]
  const idOf = post => (post?.getAttribute('data-content') || post?.id || '').match(/^(?:js-)?post-(\d+)$/)?.[1]
  const post = postId ? posts.find(item => idOf(item) === postId) : posts[0]
  const id = idOf(post)
  if (!id) return null
  const control = [...post.querySelectorAll('a[data-xf-click~="reaction"][href], a.reaction[href]')].find(link => {
    const target = new URL(link.href)
    return target.origin === location.origin && target.pathname.replace(/\/$/, '') === '/posts/' + id + '/react'
  })
  if (!control) return null
  const selected = control.classList.contains('has-reaction')
  const reactionId = control.querySelector('[data-reaction-id]')?.dataset.reactionId ??
    control.dataset.reactionId
  // The forum's native control must describe the selected reaction before we
  // toggle it, so a different reaction is never removed by an Unlike request.
  if (selected && !/^\d+$/.test(reactionId ?? '')) return null
  const liked = selected && reactionId === '1'
  const ready = !selected || liked
  if (click && ready && liked !== desired) control.click()
  return { id, liked, ready }
})
