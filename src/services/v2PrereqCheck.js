// v2 前置版本检测（供两处复用）：
//   - BepInExPrereqBanner（本地模组 v2 页前置卡片的"版本低于基准"提示）
//   - App.jsx 漫游引导（创意工坊「云」页聚光灯提醒更新 v2）
// 判定逻辑：插件 dll 存在且修改时间早于基准（V2_PREREQ_DLL_MTIME_MS，即 2.3.8
// 分发包内 dll 的原始 mtime）时，再用哈希复核——与基准哈希一致视为同版本
// （容忍 FAT/exFAT 时间戳粒度等误差），不一致才判 outdated。
// 基准常量与发布流程见 prereqPoints.js。
import { stat } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import {
  V2_PREREQ_MARKER,
  V2_PREREQ_DLL_MTIME_MS,
  V2_PREREQ_DLL_SHA256,
} from '../components/common/prereqPoints'

/**
 * 检测游戏目录已安装的 v2 前置版本状态。
 * @param {string} gamePath 游戏根目录
 * @returns {Promise<{installed: boolean, outdated: boolean}>}
 *   installed=false 表示插件不存在；outdated 仅在 installed=true 时有意义。
 *   任何检测异常（文件消失/哈希失败）都降级为不提示更新。
 */
export async function checkV2Prereq(gamePath) {
  const root = gamePath.replace(/\/+$/, '')
  let installed = false
  let outdated = false
  try {
    const info = await stat(`${root}/${V2_PREREQ_MARKER}`)
    installed = true
    if ((info?.lastModified ?? 0) < V2_PREREQ_DLL_MTIME_MS) {
      const hash = await invoke('db_hash_file', { path: `${root}/${V2_PREREQ_MARKER}` })
      outdated = hash !== V2_PREREQ_DLL_SHA256
    }
  } catch {
    // dll 缺失或哈希计算失败：哈希失败时 installed 已为 true、outdated 保持 false（安全降级）
  }
  return { installed, outdated }
}
