import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getDb } from '../services/dbHelper'

/**
 * 读取本地已安装的创意工坊模组，检测是否有更新 / 来源冲突
 * @returns {{
 *   installed: Set<string>,
 *   updates: Map<string, string>,
 *   modDetails: Map<string, object>,
 *   cloudInfo: Map<string, { displayName?: string, latestVersion: string, latestFileHash?: string, hasUpdate: boolean }>,
 *   loading: boolean
 * }}
 */
export function useInstalledMods() {
  const [installed, setInstalled] = useState(new Set())
  const [updates, setUpdates] = useState(new Map())
  const [modDetails, setModDetails] = useState(new Map())
  const [cloudInfo, setCloudInfo] = useState(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const db = await getDb()
        const rows = await db.select('SELECT mod_key, installed_version, category, lang_code, manifest, file_hash, file_hashes FROM installed_workshop_mods')
        if (cancelled) return

        const installedSet = new Set(rows.map(r => r.mod_key))
        setInstalled(installedSet)

        const detailsMap = new Map()
        for (const r of rows) {
          detailsMap.set(r.mod_key, {
            version: r.installed_version,
            category: r.category,
            langCode: r.lang_code,
            manifest: r.manifest,
            fileHash: r.file_hash || '',
            fileHashes: r.file_hashes || '',
          })
        }
        setModDetails(detailsMap)

        if (rows.length > 0) {
          // 检测更新 + 云端当前版本/hash（用于与本地对比、撞车识别）
          const res = await invoke('db_check_updates', {
            installed: rows.map(r => ({
              mod_key: r.mod_key,
              installed_version: r.installed_version,
              lang_code: r.lang_code,
            })),
          })
          if (!cancelled && res?.data?.updates) {
            const updateMap = new Map()
            const cloudMap = new Map()
            for (const u of res.data.updates) {
              if (u.has_update) updateMap.set(u.mod_key, u.latest_version)
              cloudMap.set(u.mod_key, {
                displayName: u.display_name || undefined,
                latestVersion: u.latest_version || '',
                latestFileHash: u.latest_file_hash || undefined,
                ratingAvg: u.rating_avg || 0,
                ratingCount: u.rating_count || 0,
                hasUpdate: !!u.has_update,
              })
            }
            setUpdates(updateMap)
            setCloudInfo(cloudMap)
          }
        }
      } catch (e) {
        console.warn('[useInstalledMods] 读取失败:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  return { installed, updates, modDetails, cloudInfo, loading }
}
