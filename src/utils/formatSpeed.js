// 实时下载速度格式化：B/s / KB/s / MB/s
// 复用于程序更新页（GameSettings）、创意工坊 mod 详情页（ModDetailPage）、订阅记录页。
export function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return ''
  if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s'
  if (bytesPerSec >= 1024) return Math.round(bytesPerSec / 1024) + ' KB/s'
  return Math.round(bytesPerSec) + ' B/s'
}
