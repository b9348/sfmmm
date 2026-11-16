/**
 * 旧版账号（0.3.x 直连架构）的本地留存与恢复。
 *
 * 1.0.x 起登录态由服务端令牌支撑，旧版本地只有 cloud_user_id / cloud_username。
 * AuthContext 在清理这份旧登录态前，会先把它写进 legacy_accounts，
 * 供启动弹窗和用户名菜单「检测旧版账号」读取。
 *
 * 静音标记存在 config 表：`legacy_accounts_notice_muted`。
 */
import { invoke } from '@tauri-apps/api/core'
import { getDb, getConfig, setConfig } from './dbHelper'
import { dbCall } from './dbCall'

const MUTE_KEY = 'legacy_accounts_notice_muted'
const LEGACY_CONFIG_KEYS = ['cloud_user_id', 'cloud_username', 'cloud_r2_enabled', 'cloud_avatar']

/** 把旧版登录态写入 legacy_accounts（同 user_id 覆盖更新，保留最近一次检测时间）。 */
export async function saveLegacyAccount(account) {
  if (!account?.user_id || !account?.username) return
  const db = await getDb()
  await db.execute(
    `INSERT OR REPLACE INTO legacy_accounts (user_id, username, avatar, r2_enabled, detected_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
    [
      Number(account.user_id),
      String(account.username),
      account.avatar || '',
      account.r2_enabled ? 1 : 0,
    ],
  )
}

/** 读取本机记录的全部旧版账号（按最近检测时间倒序）。 */
export async function listLegacyAccounts() {
  const db = await getDb()
  const rows = await db.select(
    'SELECT user_id, username, avatar, r2_enabled FROM legacy_accounts ORDER BY detected_at DESC, user_id DESC',
  )
  return rows
    .map((r) => ({
      user_id: Number(r.user_id),
      username: r.username,
      avatar: r.avatar || null,
      r2_enabled: Number(r.r2_enabled) === 1,
    }))
    .filter((r) => Number.isSafeInteger(r.user_id) && r.user_id > 0 && r.username)
}

/**
 * 从本地只读缓存里回收「已经被 1.0.0/1.0.1 清掉 cloud_user_*」的旧账号。
 *
 * 只能使用「必定属于本人」的数据源，避免把看过的其他用户误报成旧账号：
 * - db_list_my_discussions：只有「我的讨论」页会调用，cache_key 里带本人 author_id；
 * - 通知缓存里的 user_id 也是本人；
 * - 再用本人 uid 去匹配 db_list_my_mods / db_get_user_public_profile 缓存里的用户名。
 */
async function scanCachedLegacyAccounts(seen) {
  const found = []
  try {
    const db = await getDb()

    // 先收「本人 uid」：通知缓存按当前账号写入，user_id 一定是本人。
    const selfIds = new Set()
    try {
      const rows = await db.select(
        'SELECT DISTINCT user_id FROM user_notifications_cache WHERE user_id > 0 LIMIT 20',
      )
      rows.forEach((r) => {
        const id = Number(r.user_id)
        if (Number.isSafeInteger(id) && id > 0) selfIds.add(id)
      })
    } catch { /* 表未建立或为空时忽略 */ }

    // 只有「我的讨论」是无歧义的本人来源：顺势补进 selfIds，供后面的 mods/资料缓存匹配。
    const discussionSource = { command: 'db_list_my_discussions', arrayKey: 'discussions' }
    const discussionRows = await db.select(
      'SELECT cache_key FROM request_cache WHERE cache_key LIKE $1 ORDER BY cached_at DESC LIMIT 6',
      [`${discussionSource.command}?%`],
    )
    for (const row of discussionRows) {
      const key = row.cache_key
      let args
      try { args = JSON.parse(key.slice(key.indexOf('?') + 1)) } catch { continue }
      const uid = Number(args.author_id)
      if (!Number.isSafeInteger(uid) || uid <= 0) continue
      selfIds.add(uid)
      if (seen.has(uid)) continue
      const payload = await readCachePayload(db, key)
      const item = findAuthorInPayload(payload, discussionSource.arrayKey, uid)
      if (item) {
        found.push({ user_id: uid, username: item.username, avatar: item.avatar || null, r2_enabled: false })
        seen.add(uid)
      }
    }

    // 本人 uid 已明确时，再从「我的模组 / 用户资料」缓存里补用户名。
    const cachedSources = [
      { command: 'db_list_my_mods', arrayKey: 'mods', idKey: 'author_id' },
      { command: 'db_get_user_public_profile', arrayKey: 'user', idKey: 'user_id' },
    ]
    for (const source of cachedSources) {
      if (!selfIds.size) break
      const rows = await db.select(
        'SELECT cache_key FROM request_cache WHERE cache_key LIKE $1 ORDER BY cached_at DESC LIMIT 6',
        [`${source.command}?%`],
      )
      for (const row of rows) {
        const key = row.cache_key
        let args
        try { args = JSON.parse(key.slice(key.indexOf('?') + 1)) } catch { continue }
        const uid = Number(args[source.idKey])
        if (!selfIds.has(uid) || seen.has(uid)) continue
        const payload = await readCachePayload(db, key)
        const item = source.command === 'db_get_user_public_profile'
          ? findPublicProfileInPayload(payload, uid)
          : findAuthorInPayload(payload, source.arrayKey, uid)
        if (item) {
          found.push({ user_id: uid, username: item.username, avatar: item.avatar || null, r2_enabled: false })
          seen.add(uid)
        }
      }
    }
  } catch (e) {
    console.warn('[legacy-account] 扫描本地缓存失败:', e)
  }
  return found
}

async function readCachePayload(db, key) {
  try {
    const rows = await db.select('SELECT payload FROM request_cache WHERE cache_key = $1', [key])
    return rows.length ? JSON.parse(rows[0].payload) : null
  } catch {
    return null
  }
}

function findAuthorInPayload(payload, arrayKey, uid) {
  const items = payload?.data?.[arrayKey] ?? payload?.[arrayKey]
  if (!Array.isArray(items)) return null
  const item = items.find((it) => Number(it?.author_id) === uid && it?.author_name)
  return item ? { username: item.author_name, avatar: item.author_avatar || null } : null
}

function findPublicProfileInPayload(payload, uid) {
  const user = payload?.data?.user ?? payload?.user
  if (!user || Number(user.id ?? user.user_id) !== uid || !user.username) return null
  return { username: user.username, avatar: user.avatar || null }
}

/**
 * 检测旧版账号：legacy_accounts 为主；若 AuthContext 还没来得及落库，
 * 再兜底读 config 里尚未被清理的 cloud_user_*（仅限当前没有服务端令牌时）。
 * 最后扫描本地缓存，尽量找回 1.0.0/1.0.1 已经清掉的旧账号。
 */
export async function detectLegacyAccounts() {
  const accounts = await listLegacyAccounts()
  const seen = new Set(accounts.map((a) => a.user_id))

  try {
    const hasSession = await invoke('db_has_session')
    if (!hasSession) {
      const db = await getDb()
      const rows = await db.select(
        'SELECT `key`, value FROM config WHERE `key` IN ($1, $2, $3, $4)',
        LEGACY_CONFIG_KEYS,
      )
      const map = {}
      rows.forEach((r) => { map[r.key] = r.value })
      const userId = Number(map.cloud_user_id)
      if (Number.isSafeInteger(userId) && userId > 0 && map.cloud_username && !seen.has(userId)) {
        accounts.unshift({
          user_id: userId,
          username: map.cloud_username,
          avatar: map.cloud_avatar || null,
          r2_enabled: map.cloud_r2_enabled === '1',
        })
      }
    }
  } catch (e) {
    console.warn('[legacy-account] 读取 config 旧账号失败:', e)
  }

  // 本地完全没有留档时才扫缓存：这是给已经被 1.0.0/1.0.1 清掉 cloud_user_* 的用户兜底，
  // 正常情况下 legacy_accounts 已有记录，没必要在启动时解析大体积缓存。
  if (!accounts.length) {
    const cached = await scanCachedLegacyAccounts(new Set())
    accounts.push(...cached)
  }

  return accounts
}

/** 启动弹窗是否已被「不再提醒」静音（手动检测不受影响）。 */
export async function isLegacyNoticeMuted() {
  return (await getConfig(MUTE_KEY)) === 'true'
}

export async function setLegacyNoticeMuted(muted) {
  await setConfig(MUTE_KEY, muted ? 'true' : 'false')
}

/**
 * 用旧版账号（user_id + username）向服务端换取 1.0.x 令牌。
 * 成功时返回的 data 结构与 db_login 一致：{ user_id, username, r2_enabled, avatar }。
 */
export async function legacyLogin(account) {
  const res = await dbCall('db_legacy_login', {
    user_id: Number(account.user_id),
    username: account.username,
  })
  if (!res?.success) throw new Error(res?.message || 'Legacy login failed')
  return res
}
