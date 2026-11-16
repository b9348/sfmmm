/**
 * 公告已读/已展示记录：只按设备记录 announcement_id，
 * 同一台电脑换账号共享；服务端不保存任何已读状态。
 */
import { getDb } from './dbHelper'

/** 读取本机已读/已展示的公告 ID 集合。 */
export async function getAnnouncementReadIds() {
  const db = await getDb()
  const rows = await db.select('SELECT announcement_id FROM announcement_reads')
  const ids = new Set()
  for (const row of rows) {
    const id = Number(row.announcement_id)
    if (Number.isSafeInteger(id) && id > 0) ids.add(id)
  }
  return ids
}

/** 写入一条公告已读/已展示记录；重复写入是幂等的。 */
export async function markAnnouncementRead(id) {
  const numericId = Number(id)
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new Error(`无效的公告 ID: ${id}`)
  }
  const db = await getDb()
  await db.execute(
    'INSERT OR IGNORE INTO announcement_reads (announcement_id) VALUES ($1)',
    [numericId],
  )
}
