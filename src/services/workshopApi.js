/**
 * Workshop API 服务
 * 直连 MySQL，通过 Tauri invoke 调用 Rust 后端命令
 */

import { invoke } from '@tauri-apps/api/core'

// ── 错误辅助 ──

function extractError(e) {
  if (typeof e === 'string') return e
  if (e?.message) return e.message
  return String(e)
}

// ── 通用请求包装 ──

async function dbCall(command, args = {}) {
  try {
    const result = await invoke(command, args)
    if (!result.success) {
      const err = new Error(result.message || '操作失败')
      throw err
    }
    return result
  } catch (e) {
    const msg = extractError(e)
    const error = new Error(msg)
    error.httpCode = 'DB_ERROR'
    throw error
  }
}

// ── 认证 ──

export async function login(username, password) {
  const res = await dbCall('db_login', { username, password })
  return {
    success: true,
    message: res.message,
    data: res.data, // { user_id, username }
  }
}

export async function register(username, password, avatar) {
  const res = await dbCall('db_register', { username, password, avatar: avatar || null })
  return {
    success: true,
    message: res.message,
    data: res.data, // { user_id, username, avatar }
  }
}

export async function getUserProfile() {
  // 桌面端不需要额外的 profile 查询，从本地 auth 上下文即可
  return { success: true, data: {} }
}

export async function updateProfile({ user_id, avatar, username }) {
  const res = await dbCall('db_update_profile', { user_id, avatar: avatar || null, username: username || null })
  return res.data // { user_id, username, avatar, r2_enabled }
}

// ── 设备标识（一机一赞） ──

const DEVICE_ID_KEY = 'sfmmm_device_id'

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = generateUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

// ── Mod 浏览 ──

export async function listMods({ lang = 'zh', search, page = 1, limit = 20, sort_by, device_id, category } = {}) {
  const res = await dbCall('db_list_mods', {
    lang,
    search: search || null,
    page,
    limit,
    sort_by: sort_by || null,
    device_id: device_id || null,
    category: category || null,
  })
  return {
    success: true,
    mods: res.mods || [],
    total: res.total || 0,
    page: res.page || 1,
    page_size: res.page_size || limit,
  }
}

export async function getModDetail(id, lang = 'zh', user_id, device_id) {
  const res = await dbCall('db_get_mod_detail', {
    id: Number(id),
    lang,
    user_id: user_id || null,
    device_id: device_id || null,
  })
  return { success: true, data: res.data }
}

export async function getModForEdit(id, user_id) {
  const res = await dbCall('db_get_mod_for_edit', { id: Number(id), user_id })
  return { success: true, data: res.data }
}

// ── Mod 管理 ──

// 前端 translations 是 { zh: { name, ... }, en: { name, ... } } 格式，
// Rust 后端要求 [{ lang_code, name, ... }, ...] 数组格式
function normalizeTranslations(translations) {
  if (Array.isArray(translations)) return translations
  return Object.entries(translations || {}).map(([lang_code, t]) => ({
    lang_code,
    name: t.name || '',
    description: t.description || '',
    instructions: t.instructions || '',
    instructions_format: t.instructions_format || 'markdown',
    changelog: t.changelog || '',
    version: t.version || '1.0.0',
  }))
}

export async function createMod({ author_id, mod_key, translations, category }) {
  const { data } = await dbCall('db_create_mod', {
    author_id, mod_key,
    translations: normalizeTranslations(translations),
    category,
  })
  return { success: true, data }
}

export async function updateMod({ author_id, mod_id, category, translations }) {
  const { data } = await dbCall('db_update_mod', {
    author_id, mod_id: Number(mod_id),
    translations: normalizeTranslations(translations),
    category,
  })
  return { success: true, data }
}

export async function deleteMod({ author_id, modId }) {
  await dbCall('db_delete_mod', { author_id, mod_id: Number(modId) })
  return { success: true }
}

export async function deleteModWithFiles({ author_id, modId, files }) {
  for (const file of files) {
    await deleteModFile({ author_id, mod_id: Number(modId), lang_code: file.lang_code, fileUrl: file.file_url })
  }
  await dbCall('db_delete_mod', { author_id, mod_id: Number(modId) })
  return { success: true }
}

export async function listMyMods({ author_id, lang = 'zh', page = 1, page_size = 20, device_id } = {}) {
  const res = await dbCall('db_list_my_mods', { author_id, lang, page, page_size, device_id: device_id || null })
  return {
    success: true,
    mods: res.mods || [],
    total: res.total || 0,
    page: res.page || 1,
    page_size: res.page_size || page_size,
  }
}

export async function likeMod(mod_id, device_id) {
  const res = await dbCall('db_like_mod', { mod_id: Number(mod_id), device_id })
  return res.data || { like_count: 0, is_liked: true }
}

export async function unlikeMod(mod_id, device_id) {
  const res = await dbCall('db_unlike_mod', { mod_id: Number(mod_id), device_id })
  return res.data || { like_count: 0, is_liked: false }
}

export async function checkModKey(mod_key) {
  const res = await dbCall('db_check_mod_key', { mod_key })
  return res.data
}

// ── 文件上传（直传 ImgBed，然后存 URL 到 MySQL） ──

export async function getImgbedConfig() {
  return await invoke('db_get_imgbed_config')
}

const TELEGRAM_MAX_SIZE = 20 * 1024 * 1024 // 20MB
const R2_MAX_SIZE = 100 * 1024 * 1024 // 100MB

// 单文件上传到 ImgBed，支持进度回调
function uploadFile({ imgbed, file, folder, channel = 'telegram', onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()
    formData.append('file', file)

    const url = `${imgbed.url}/upload?uploadChannel=${channel}&uploadFolder=${encodeURIComponent(folder)}&returnFormat=full`

    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${imgbed.token}`)

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(event.loaded, event.total)
        }
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText)
          if (!Array.isArray(data) || data.length === 0) {
            reject(new Error('ImgBed upload failed: unexpected response'))
          } else {
            resolve(data[0])
          }
        } catch (e) {
          reject(new Error(`ImgBed upload failed: ${e.message}`))
        }
      } else {
        reject(new Error(`ImgBed upload failed: HTTP ${xhr.status} - ${xhr.responseText.slice(0, 200)}`))
      }
    }

    xhr.onerror = () => reject(new Error('ImgBed upload failed: network error'))
    xhr.ontimeout = () => reject(new Error('ImgBed upload failed: timeout'))
    xhr.send(formData)
  })
}

export async function uploadModFile({ author_id, mod_id, lang_code, version, file, manifest, r2_enabled = false, onProgress }) {
  // 1. 读 ImgBed 配置
  const imgbed = await getImgbedConfig()

  // 2. 根据权限和大小选择上传渠道
  const folder = `sfm/${mod_id}/${lang_code}/${version || '1.0.0'}`

  if (file.size > R2_MAX_SIZE) {
    throw new Error(`文件大小超过 100MB 限制: ${(file.size / 1024 / 1024).toFixed(1)}MB`)
  }

  let channel = 'telegram'
  if (file.size > TELEGRAM_MAX_SIZE) {
    if (!r2_enabled) {
      throw new Error(`文件大小超过 20MB，需要 R2 存储权限: ${(file.size / 1024 / 1024).toFixed(1)}MB`)
    }
    channel = 'cfr2'
  }

  const uploadResult = await uploadFile({ imgbed, file, folder, channel, onProgress })
  const fileUrl = uploadResult.publicUrl || uploadResult.src

  // 3. 计算文件哈希（浏览器端）
  const fileHash = await computeFileHash(file)

  // 4. 保存 URL 到 MySQL
  await dbCall('db_save_mod_file', {
    mod_id: Number(mod_id),
    author_id,
    lang_code,
    file_url: fileUrl,
    file_name: file.name,
    file_size: file.size,
    file_hash: fileHash,
    version: version || '1.0.0',
    manifest: manifest || null,
  })

  return {
    success: true,
    data: {
      lang_code,
      file_url: fileUrl,
      file_name: file.name,
      file_size: file.size,
      file_hash: fileHash,
      version: version || '1.0.0',
      manifest: manifest || null,
      reused: false,
    },
  }
}

export async function deleteModFile({ author_id, mod_id, lang_code, fileUrl }) {
  // 1. 通过 Rust 后端代理删除 ImgBed CDN 文件（避免前端 CORS）
  const res = await dbCall('db_delete_imgbed_file', { file_url: fileUrl })
  if (!res.success) {
    throw new Error(res.message || 'ImgBed delete failed')
  }

  // 2. 删除数据库记录
  await dbCall('db_delete_mod_file', { mod_id: Number(mod_id), author_id, lang_code })

  return { success: true }
}

// 仅删除 ImgBed CDN 文件（不删数据库记录），用于 v1 替换流程
export async function deleteImgbedFile(fileUrl) {
  const res = await dbCall('db_delete_imgbed_file', { file_url: fileUrl })
  if (!res.success) {
    throw new Error(res.message || 'ImgBed delete failed')
  }
  return { success: true }
}

// ── 评论系统 ──

export async function addComment({ mod_id, author_id, content, parent_id }) {
  const res = await dbCall('db_add_comment', { mod_id, author_id, content, parent_id: parent_id || null })
  return { success: true, data: res.data }
}

export async function getComments({ mod_id, page = 1, page_size = 10 }) {
  const res = await dbCall('db_get_comments', { mod_id, page, page_size })
  return {
    success: true,
    comments: res.data?.comments || [],
    total: res.data?.total || 0,
    // 评论总数（含楼中楼），列表页 comment_count 同口径，用于详情页标题
    totalIncludingReplies: res.data?.total_including_replies || 0,
    page: res.data?.page || 1,
    page_size: res.data?.page_size || page_size,
  }
}

export async function getCommentReplies({ comment_id, page = 1, page_size = 10 }) {
  const res = await dbCall('db_get_replies', { comment_id, page, page_size })
  return {
    success: true,
    replies: res.data?.replies || [],
    total: res.data?.total || 0,
    page: res.data?.page || 1,
    page_size: res.data?.page_size || page_size,
  }
}

export async function deleteComment({ comment_id, author_id }) {
  await dbCall('db_delete_comment', { comment_id, author_id })
  return { success: true }
}

export async function editComment({ comment_id, author_id, content }) {
  const res = await dbCall('db_edit_comment', { comment_id, author_id, content })
  return { success: true, data: res.data }
}

// ── 权限系统 ──

export async function setModPermissions({ author_id, mod_id, mode, open_langs, allow_mod_info, allow_lang, apply_langs }) {
  return await dbCall('db_set_mod_permissions', { author_id, mod_id, mode, open_langs: open_langs || null, allow_mod_info, allow_lang, apply_langs: apply_langs || null })
}

export async function submitApplication({ mod_id, user_id, scope, target_lang, reason }) {
  return await dbCall('db_submit_application', { mod_id, user_id, scope, target_lang: target_lang || null, reason: reason || null })
}

export async function listApplications({ mod_id, user_id, role, status, page = 1, page_size = 20 } = {}) {
  const res = await dbCall('db_list_applications', { mod_id: mod_id || null, user_id: user_id || null, role: role || null, status: status || null, page, page_size })
  return { applications: res.mods || [], total: res.total || 0, page: res.page || 1, page_size: res.page_size || page_size }
}

export async function handleApplication({ author_id, app_id, action }) {
  return await dbCall('db_handle_application', { author_id, app_id, action })
}

export async function getUnreadCount(user_id) {
  const res = await dbCall('db_get_unread_count', { user_id })
  return res.data || { applications: 0, notifications: 0, total: 0 }
}

export async function getMyNotifications({ user_id, page = 1, page_size = 20 } = {}) {
  const res = await dbCall('db_get_my_notifications', { user_id, page, page_size })
  return { items: res.mods || [], total: res.total || 0, page: res.page || 1, page_size: res.page_size || page_size }
}

export async function markRead({ user_id, target_type, ids }) {
  return await dbCall('db_mark_read', { user_id, target_type: target_type || null, ids: ids || null })
}

// ── 浏览器端 SHA-256（使用 SubtleCrypto） ──

async function computeFileHash(file) {
  try {
    const buffer = await file.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return ''
  }
}
