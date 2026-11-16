import { useCallback, useEffect, useState } from 'react'
import { getConfig, setConfig } from '../services/dbHelper'

/**
 * 读取并持久化一个数字配置（存 sqlite config 表）。
 * 读取时做范围校验；写入 fire-and-forget，失败只告警，不阻塞 UI。
 */
export function usePersistedNumber(key, { defaultValue = 3, min = 1, max = 10, logTag = 'usePersistedNumber' } = {}) {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const raw = await getConfig(key)
        if (cancelled || raw === null) return
        const parsed = parseInt(raw, 10)
        if (!Number.isNaN(parsed) && parsed >= min && parsed <= max) {
          setValue(parsed)
        }
      } catch (e) {
        console.warn(`[${logTag}] 读取 ${key} 失败:`, e)
      }
    }
    load()
    return () => { cancelled = true }
  }, [key, min, max, logTag])

  const setAndPersist = useCallback((next) => {
    const parsed = typeof next === 'number' ? next : parseInt(next, 10)
    if (Number.isNaN(parsed)) return
    const clamped = Math.min(max, Math.max(min, parsed))
    setValue(clamped)
    setConfig(key, String(clamped)).catch(e => {
      console.warn(`[${logTag}] 保存 ${key} 失败:`, e)
    })
  }, [key, min, max, logTag])

  return [value, setAndPersist]
}
