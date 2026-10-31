/**
 * 头像工具函数
 * 使用 Vite 的 import.meta.glob 在构建时扫描所有头像 PNG，
 * 建立 "文件名 → 打包后 URL" 的映射。
 */

const avatarModules = import.meta.glob('/src/assets/avatars/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

/** @type {Record<string, string>} */
const avatarMap = {}
for (const [path, url] of Object.entries(avatarModules)) {
  const filename = path.split('/').pop()
  if (filename) {
    avatarMap[filename] = /** @type {string} */ (url)
  }
}

/**
 * 根据文件名获取头像图片 URL
 * @param {string|null|undefined} filename - 数据库中存储的头像文件名
 * @returns {string|null} 打包后的图片 URL，null 表示使用默认头像
 */
export function getAvatarUrl(filename) {
  if (!filename) return null
  return avatarMap[filename] || null
}

/**
 * 获取所有可用的头像文件名列表（按字母排序）
 * @returns {string[]}
 */
export function getAllAvatars() {
  return Object.keys(avatarMap).sort()
}

export { avatarMap }