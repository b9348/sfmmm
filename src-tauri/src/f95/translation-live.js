(layout, key) => {
  if (location.origin !== 'https://f95zone.to' || !location.pathname.startsWith('/threads/')) return null
  window.__sfmmmLiveTranslation ??= {
    records: new Map(),
    latest: null,
    receive(job, batch) {
      const record = this.records.get(job)
      if (record?.post.isConnected) record.view.render(batch)
    },
    finish(job) {
      const record = this.records.get(job)
      if (!record) return
      record.running = false
    },
    toggle() {
      const record = this.records.get(this.latest)
      if (!record?.post.isConnected) return
      record.visible = !record.visible
      record.view.show(record.visible)
    },
  }

  const page = window.__sfmmmLiveTranslation
  const post = document.querySelector('article.message--post[data-sfmmm-reader-post]')
  const id = (post?.dataset.content || post?.id || '').match(/^(?:js-)?post-(\d+)$/)?.[1]
  const body = post?.querySelector('.message-body .bbWrapper, .message-body')
  if (!id || !body) return null
  const previous = [...page.records.values()].find(record => record.post === post)
  if (previous?.running) return null
  if (previous) {
    previous.view.clear()
    page.records.delete(previous.key)
  }
  const view = layout.collect(body)
  page.records.set(key, { key, post, view, running: true, visible: true })
  page.latest = key
  return { postId: id, parts: view.parts }
}
