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

/** 游戏可执行文件名（游戏根目录下）。Rust 端 lib.rs 的 GAME_EXE_NAME / launch_game 与此保持一致。 */
export const GAME_EXE_NAME = 'SecretFlasherManaka.exe'

/**
 * 由游戏目录推导游戏主程序路径，用于校验所选目录是否含游戏本体。
 *
 * 不落库：唯一决定安装/启动位置的是 game_path，Rust 端 launch_game 也是自行
 * join 文件名，故无需持久化一个派生值（存了反而要处处维护它不被改目录改陈旧）。
 */
export function deriveExePath(gamePath) {
  return gamePath ? `${gamePath.replace(/[\\/]+$/, '')}\\${GAME_EXE_NAME}` : ''
}
