import { useState, useEffect } from 'react'
import Database from '@tauri-apps/plugin-sql'
import { invoke } from '@tauri-apps/api/core'

/**
 * 读取本地已安装的创意工坊模组，检测是否有更新
 * @returns {{ installed: Set<string>, updates: Map<string, string>, modDetails: Map<string, object>, loading: boolean }}
 */
export function useInstalledMods() {
  const [installed, setInstalled] = useState(new Set())
  const [updates, setUpdates] = useState(new Map())
  const [modDetails, setModDetails] = useState(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const db = await Database.load('sqlite:config.db')
        const rows = await db.select('SELECT mod_key, installed_version, category, lang_code, manifest FROM installed_workshop_mods')
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
          })
        }
        setModDetails(detailsMap)

        if (rows.length > 0) {
          // 检测更新
          const res = await invoke('db_check_updates', {
            installed: rows.map(r => ({
              mod_key: r.mod_key,
              installed_version: r.installed_version,
              lang_code: r.lang_code,
            })),
          })
          if (!cancelled && res?.data?.updates) {
            const updateMap = new Map()
            for (const u of res.data.updates) {
              updateMap.set(u.mod_key, u.latest_version)
            }
            setUpdates(updateMap)
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

  return { installed, updates, modDetails, loading }
}
