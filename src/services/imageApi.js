/**
 * 图片服务
 * - 管理本地待上传图片（pending images）
 * - 上传图片到 ImgBed 图床
 * - 解析/替换 Markdown / HTML 中的占位 URL
 */

import { open } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import { uploadBlobViaTempFile } from './imgbedUpload'
import { dbCall } from './dbCall'

const PENDING_PREFIX = 'imgbed://pending/'
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
// 图床上传走 telegram 通道，服务端上限 20MB；超出由前端提前拦截
const MAX_FILE_SIZE = 20 * 1024 * 1024

// 生成唯一 ID
function generateId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

// 模块级 pending 图片仓库（页面刷新后清空）
const pendingStore = {}

// 路径转 File
export async function pathToFile(path) {
  const bytes = await readFile(path)
  const name = path.split(/[/\\]/).pop() || 'image'
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const mime = ext === 'png' ? 'image/png'
    : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
          : 'image/png'
  return new File([new Uint8Array(bytes)], name, { type: mime })
}

// 选择本地图片文件
export async function selectImageFiles(options = {}) {
  const paths = await open({
    multiple: true,
    filters: [{ name: 'Images', extensions: ALLOWED_EXTENSIONS }],
    ...options,
  })
  if (!paths) return []
  const list = Array.isArray(paths) ? paths : [paths]
  const results = []
  for (const path of list) {
    const file = await pathToFile(path)
    results.push(createPendingImage(file))
  }
  return results
}

// 创建 pending 图片对象
export function createPendingImage(file, description = '') {
  if (!isValidImageFile(file)) {
    throw new Error(`Invalid image file: ${file.name}`)
  }
  const id = generateId()
  return {
    id,
    file,
    description,
    pendingUrl: `${PENDING_PREFIX}${id}`,
    createdAt: Date.now(),
  }
}

// 校验图片
export function isValidImageFile(file) {
  if (!file || !file.type) return false
  if (!ALLOWED_MIME_TYPES.includes(file.type)) return false
  if (file.size > MAX_FILE_SIZE) return false
  return true
}

// File / Blob 转 data URL
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// 注册 pending 图片
export function registerPendingImages(images) {
  for (const img of images) {
    pendingStore[img.id] = img
  }
}

// 取消注册 pending 图片
export function unregisterPendingImages(ids) {
  for (const id of ids) {
    delete pendingStore[id]
  }
}

// 清空所有 pending 图片
export function clearPendingImages() {
  Object.keys(pendingStore).forEach(key => delete pendingStore[key])
}

// 获取 pending 图片
export function getPendingImage(id) {
  return pendingStore[id]
}

// 判断是否为 pending URL
export function isPendingUrl(url) {
  return typeof url === 'string' && url.startsWith(PENDING_PREFIX)
}

// 把 Markdown 中的 pending URL 替换成占位文本（用于先创建记录、再上传图片的场景）
export function stripPendingUrls(markdown, placeholder = '[图片]') {
  if (!markdown) return markdown
  return markdown.replace(/!\[([^\]]*)\]\(imgbed:\/\/pending\/[^)\s]+\)/g, placeholder)
}

// 提取 Markdown 中的 pending URL
export function extractPendingUrlsFromMarkdown(markdown) {
  if (!markdown) return []
  const regex = /!\[([^\]]*)\]\((imgbed:\/\/pending\/[^)\s]+)\)/g
  const urls = []
  let match
  while ((match = regex.exec(markdown)) !== null) {
    urls.push(match[2])
  }
  return [...new Set(urls)]
}

// 提取 HTML 中的 pending URL（data-imgbed-pending 属性）
export function extractPendingUrlsFromHtml(html) {
  if (!html) return []
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const images = doc.querySelectorAll('img[data-imgbed-pending]')
  const urls = Array.from(images).map(img => img.getAttribute('data-imgbed-pending'))
  return [...new Set(urls)]
}

// 把 pending URL 转成可本地预览的 data URL
export async function resolvePendingUrlForPreview(url) {
  if (!isPendingUrl(url)) return url
  const id = url.replace(PENDING_PREFIX, '')
  const pending = pendingStore[id]
  if (!pending) return url
  const dataUrl = await fileToDataUrl(pending.file)
  return dataUrl
}

// 上传单个图片到图床（落临时文件后由 Rust 流式上传；Token 只在 Rust 侧）
export async function uploadImageToImgbed({ file, folder, description = '' }) {
  // 重命名文件：保留原文件名，前面加唯一 ID 避免冲突
  const hasExt = file.name.includes('.')
  const ext = hasExt ? file.name.split('.').pop() : ''
  const baseName = hasExt ? file.name.replace(/\.[^.]+$/, '') : file.name
  const newName = ext ? `${generateId()}_${baseName}.${ext}` : `${generateId()}_${baseName}`

  const uploaded = await uploadBlobViaTempFile(file, {
    folder,
    channel: 'telegram',
    uploadNameType: 'origin',
    fileName: newName,
  })

  if (!uploaded.url) {
    throw new Error('ImgBed upload failed: unexpected response')
  }

  return {
    url: uploaded.url,
    src: uploaded.src,
    publicUrl: uploaded.publicUrl,
    originalName: newName,
    folder,
    description,
  }
}

// 删除图床图片（同样由 Rust 代理，避免前端持有 Token；走 dbCall 统一超时与网络指示灯）
export async function deleteImageFromImgbed(fileUrl) {
  if (!fileUrl) return { success: false }
  await dbCall('db_delete_imgbed_file', { file_url: fileUrl })
  return { success: true }
}

// 后端单次最多处理 100 个候选，这里按同样大小切批，避免超出后被静默丢弃
const CLEANUP_BATCH_SIZE = 100

// 批量清理：后端先解密扫描全库引用，只删除没有任何有效内容再引用的图片，
// 避免同一张图被多个帖子/语言/评论共享时被误删。
export async function cleanupImagesFromImgbed(fileUrls) {
  const urls = [...new Set((fileUrls || []).filter(Boolean))]
  const result = { deleted: [], kept: [], failed: [] }
  for (let i = 0; i < urls.length; i += CLEANUP_BATCH_SIZE) {
    const batch = urls.slice(i, i + CLEANUP_BATCH_SIZE)
    try {
      const res = await dbCall('db_cleanup_imgbed_images', { file_urls: batch })
      const data = res.data || {}
      result.deleted.push(...(data.deleted || []))
      result.kept.push(...(data.kept || []))
      result.failed.push(...(data.failed || []))
    } catch (e) {
      // 单批失败不中断后续批次，但要留痕（调用方通常只 .catch 一次）
      console.warn('批量清理图片失败:', e)
      result.failed.push(...batch.map(url => ({ url, error: e.message })))
    }
  }
  return result
}

// 保存失败时清理本次已上传但未落库的图片（尽力而为，失败仅 warn）
export function deleteUploadedImages(uploaded) {
  for (const item of uploaded || []) {
    const url = item?.url
    if (!url) continue
    deleteImageFromImgbed(url).catch(e => console.warn('删除未落库图片失败:', url, e))
  }
}

// 通用解析函数：批量上传 pending 图片并替换内容中的 URL
async function resolvePendingImages(content, extractUrls, replaceFn, { getFolder, onProgress }) {
  if (!content) return { content, uploaded: [] }
  const urls = extractUrls(content)
  if (urls.length === 0) return { content, uploaded: [] }

  let newContent = content
  const uploaded = []

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const id = url.replace(PENDING_PREFIX, '')
    const pending = pendingStore[id]
    if (!pending) {
      throw new Error(`Pending image not found: ${url}. The image may have been removed or the page was refreshed.`)
    }

    const folder = getFolder(pending)
    let result
    try {
      result = await uploadImageToImgbed({
        file: pending.file,
        folder,
        description: pending.description,
      })
    } catch (e) {
      // 中途上传失败时调用方不会再保存内容，已上传的图片就地清掉，避免成为孤儿
      deleteUploadedImages(uploaded)
      throw e
    }
    newContent = replaceFn(newContent, url, result.url)
    uploaded.push({ ...result, id: pending.id })
    onProgress?.({ current: uploaded.length, total: urls.length, url: result.url })

    // 上传成功后清理 pending
    delete pendingStore[id]
  }

  return { content: newContent, uploaded }
}

// 解析 Markdown 中的 pending 图片
export async function resolvePendingImagesInMarkdown(markdown, options) {
  return resolvePendingImages(
    markdown,
    extractPendingUrlsFromMarkdown,
    (content, url, realUrl) => content.replaceAll(url, realUrl),
    options,
  )
}

// 解析 HTML 中的 pending 图片
export async function resolvePendingImagesInHtml(html, options) {
  return resolvePendingImages(
    html,
    extractPendingUrlsFromHtml,
    (content, url, realUrl) => {
      // 把 <img ... data-imgbed-pending="url" src="blob:..."> 变成 <img src="realUrl" ...>
      const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const imgRegex = new RegExp(`<img([^>]*?)\\s+data-imgbed-pending="${escaped}"([^>]*?)>`, 'g')
      return content.replace(imgRegex, (match, before, after) => {
        // 移除旧的 src="blob:..." 和 data-imgbed-pending 属性
        const cleanedBefore = before.replace(/\s+src="[^"]*"/g, '')
        const cleanedAfter = after.replace(/\s+src="[^"]*"/g, '').replace(/\s+data-imgbed-pending="[^"]*"/g, '')
        return `<img${cleanedBefore} src="${realUrl}"${cleanedAfter}>`
      })
    },
    options,
  )
}

// 解析 mod 所有翻译中的 pending 图片。
// 返回 uploaded 供调用方在后续保存失败时清理（避免图片已上传但内容没落库）。
export async function resolveTranslationImages(translations, modId, onProgress) {
  const resolved = {}
  const uploaded = []
  try {
    for (const [lang, trans] of Object.entries(translations)) {
      const fmt = trans.instructions_format || 'markdown'
      let instructions = trans.instructions || ''
      if (fmt === 'markdown') {
        const result = await resolvePendingImagesInMarkdown(instructions, {
          getFolder: () => `sfm/${modId}/images/${lang}`,
          onProgress: p => onProgress?.({ lang, ...p }),
        })
        instructions = result.content
        uploaded.push(...result.uploaded)
      } else {
        const result = await resolvePendingImagesInHtml(instructions, {
          getFolder: () => `sfm/${modId}/images/${lang}`,
          onProgress: p => onProgress?.({ lang, ...p }),
        })
        instructions = result.content
        uploaded.push(...result.uploaded)
      }
      resolved[lang] = { ...trans, instructions }
    }
  } catch (e) {
    // 任一语言失败都会整体中止保存，清掉已上传的图片
    deleteUploadedImages(uploaded)
    throw e
  }
  return { translations: resolved, uploaded }
}

// 从内容中收集所有真实图床 URL（用于删除时清理）
// 只匹配作为图片使用的 URL：Markdown ![alt](url) 或 <img src="url">
export function extractImgbedUrls(markdownOrHtml) {
  if (!markdownOrHtml) return []
  const urls = new Set()

  // Markdown 图片
  const mdRegex = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
  let match
  while ((match = mdRegex.exec(markdownOrHtml)) !== null) {
    urls.add(match[2])
  }

  // HTML 图片
  const htmlRegex = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi
  while ((match = htmlRegex.exec(markdownOrHtml)) !== null) {
    urls.add(match[1])
  }

  return [...urls].filter(isImgbedFileUrl)
}

// 本应用上传的图片都落在图床 /file/sfm/（mod、评论）或 /file/sfmmm/（讨论区）下。
// 按路径前缀判断而不是按主机名：图床换过域名（sanyue.de → dpdns.org），
// 且用户粘贴的外部图片不能被误删。
function isImgbedFileUrl(url) {
  try {
    const path = new URL(url).pathname
    return path.startsWith('/file/sfm/') || path.startsWith('/file/sfmmm/')
  } catch {
    return false
  }
}
