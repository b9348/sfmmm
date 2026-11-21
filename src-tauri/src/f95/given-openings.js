(key, targets) => {
  if (location.origin !== 'https://f95zone.to') return null
  if (window.__sfmmmOpeningLookup?.key !== key) {
    const job = { key, done: false, errors: 0, matches: [] }
    window.__sfmmmOpeningLookup = job
    let index = 0
    const worker = async () => {
      while (index < targets.length) {
        const [href, expected] = targets[index++]
        try {
          const response = await fetch(href, { signal: AbortSignal.timeout(3500) })
          const url = new URL(response.url)
          if (!response.ok || url.origin !== location.origin) throw new Error('unavailable')
          const thread = url.pathname.match(/^\/threads\/(?:[^/]*\.)?(\d+)(?:\/page-1)?\/?$/)?.[1]
          if (!thread) {
            if (!/^\/threads\//.test(url.pathname)) throw new Error('unavailable')
            continue
          }
          const doc = new DOMParser().parseFromString(await response.text(), 'text/html')
          const first = doc.querySelector('article.message--post')
          const id = (first?.getAttribute('data-content') || first?.id || '').match(/^(?:js-)?post-(\d+)$/)?.[1]
          if (!id) throw new Error('unavailable')
          if (!expected || id === expected) job.matches.push([thread, id])
        } catch { job.errors++ }
      }
    }
    Promise.all([worker(), worker(), worker(), worker()]).finally(() => { job.done = true })
  }
  const job = window.__sfmmmOpeningLookup
  return job.done ? { errors: job.errors, matches: job.matches } : null
}
