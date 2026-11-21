export function isF95AttachmentLink(value) {
  if (!value) return false
  try {
    const url = new URL(value)
    const id = url.pathname.match(/^\/attachments\/(?:[^/]*\.)?(\d+)\/?$/)?.[1]
    const cdnId = url.pathname.match(/^\/\d{4}\/\d{2}\/(\d+)_[^/]+$/)?.[1]
    if (url.username || url.password) return false
    return (url.origin === 'https://f95zone.to' && /[1-9]/.test(id ?? '')) ||
      (url.origin === 'https://attachments.f95zone.to' && /[1-9]/.test(cdnId ?? ''))
  } catch {
    return false
  }
}
