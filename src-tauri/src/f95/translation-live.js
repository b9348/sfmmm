(layout, key) => {
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
      record.status.textContent = ({
        noKey: '请在 SFMMM 设置里配置翻译 API / Configure the translation API in SFMMM Settings.',
        connection: '翻译连接失败 / Could not connect to the translation service.',
        apiAuth: '翻译密钥无效 / Translation API authentication failed.',
        rateLimit: '翻译请求过多 / Translation API rate limit reached.',
        busy: '其他翻译正在进行 / Another translation is running.',
        partial: '部分段落翻译失败，可再次点击重试 / Some paragraphs failed. Translate again to retry.',
      })[error] ?? (error ? '翻译失败 / Could not translate this post.' : '')
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
  status.textContent = '翻译中… / Translating…'
  body.before(status)
  page.records.set(key, { key, post, view, status, running: true, visible: true })
  page.latest = key
  return { postId: id, parts: view.parts }
}
