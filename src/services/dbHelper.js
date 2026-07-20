/**
 * SQLite 配置读写工具
 * 封装 config 表的常用操作，复用数据库连接实例
 */

import Database from '@tauri-apps/plugin-sql'

let dbPromise = null

export async function getDb() {
  if (!dbPromise) {
    dbPromise = Database.load('sqlite:config.db')
  }
  return dbPromise
}

export async function getConfig(key) {
  const db = await getDb()
  const rows = await db.select('SELECT value FROM config WHERE `key` = $1', [key])
  return rows.length > 0 ? rows[0].value : null
}

export async function getConfigs(keys) {
  const db = await getDb()
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await db.select(
    'SELECT `key`, value FROM config WHERE `key` IN (' + placeholders + ')',
    keys
  )
  const map = {}
  rows.forEach(r => { map[r.key] = r.value })
  return map
}

export async function setConfig(key, value) {
  const db = await getDb()
  await db.execute(
    'INSERT OR REPLACE INTO config (id, `key`, value) VALUES ((SELECT id FROM config WHERE `key` = $1), $1, $2)',
    [key, String(value)]
  )
}

export async function getGamePath() {
  const path = await getConfig('game_path')
  return path || ''
}