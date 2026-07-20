import Database from '@tauri-apps/plugin-sql'

export async function loadUserFromDb() {
  try {
    const db = await Database.load('sqlite:config.db')
    const rows = await db.select(
      "SELECT `key`, value FROM config WHERE `key` IN ('cloud_user_id', 'cloud_username', 'cloud_r2_enabled', 'cloud_avatar')"
    )
    const map = {}
    rows.forEach(r => { map[r.key] = r.value })
    if (map.cloud_user_id && map.cloud_username) {
      return { user_id: Number(map.cloud_user_id), username: map.cloud_username, r2_enabled: map.cloud_r2_enabled === '1', avatar: map.cloud_avatar || null }
    }
    return null
  } catch {
    return null
  }
}

export async function saveUserToDb(user) {
  try {
    const db = await Database.load('sqlite:config.db')
    const upsert = "INSERT OR REPLACE INTO config (id, `key`, value) VALUES ((SELECT id FROM config WHERE `key` = $1), $1, $2)"
    await db.execute(upsert, ['cloud_user_id', String(user.user_id)])
    await db.execute(upsert, ['cloud_username', user.username])
    await db.execute(upsert, ['cloud_r2_enabled', user.r2_enabled ? '1' : '0'])
    await db.execute(upsert, ['cloud_avatar', user.avatar || ''])
  } catch (e) {
    console.error('Failed to persist cloud user:', e)
  }
}

export async function clearUserFromDb() {
  try {
    const db = await Database.load('sqlite:config.db')
    await db.execute("DELETE FROM config WHERE `key` IN ('cloud_user_id', 'cloud_username', 'cloud_r2_enabled', 'cloud_avatar')")
  } catch (e) {
    console.error('Failed to clear cloud user:', e)
  }
}
