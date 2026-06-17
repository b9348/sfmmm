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

export async function register(username, password) {
  const res = await dbCall('db_register', { username, password })
  return {
    success: true,
    message: res.message,
    data: res.data, // { user_id, username }
  }
}

export async function getUserProfile() {
  // 桌面端不需要额外的 profile 查询，从本地 auth 上下文即可
  return { success: true, data: {} }
}

// ── Mod 浏览 ──

export async function listMods({ lang = 'zh', search, page = 1, limit = 20 } = {}) {
  const res = await dbCall('db_list_mods', { lang, search: search || null, page, limit })
  return {
    success: true,
    mods: res.mods || [],
    total: res.total || 0,
    page: res.page || 1,
    page_size: res.page_size || limit,
  }
}

export async function getModDetail(id, lang = 'zh') {
  const res = await dbCall('db_get_mod_detail', { id: Number(id), lang })
  return { success: true, data: res.data }
}

export async function getModForEdit(id, author_id) {
  const res = await dbCall('db_get_mod_for_edit', { id: Number(id), author_id })
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

export async function createMod({ author_id, mod_key, translations, version, category }) {
  const res = await dbCall('db_create_mod', {
    author_id, mod_key,
    translations: normalizeTranslations(translations),
    version, category,
  })
  return { success: true, data: res.data }
}

export async function updateMod({ author_id, mod_id, version, category, translations }) {
  const res = await dbCall('db_update_mod', {
    author_id, mod_id: Number(mod_id),
    translations: normalizeTranslations(translations),
    version, category,
  })
  return { success: true, data: res.data }
}

export async function deleteMod({ author_id, modId }) {
  const res = await dbCall('db_delete_mod', { author_id, mod_id: Number(modId) })
  return { success: true }
}

export async function listMyMods({ author_id, lang = 'zh', page = 1, page_size = 20 } = {}) {
  const res = await dbCall('db_list_my_mods', { author_id, lang, page, page_size })
  return {
    success: true,
    mods: res.mods || [],
    total: res.total || 0,
    page: res.page || 1,
    page_size: res.page_size || page_size,
  }
}

// ── 文件上传（直传 ImgBed，然后存 URL 到 MySQL） ──

export async function getImgbedConfig() {
  return await invoke('db_get_imgbed_config')
}

export async function uploadModFile({ author_id, mod_id, lang_code, version, file }) {
  // 1. 读 ImgBed 配置
  const imgbed = await getImgbedConfig()

  // 2. 构造 FormData
  const formData = new FormData()
  formData.append('file', file)

  const folder = `sfm/${mod_id}/${lang_code}/${version || '1.0.0'}`
  const url = `${imgbed.url}/upload?uploadChannel=telegram&uploadFolder=${encodeURIComponent(folder)}&returnFormat=full`

  const uploadRes = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${imgbed.token}` },
    body: formData,
  })

  if (!uploadRes.ok) {
    const text = await uploadRes.text()
    throw new Error(`ImgBed upload failed: HTTP ${uploadRes.status} - ${text.slice(0, 200)}`)
  }

  const uploadData = await uploadRes.json()
  if (!Array.isArray(uploadData) || uploadData.length === 0) {
    throw new Error('ImgBed upload failed: unexpected response')
  }

  const { src, publicUrl } = uploadData[0]

  // 3. 计算 MD5（浏览器端）
  const fileHash = await computeMd5(file)

  // 4. 保存 URL 到 MySQL
  const saveRes = await dbCall('db_save_mod_file', {
    mod_id: Number(mod_id),
    author_id,
    lang_code,
    file_url: publicUrl || src,
    file_name: file.name,
    file_size: file.size,
    file_hash: fileHash,
    version: version || '1.0.0',
  })

  return {
    success: true,
    data: {
      lang_code,
      file_url: publicUrl || src,
      file_name: file.name,
      file_size: file.size,
      file_hash: fileHash,
      version: version || '1.0.0',
      reused: false,
    },
  }
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
  const res = await dbCall('db_delete_comment', { comment_id, author_id })
  return { success: true }
}

// ── 浏览器端 MD5（使用 SubtleCrypto） ──

async function computeMd5(file) {
  try {
    const buffer = await file.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest('MD5', buffer)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    // 如果不支持 MD5 则返回空字符串
    return ''
  }
}
