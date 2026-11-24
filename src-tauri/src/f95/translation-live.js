(layout, key, messages) => {
  if (location.origin !== 'https://f95zone.to' || !location.pathname.startsWith('/threads/')) return null
  window.__sfmmmLiveTranslation ??= {
    records: new Map(),
    latest: null,
    receive(job, batch) {
      const record = this.records.get(job)
      if (record?.post.isConnected) record.view.render(batch)
    },
    finish(job, error) {
      const record = this.records.get(job)
      if (!record) return
      record.running = false
      const errors = record.messages.errors
      record.status.textContent = error ? (errors[error] ?? errors.generic) : ''
    },
    toggle() {
      const record = this.records.get(this.latest)
      if (!record?.post.isConnected) return
      record.visible = !record.visible
      record.view.show(record.visible)
    },
  }

  const page = window.__sfmmmLiveTranslation
  const posts = [...document.querySelectorAll('article.message--post')]
  const visible = post => {
    const rect = post.getBoundingClientRect()
    return rect.bottom > 0 && rect.top < innerHeight
  }
  const selection = document.getSelection()?.anchorNode
  const selected = (selection?.parentElement ?? selection)?.closest?.('article.message--post')
  const center = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('article.message--post')
  const target = location.hash.match(/^#(?:js-)?post-(\d+)$/)?.[1]
  const postId = post => (post?.getAttribute('data-content') || post?.id || '').match(/^(?:js-)?post-(\d+)$/)?.[1]
  const linked = target && posts.find(post => postId(post) === target && visible(post))
  const post = (selected && visible(selected) && selected) || center || linked || posts.find(visible)
  const id = postId(post)
  const body = post?.querySelector('.message-body .bbWrapper, .message-body')
  if (!id || !body) return null
  const previous = [...page.records.values()].find(record => record.post === post)
  if (previous?.running) return null
  if (previous) {
    previous.view.clear()
    previous.status.remove()
    page.records.delete(previous.key)
  }
  const view = layout.collect(body)
  const status = document.createElement('div')
  status.dataset.sfmmmTranslationStatus = ''
  status.setAttribute('role', 'status')
  status.textContent = messages.progress
  body.before(status)
  page.records.set(key, { key, post, view, status, messages, running: true, visible: true })
  page.latest = key
  return { postId: id, parts: view.parts }
}
