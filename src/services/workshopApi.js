/**
 * Workshop API 服务
 * 直连 MySQL，通过 Tauri invoke 调用 Rust 后端命令
 */

import JSZip from 'jszip'
import { uploadBlobViaTempFile } from './imgbedUpload'
import { dbCall, isConnectivityError } from './dbCall'
import { findCachedDiscussion, findCachedMod, makeCacheKey, writeRequestCache } from './requestCache'
import { getCachedRating } from './ratingCache'

/**
 * 用列表快照补出的详情是只读快照：作者身份可以确定，编辑权限按作者身份最小化给出；
 * 非作者无法从列表判断是否拥有协作者/编辑权限，统一给 false，避免误显示编辑入口。
 */
function offlinePermissions(mod, userId) {
  const isAuthor = userId != null && Number(mod.author_id) === Number(userId)
  return {
    is_author: isAuthor,
    can_edit_mod_info: isAuthor,
    can_edit_all_langs: isAuthor,
    editable_langs: null,
    can_apply_mod_info: false,
    can_apply_lang: false,
    applyable_langs: null,
    mode: 'author_only',
  }
}

/**
 * 缓存快照是否属于当前用户视角：双方都是匿名，或 user_id 完全一致。
 * 登录用户读到匿名快照时，快照里的 user_permissions / my_rating / my_boost
 * 都不代表当前用户，必须按当前身份重新推导。
 */
function sameUserAsCache(hit, userId) {
  const cached = hit.args?.user_id == null ? null : String(hit.args.user_id)
  if (userId == null) return cached == null
  return cached != null && cached === String(userId)
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

/**
 * 查询任意用户的公开资料
 * @returns {Promise<{user_id, username, avatar, mod_count, total_downloads, total_likes}>}
 */
export async function getUserPublicProfile(userId) {
  const res = await dbCall('db_get_user_public_profile', { user_id: Number(userId) })
  return res.data?.user || null
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

export async function listMods({ lang = 'zh', search, page = 1, limit = 20, sort_by, sort_order, device_id, category } = {}) {
  const map = (r) => ({
    success: true,
    mods: r.mods || [],
    total: r.total || 0,
    page: r.page || 1,
    page_size: r.page_size || limit,
    fromCache: !!r.__fromCache,
    cachedAt: r.__cachedAt || null,
    revalidate: r.__revalidate || null,
  })
  return dbCall('db_list_mods', {
    lang,
    search: search || null,
    page,
    limit,
    sort_by: sort_by || null,
    sort_order: sort_order || null,
    device_id: device_id || null,
    category: category || null,
  }, map)
}

// opts.force：跳过本地缓存直连网络（编辑/发布后刷新详情用）
export async function getModDetail(id, lang = 'zh', user_id, device_id, modKey = null, opts = {}) {
  const map = (r) => ({
    success: true,
    data: r.data,
    partial: !!r.data?.__partial,
    fromCache: !!r.__fromCache,
    cachedAt: r.__cachedAt || null,
    revalidate: r.__revalidate || null,
  })
  const args = {
    id: Number(id) || 0,
    mod_key: modKey || null,
    lang,
    user_id: user_id || null,
    device_id: device_id || null,
  }
  try {
    return await dbCall('db_get_mod_detail', args, map, opts)
  } catch (e) {
    // 详情从未缓存 + 云端暂不可达：退回列表快照里的同一条 mod。
    // 列表 DTO 已含名称/说明/翻译/文件等主体字段，足以离线只读浏览，
    // 避免通知跳转时只停在 mod 列表页。force（编辑后刷新）不回退旧数据。
    if (opts.force || !isConnectivityError(e)) throw e
    const hit = await findCachedMod(id, modKey, user_id, lang)
    if (!hit) throw e
    // 列表 DTO 没有 user_permissions；匿名详情缓存的权限/评分也不属于当前登录用户，
    // 只有「同一用户视角的完整详情」才能直接沿用。
    // 还要语言一致：详情 DTO 的 name/description 是按请求 lang 拍平的，
    // 跨语言详情虽然字段齐全，但正文语言与当前请求不符，按只读快照提示更诚实。
    const sameUser = sameUserAsCache(hit, user_id)
    const sameLang = !hit.args?.lang || !lang || String(hit.args.lang) === String(lang)
    const trustedDetail = hit.command === 'db_get_mod_detail' && !!hit.item.user_permissions && sameUser && sameLang
    const partial = !!hit.item.__partial || !trustedDetail
    // 列表/匿名快照的 my_rating 不可信（可能是默认 0 或他人评分），登录用户改读本地评分记录
    const cachedRating = user_id != null && (!sameUser || hit.item.my_rating == null)
      ? await getCachedRating(hit.item.id, user_id)
      : null
    const mod = {
      ...hit.item,
      // 避免离线显示 0 星
      my_rating: sameUser && hit.item.my_rating != null
        ? hit.item.my_rating
        : (cachedRating?.my_rating ?? 0),
      user_permissions: partial ? offlinePermissions(hit.item, user_id) : hit.item.user_permissions,
      __partial: partial,
    }
    const fallback = { success: true, data: { mod, __partial: partial } }
    // 等待合成缓存落库：下次打开同一详情直接命中精确 key，不再扫列表快照。
    // 沿用原快照时间，避免第二次打开时「缓存于」显示成刚刚
    await writeRequestCache(makeCacheKey('db_get_mod_detail', args), fallback, hit.cachedAt)
    return { ...fallback, fromCache: true, cachedAt: hit.cachedAt, partial, revalidate: null }
  }
}

export async function getModForEdit(id, user_id, force = false) {
  const res = await dbCall('db_get_mod_for_edit', { id: Number(id), user_id: Number(user_id) || 0, force: !!force })
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

export async function createMod({ author_id, mod_key, translations, category, is_original }) {
  const { data } = await dbCall('db_create_mod', {
    author_id, mod_key,
    translations: normalizeTranslations(translations),
    category,
    is_original: !!is_original,
  })
  return { success: true, data }
}

export async function updateMod({ author_id, mod_id, category, translations, is_original, mod_key = null, force = false }) {
  const { data } = await dbCall('db_update_mod', {
    author_id, mod_id: Number(mod_id),
    translations: normalizeTranslations(translations),
    category,
    is_original: typeof is_original === 'boolean' ? is_original : null,
    mod_key: mod_key || null,
    force: !!force,
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

// 强制删除（pnpm tauri dev）：先逐个删除图床物理文件，再由后端事务硬删除该 mod 的
// 全部云端关联数据（翻译/评论楼中楼/点赞评分收藏/权限协作者/申请/依赖/文件记录等）。
// 单个图床文件删除失败不阻断数据库清理（记录必须删掉）。
export async function forceDeleteMod({ modId, files = [] }) {
  for (const file of files) {
    if (!file?.file_url) continue
    try {
      await deleteImgbedFile(file.file_url)
    } catch (e) {
      console.warn('删除图床 mod 文件失败:', file.file_url, e)
    }
  }
  await dbCall('db_force_delete_mod', { mod_id: Number(modId) })
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

export async function listLikedMods({ device_id, lang = 'zh', page = 1, page_size = 20 } = {}) {
  const res = await dbCall('db_list_liked_mods', { device_id: device_id || null, lang, page, page_size })
  return {
    success: true,
    mods: res.mods || [],
    total: res.total || 0,
    page: res.page || 1,
    page_size: res.page_size || page_size,
  }
}

export async function listRatedMods({ user_id, lang = 'zh', page = 1, page_size = 20 } = {}) {
  const res = await dbCall('db_list_rated_mods', { user_id: Number(user_id), lang, page, page_size })
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

export async function rateMod(mod_id, user_id, rating) {
  const res = await dbCall('db_rate_mod', { mod_id: Number(mod_id), user_id: Number(user_id), rating })
  return res.data || { my_rating: rating, rating_avg: 0, rating_count: 0 }
}

export async function unrateMod(mod_id, user_id) {
  const res = await dbCall('db_unrate_mod', { mod_id: Number(mod_id), user_id: Number(user_id) })
  return res.data || { my_rating: 0, rating_avg: 0, rating_count: 0 }
}

export async function checkModKey(mod_key) {
  const res = await dbCall('db_check_mod_key', { mod_key })
  return res.data
}

// ── 文件上传（经 Rust 代理直传 ImgBed，前端不接触 Token，然后存 URL 到 MySQL） ──

const TELEGRAM_MAX_SIZE = 20 * 1024 * 1024 // 20MB
const R2_MAX_SIZE = 100 * 1024 * 1024 // 100MB

// 单文件上传：落到本地临时文件后由 Rust 流式上传并回报进度
function uploadFile({ file, folder, channel = 'telegram', onProgress, signal }) {
  return uploadBlobViaTempFile(file, { folder, channel, onProgress, signal })
}

export async function uploadModFile({ author_id, mod_id, lang_code, version, file, manifest, r2_enabled = false, onProgress, signal }) {
  // 1. 计算上传目录
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

  const uploadResult = await uploadFile({ file, folder, channel, onProgress, signal })
  const fileUrl = uploadResult.publicUrl || uploadResult.src

  // 3. 计算文件哈希（浏览器端）
  const fileHash = await computeFileHash(file)
  // 3.1 计算逐文件指纹（用于预检/补全；失败则留空由后端惰性补全）
  const fileHashes = await computeZipFileHashes(file)

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
    file_hashes: fileHashes,
  })

  return {
    success: true,
    data: {
      lang_code,
      file_url: fileUrl,
      file_name: file.name,
      file_size: file.size,
      file_hash: fileHash,
      file_hashes: fileHashes,
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

export async function addComment({ mod_id, author_id, content, parent_id, reply_to_id }) {
  const res = await dbCall('db_add_comment', { mod_id, author_id, content, parent_id: parent_id || null, reply_to_id: reply_to_id || null })
  return { success: true, data: res.data }
}

export async function getComments({ mod_id, page = 1, page_size = 10, sort_order, reply_order } = {}) {
  const map = (r) => ({
    success: true,
    comments: r.data?.comments || [],
    total: r.data?.total || 0,
    // 评论总数（含楼中楼），列表页 comment_count 同口径，用于详情页标题
    totalIncludingReplies: r.data?.total_including_replies || 0,
    page: r.data?.page || 1,
    page_size: r.data?.page_size || page_size,
    fromCache: !!r.__fromCache,
    cachedAt: r.__cachedAt || null,
    revalidate: r.__revalidate || null,
  })
  return dbCall('db_get_comments', { mod_id, page, page_size, sort_order: sort_order || null, reply_order: reply_order || null }, map)
}

export async function getCommentReplies({ comment_id, page = 1, page_size = 10, sort_order } = {}) {
  const map = (r) => ({
    success: true,
    replies: r.data?.replies || [],
    total: r.data?.total || 0,
    page: r.data?.page || 1,
    page_size: r.data?.page_size || page_size,
    fromCache: !!r.__fromCache,
    cachedAt: r.__cachedAt || null,
    revalidate: r.__revalidate || null,
  })
  return dbCall('db_get_replies', { comment_id, page, page_size, sort_order: sort_order || null }, map)
}

// 定位 mod 评论在详情页中的位置（通知跳转用）：所属一楼 id / 一楼页码 / 楼中楼内排名
export async function locateModComment({ comment_id, top_sort_order, reply_sort_order } = {}) {
  const res = await dbCall('db_locate_mod_comment', {
    comment_id,
    top_sort_order: top_sort_order || null,
    reply_sort_order: reply_sort_order || null,
  })
  return { success: true, data: res.data }
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

export async function markRead({ user_id, target_type, entity, ids }) {
  return await dbCall('db_mark_read', { user_id, target_type: target_type || null, entity: entity || null, ids: ids || null })
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

// 计算 zip 内每个文件的 SHA-256，返回 { basename(小写): hash } 的 JSON 字符串。
// 与后端 db_preflight_mod 的比对键一致（按文件名归一并小写），从而保证
// 上传/回填时写入云端的逐文件指纹，与安装后本地文件系统（含递归展开的嵌套 zip）比对口径相同。
// 关键：嵌套 zip 递归展开其内文件（与 installMod 的解压行为一致），而非跳过，
// 否则含嵌套包的 mod（如多包一层的 v1）在预检时会误报差异。
export async function computeZipFileHashes(file) {
  try {
    const zip = await JSZip.loadAsync(file)
    const map = {}
    await hashZipEntries(zip, map, 0)
    return JSON.stringify(map)
  } catch {
    return null
  }
}

// 递归遍历 zip 条目：普通文件算哈希（按 basename 小写归一键）；
// 嵌套 .zip 继续展开其內容（深度上限防止畸形包无限递归）。
// 注意：嵌套 zip 自身不入 map（与 installMod 解压一致——嵌套包不落盘为文件）。
async function hashZipEntries(zip, map, depth) {
  if (depth > 6) return
  const entries = Object.keys(zip.files)
  for (const path of entries) {
    const entry = zip.files[path]
    if (entry.dir) continue
    if (path.toLowerCase().endsWith('.zip')) {
      try {
        const data = await entry.async('uint8array')
        const inner = await JSZip.loadAsync(data)
        await hashZipEntries(inner, map, depth + 1)
      } catch {
        // 嵌套 zip 无法解析时跳过，不阻断整体哈希
      }
      continue
    }
    const content = await entry.async('uint8array')
    const hash = await sha256Bytes(content)
    const key = path.split('/').pop().toLowerCase()
    map[key] = hash
  }
}

async function sha256Bytes(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── 讨论区（独立于 mod 体系；帖子/投票/Boost/评论/我的历史） ──

// 帖子列表：sort_by = created_at | likes | boosts；d_type = regular | poll | 空（全部）
export async function listDiscussions({ page = 1, limit = 20, search, sort_by = 'created_at', sort_order, d_type = '', user_id } = {}) {
  const map = (r) => ({
    success: true,
    discussions: r.data?.discussions || [],
    total: r.data?.total || 0,
    page: r.data?.page || 1,
    page_size: r.data?.page_size || limit,
    fromCache: !!r.__fromCache,
    cachedAt: r.__cachedAt || null,
    revalidate: r.__revalidate || null,
  })
  return dbCall('db_list_discussions', {
    page,
    limit,
    search: search || null,
    sort_by: sort_by || null,
    sort_order: sort_order || null,
    d_type: d_type || null,
    user_id: user_id || null,
  }, map)
}

// opts.force：跳过本地缓存直连网络（编辑/发布后刷新详情用）
export async function getDiscussionDetail(id, user_id, opts = {}) {
  const map = (r) => ({
    success: true,
    data: r.data?.discussion || null,
    partial: !!r.data?.__partial,
    fromCache: !!r.__fromCache,
    cachedAt: r.__cachedAt || null,
    revalidate: r.__revalidate || null,
  })
  const args = { id: Number(id) || 0, user_id: user_id || null }
  try {
    return await dbCall('db_get_discussion_detail', args, map, opts)
  } catch (e) {
    // 与 mod 详情同理：详情缓存缺失时用讨论列表快照回退（boosts 等缺失字段由页面兜底）
    if (opts.force || !isConnectivityError(e)) throw e
    const hit = await findCachedDiscussion(id, user_id)
    if (!hit) throw e
    // 列表 DTO 只有 boost_count/my_boost，没有完整 boosts；有 boosts 数组说明命中的是完整详情。
    // 匿名详情缓存里的 my_boost 也不属于当前登录用户，按只读快照处理。
    const partial = !!hit.item.__partial
      || !Array.isArray(hit.item.boosts)
      || !sameUserAsCache(hit, user_id)
    const discussion = {
      ...hit.item,
      // 页面按 boostCount 显示离线占位
      boosts: Array.isArray(hit.item.boosts) ? hit.item.boosts : [],
      __partial: partial,
    }
    const fallback = { success: true, data: { discussion, __partial: partial } }
    await writeRequestCache(makeCacheKey('db_get_discussion_detail', args), fallback, hit.cachedAt)
    return { ...fallback, fromCache: true, cachedAt: hit.cachedAt, partial, revalidate: null }
  }
}

// poll: { poll_type: 'single'|'multiple'|'number', min?, max?, step?, results_visibility?, options: [label,...] }
export async function createDiscussion({ author_id, title, content, content_format = 'markdown', d_type = 'regular', poll = null }) {
  const res = await dbCall('db_create_discussion', {
    author_id,
    title,
    content,
    content_format: content_format || null,
    d_type: d_type || null,
    poll: poll || null,
  })
  return { success: true, data: res.data }
}

export async function updateDiscussion({ author_id, discussion_id, title, content, content_format = 'markdown' }) {
  const res = await dbCall('db_update_discussion', {
    author_id,
    discussion_id: Number(discussion_id),
    title: title || null,
    content: content || null,
    content_format: content_format || null,
  })
  return { success: true, data: res.data }
}

export async function deleteDiscussion({ author_id, discussion_id }) {
  await dbCall('db_delete_discussion', { author_id, discussion_id: Number(discussion_id) })
  return { success: true }
}

// ── 讨论区互动：点赞 / Boost ──

export async function likeDiscussion({ discussion_id, user_id }) {
  const res = await dbCall('db_like_discussion', { discussion_id: Number(discussion_id), user_id })
  return { success: true, data: res.data }
}

export async function unlikeDiscussion({ discussion_id, user_id }) {
  const res = await dbCall('db_unlike_discussion', { discussion_id: Number(discussion_id), user_id })
  return { success: true, data: res.data }
}

// boost 内容 ≤16 字符；每人对每帖 ≤1 条
export async function boostDiscussion({ discussion_id, user_id, content }) {
  const res = await dbCall('db_boost_discussion', { discussion_id: Number(discussion_id), user_id, content })
  return { success: true, data: res.data }
}

export async function unboostDiscussion({ discussion_id, user_id }) {
  const res = await dbCall('db_unboost_discussion', { discussion_id: Number(discussion_id), user_id })
  return { success: true, data: res.data }
}

// ── 讨论区投票 ──

// single: option_ids=[n]；multiple: option_ids=[n1,n2]；number: value=n
export async function votePoll({ poll_id, discussion_id, user_id, option_ids = [], value = null }) {
  const res = await dbCall('db_vote_poll', {
    poll_id: Number(poll_id),
    discussion_id: Number(discussion_id),
    user_id,
    option_ids: option_ids.length > 0 ? option_ids : null,
    value: value ?? null,
  })
  return { success: true, data: res.data }
}

export async function getPollResults({ poll_id, user_id }) {
  const res = await dbCall('db_get_poll_results', { poll_id: Number(poll_id), user_id: user_id || null })
  return { success: true, data: res.data }
}

// ── 讨论区评论（镜像 mod 评论结构，供 CommentSection 泛化复用） ──

export async function addDiscussionComment({ discussion_id, author_id, content, parent_id, reply_to_id }) {
  const res = await dbCall('db_add_discussion_comment', { discussion_id, author_id, content, parent_id: parent_id || null, reply_to_id: reply_to_id || null })
  return { success: true, data: res.data }
}

export async function getDiscussionComments({ discussion_id, page = 1, page_size = 10, sort_order, reply_order } = {}) {
  const map = (r) => ({
    success: true,
    comments: r.data?.comments || [],
    total: r.data?.total || 0,
    totalIncludingReplies: r.data?.total_including_replies || 0,
    page: r.data?.page || 1,
    page_size: r.data?.page_size || page_size,
    fromCache: !!r.__fromCache,
    cachedAt: r.__cachedAt || null,
    revalidate: r.__revalidate || null,
  })
  return dbCall('db_get_discussion_comments', { discussion_id, page, page_size, sort_order: sort_order || null, reply_order: reply_order || null }, map)
}

export async function getDiscussionReplies({ comment_id, page = 1, page_size = 10, sort_order } = {}) {
  const map = (r) => ({
    success: true,
    replies: r.data?.replies || [],
    total: r.data?.total || 0,
    page: r.data?.page || 1,
    page_size: r.data?.page_size || page_size,
    fromCache: !!r.__fromCache,
    cachedAt: r.__cachedAt || null,
    revalidate: r.__revalidate || null,
  })
  return dbCall('db_get_discussion_replies', { comment_id, page, page_size, sort_order: sort_order || null }, map)
}

// 定位评论在详情页中的位置（通知跳转用）：所属一楼 id / 一楼页码 / 楼中楼内排名
export async function locateDiscussionComment({ comment_id, top_sort_order, reply_sort_order } = {}) {
  const res = await dbCall('db_locate_discussion_comment', {
    comment_id,
    top_sort_order: top_sort_order || null,
    reply_sort_order: reply_sort_order || null,
  })
  return { success: true, data: res.data }
}

export async function deleteDiscussionComment({ comment_id, author_id }) {
  await dbCall('db_delete_discussion_comment', { comment_id, author_id })
  return { success: true }
}

export async function editDiscussionComment({ comment_id, author_id, content }) {
  const res = await dbCall('db_edit_discussion_comment', { comment_id, author_id, content })
  return { success: true, data: res.data }
}

// ── 我点赞过的讨论帖（与 listLikedMods 对称为「点赞」页右栏）──

export async function listLikedDiscussions({ user_id, page = 1, page_size = 20 } = {}) {
  const res = await dbCall('db_list_liked_discussions', { user_id: Number(user_id), page, page_size })
  return {
    success: true,
    discussions: res.data?.discussions || [],
    total: res.data?.total || 0,
    page: res.data?.page || 1,
    page_size: res.data?.page_size || page_size,
  }
}

// ── 讨论区「我的」历史 ──

export async function listMyDiscussions({ author_id, page = 1, page_size = 20, user_id } = {}) {
  const res = await dbCall('db_list_my_discussions', { author_id, page, page_size, user_id: user_id || null })
  return {
    success: true,
    discussions: res.data?.discussions || [],
    total: res.data?.total || 0,
    page: res.data?.page || 1,
    page_size: res.data?.page_size || page_size,
  }
}

// 我的回复（含楼中楼）：comment_id / discussion_id / discussion_title / is_reply
export async function listMyDiscussionComments({ author_id, page = 1, page_size = 20 } = {}) {
  const res = await dbCall('db_list_my_discussion_comments', { author_id, page, page_size })
  return {
    success: true,
    comments: res.data?.comments || [],
    total: res.data?.total || 0,
    page: res.data?.page || 1,
    page_size: res.data?.page_size || page_size,
  }
}
