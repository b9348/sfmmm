import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getGamePath } from '../../services/dbHelper'

// 进程内缓存：同一 game_path 的 ok/unknown 结果复用（解析含解压操作，虽只读 <1MB 但免重复 IO）。
// blocked 不缓存——用户在设置页升级/换目录后必须能立刻解除提示；game_path 变更天然使缓存失效。
let cache = { gamePath: null, result: null }

/**
 * 游戏版本门控 hook：校验 bundleVersion 是否达到后端要求版本。
 * 判定全部在 Rust 后端（check_game_bundle_version），前端只消费三态结论，
 * blocked 时由 GameVersionBanner 提示并把安装按钮置灰。
 * 后端解析失败/目录未配置返回 unknown → allowed（fail-open）。
 * @returns {{ status: 'checking'|'allowed'|'blocked', version: string|null, required: string }}
 */
export function useGameVersionGuard() {
  const [gate, setGate] = useState({ status: 'checking', version: null, required: '' })
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const gamePath = await getGamePath()
        let res
        if (cache.gamePath === gamePath && cache.result) {
          res = cache.result
        } else {
          res = await invoke('check_game_bundle_version')
          if (res.status === 'ok' || res.status === 'unknown') {
            cache = { gamePath, result: res }
          }
        }
        if (cancelled) return
        setGate({
          status: res.status === 'blocked' ? 'blocked' : 'allowed',
          version: res.version,
          required: res.required,
        })
      } catch (e) {
        // invoke 异常（命令未注册等）→ fail-open，与后端 unknown 口径一致
        console.warn('[useGameVersionGuard] 版本校验失败，放行:', e)
        if (!cancelled) setGate({ status: 'allowed', version: null, required: '' })
      }
    })()
    return () => { cancelled = true }
  }, [])
  return gate
}
