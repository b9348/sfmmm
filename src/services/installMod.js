import { exists, remove } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { getGamePath, getDb } from './dbHelper'

/**
 * 订阅下载（改造为后端执行）：创建后台任务并立即返回 taskId。
 *
 * 改造前：下载/解压/哈希/写库全在前端完成，离开页面即中断（经典 Web 跨端问题）。
 * 改造后：全链路迁至 Rust 后台任务（db/subscribe.rs），与前端组件生命周期解耦，
 *         进度通过全局事件 "subscription-progress" 广播，订阅记录页 listen 即可刷新。
 *
 * @param {object} params - 兼容旧签名的参数集
 * @param {string} [params.displayName] - 冗余存的工坊卡片显示名（订阅记录页离线展示用）
 * @param {string} [params.description] - 冗余存的简介
 * @param {object} [params.translations] - {zh:{name,…},…} 工坊翻译表，原样 JSON.stringify 存表
 * @returns {Promise<{ taskId: number, manifest: string|null }>} 任务已入队，立即返回
 */
export async function installMod({ modKey, category, fileUrl, version, fileHash, langCode, manifest, displayName, description, translations }) {
  const result = await invoke('db_subscribe_mod', {
    mod_key: modKey,
    mod_id: null,
    category,
    lang_code: langCode || '',
    version: version || '',
    file_url: fileUrl,
    file_hash: fileHash || '',
    retry_of: null,
    display_name: displayName || '',
    description: description || '',
    translations: translations ? JSON.stringify(translations) : '',
  })
  // manifest 参数保留兼容旧调用签名，后端会从解压结果自行生成
  return { taskId: result.taskId, manifest }
}

export async function uninstallMod({ modKey }) {
  const gamePath = await getGamePath()
  if (!gamePath) {
    throw new Error('未配置游戏路径')
  }

  const db = await getDb()
  const rows = await db.select('SELECT category, manifest FROM installed_workshop_mods WHERE mod_key = $1', [modKey])
  if (rows.length === 0) {
    throw new Error('未找到安装记录')
  }

  const { category, manifest } = rows[0]
  const base = gamePath.replace(/\/+$/, '')
  const pluginsDir = `${base}\\BepInEx\\plugins`

  if (category === 'dll') {
    // DLL: 按 manifest 逐个删除散落在 plugins 目录的文件
    const fileList = manifest ? JSON.parse(manifest) : []
    const dirsToCheck = new Set()
    for (const filePath of fileList) {
      const fullPath = `${pluginsDir}\\${filePath}`
      try {
        if (await exists(fullPath)) {
          await remove(fullPath)
        }
        // 收集父目录用于后续清理
        const parts = filePath.split('/')
        if (parts.length > 1) {
          dirsToCheck.add(`${pluginsDir}\\${parts.slice(0, -1).join('\\')}`)
        }
      } catch (e) {
        console.warn(`[uninstallMod] 删除文件失败: ${fullPath}`, e)
      }
    }
    // 尝试清理空目录（从深到浅）
    const sortedDirs = [...dirsToCheck].sort((a, b) => b.length - a.length)
    for (const dir of sortedDirs) {
      try {
        if (await exists(dir)) {
          await remove(dir)
        }
      } catch {
        // 目录非空则忽略
      }
    }
  } else if (category === 'v1') {
    // v1: 按 manifest 中的相对路径逐个删除文件，并清理空目录
    const fileList = manifest ? JSON.parse(manifest) : []
    const dirsToCheck = new Set()
    for (const filePath of fileList) {
      const normalizedPath = filePath.replace(/\//g, '\\')
      const fullPath = `${base}\\CustomMissions\\${normalizedPath}`
      try {
        if (await exists(fullPath)) {
          await remove(fullPath)
        }
        const parts = normalizedPath.split('\\')
        if (parts.length > 1) {
          dirsToCheck.add(`${base}\\CustomMissions\\${parts.slice(0, -1).join('\\')}`)
        }
      } catch (e) {
        console.warn(`[uninstallMod] 删除文件失败: ${fullPath}`, e)
      }
    }
    const sortedDirs = [...dirsToCheck].sort((a, b) => b.length - a.length)
    for (const dir of sortedDirs) {
      try {
        if (await exists(dir)) {
          await remove(dir)
        }
      } catch {
        // 目录非空则忽略
      }
    }
    // 兼容旧逻辑：尝试删除以 modKey 命名的旧目录
    try {
      const oldDir = `${base}\\CustomMissions\\${modKey}`
      if (await exists(oldDir)) {
        await remove(oldDir, { recursive: true })
      }
    } catch (e) {
      console.warn(`[uninstallMod] 删除旧目录失败: ${base}\\CustomMissions\\${modKey}`, e)
    }
  } else if (category === 'composite') {
    // composite：manifest 内是相对游戏根目录的全路径
    // （例如 "BepInEx/plugins/CosplayShop/xxx.dll"），逐个删除并清理空目录
    const fileList = manifest ? JSON.parse(manifest) : []
    const dirsToCheck = new Set()
    for (const filePath of fileList) {
      const normalizedPath = filePath.replace(/\//g, '\\')
      const fullPath = `${base}\\${normalizedPath}`
      try {
        if (await exists(fullPath)) {
          await remove(fullPath)
        }
        const parts = normalizedPath.split('\\')
        if (parts.length > 1) {
          dirsToCheck.add(`${base}\\${parts.slice(0, -1).join('\\')}`)
        }
      } catch (e) {
        console.warn(`[uninstallMod] 删除文件失败: ${fullPath}`, e)
      }
    }
    const sortedDirs = [...dirsToCheck].sort((a, b) => b.length - a.length)
    for (const dir of sortedDirs) {
      try {
        if (await exists(dir)) {
          await remove(dir)
        }
      } catch {
        // 目录非空则忽略
      }
    }
    // 兼容旧版（修复前多套一层 modKey 的残留）
    try {
      const oldDir = `${pluginsDir}\\${modKey}`
      if (await exists(oldDir)) {
        await remove(oldDir, { recursive: true })
      }
    } catch (e) {
      console.warn(`[uninstallMod] 删除旧目录失败: ${pluginsDir}\\${modKey}`, e)
    }
  } else {
    // v2: 删除整个 modKey 目录
    const targetDir = `${base}\\CustomMissions2\\${modKey}`
    try {
      if (await exists(targetDir)) {
        await remove(targetDir, { recursive: true })
      }
    } catch (e) {
      console.warn(`[uninstallMod] 删除目录失败: ${targetDir}`, e)
    }
  }

  // 删除 SQLite 安装记录
  await db.execute('DELETE FROM installed_workshop_mods WHERE mod_key = $1', [modKey])
  await db.execute('DELETE FROM installed_workshop_mod_files WHERE mod_key = $1', [modKey])
  // 注意：不置 subscription_tasks 为 cancelled——退订不改任务流表。
  // 重订时 db_subscribe_mod 的去重查询会校验 installed_workshop_mods 是否还在，
  // 不在则视为 done 失效允许新建重下重装；在则直接返回不重下。
  // 这样避免退订→置 cancelled→重订新建→又退订又置 cancelled 累积多条 cancelled 行。
}
