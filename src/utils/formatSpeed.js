// 实时下载速度格式化：B/s / KB/s / MB/s
// 复用于程序更新页（GameSettings）、创意工坊 mod 详情页（ModDetailPage）、订阅记录页。
export function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return ''
  if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s'
  if (bytesPerSec >= 1024) return Math.round(bytesPerSec / 1024) + ' KB/s'
  return Math.round(bytesPerSec) + ' B/s'
}

// 文件大小格式化：B / KB / MB / GB
// 用于下载进度显示"已下载 X / 总大小 Y"（BepInEx 前置、订阅、更新等）。
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}
