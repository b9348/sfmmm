import { exists, remove } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { getGamePath, getDb } from './dbHelper'
import { blockInvalidPath, isSafeRelativePath } from './pathCheck'

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
 * @param {boolean} [params.force] - 用户手动点"重新安装"：跳过后端去重强制重下重装。
 *   用于兜底"文件被误删/被改坏但磁盘探测察觉不到"的场景——后端只校验文件是否存在，
 *   发现不了内容损坏，故需用户显式表达意图。
 * @returns {Promise<{ taskId: number, manifest: string|null, deduplicated: boolean }|null>}
 *   deduplicated=true 表示后端命中去重、未新建任务（不会再有 subscription-progress
 *   事件），调用方必须据此避免写"等待中"占位，否则按钮会永久禁用。
 *   返回 null 表示游戏路径含中文等非 ASCII 字符、已弹窗提示且未发起任何任务。
 */
export async function installMod({ modKey, category, fileUrl, version, fileHash, langCode, manifest, displayName, description, translations, force }) {
  // BepInEx 无法在中文路径下注入：安装前先拦下并弹 Windows 警告框，直接结束。
  // 所有安装入口（工坊详情页、模组更新）都走本函数，故在此统一检测。
  if (await blockInvalidPath(await getGamePath())) return null
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
    force: !!force,
  })
  // deduplicated 必须透传：后端命中去重时不会 spawn 任务，也就不会广播任何
  // subscription-progress 事件；调用方若不知情就会写下一个永不被兑现的"等待中"占位。
  // manifest 参数保留兼容旧调用签名，后端会从解压结果自行生成。
  return { taskId: result.taskId, manifest, deduplicated: !!result.deduplicated }
}

/**
 * 下载前预检：用新版本 manifest 与本地文件系统 / 本地安装记录比对。
 *
 * - conflicts：将被覆盖的文件。来自其他 mod / 非 mod 文件必提示；本 mod 自身的
 *   旧文件只有内容确实变了（云端逐文件指纹 ≠ 本地 SHA-256）才提示，内容一致视为幂等
 * - staleFiles：本次语言的旧 manifest 有、新 manifest 没有、磁盘上仍存在的文件，
 *   即作者已在新版本移除但客户端不会自动清理的残留（仅提示，不提供自动删除）
 *
 * 必须在调用 installMod 之前执行：此时尚未下载，预检零流量。
 * manifest 为云端 `mod_files.manifest`（作者上传时生成，目录条目以 "/" 结尾）。
 *
 * @returns {Promise<{checked:boolean, totalFiles:number, conflictCount:number,
 *   conflicts:Array<{path:string,owner:string,ownerName:string,
 *     kind:'other_mod'|'self_update'|'user_file'}>,
 *   hasNestedZip:boolean, staleCount:number,
 *   staleFiles:string[], staleUnknown:boolean, invalidPaths:string[]}>}
 */
export async function checkModOverwrite({ modKey, category, manifest, langCode }) {
  // 预检只用于提示：给整个调用一个短时限兜底（后端已把磁盘扫描挪到 blocking
  // 线程、云端指纹查询限时 3s）。超时抛错，调用方按"放行"继续安装，
  // 不能让预检把安装启动拖到前端超时。
  let timer = null
  try {
    return await Promise.race([
      invoke('db_check_mod_overwrite', {
        mod_key: modKey,
        category: category || '',
        manifest: manifest || '',
        lang_code: langCode || '',
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('OVERWRITE_CHECK_TIMEOUT')), 8000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 仅下载不安装：把 mod 压缩包原样存到 `<游戏根目录>\sfmmmDownloads\`。
 *
 * 与 installMod 分开的原因：安装链路要解压到 BepInEx/CustomMisions* 并写
 * installed_workshop_mods；这里只落盘原始 zip，不碰任何安装记录，用户自行取用。
 * 后端同样独立在 db/archive.rs，与订阅安装任务不共享状态。
 *
 * 进度不再由调用方维护：后端广播 archive-download-progress，App 级全局下载中心
 * 统一消费，任何页面（含离开后重新进入的详情页）都能显示同一份进度。
 *
 * @returns {Promise<{status: string, taskId?: number, path: string, dir: string}>}
 *   - "started"     → 已入队，下载在后台跑，用 archive-download-progress 事件看进度；
 *   - "downloading" → 同一文件正在下载，复用了后端既有任务（不会再有新任务事件）；
 *   - "exists"      → 目标文件已存在，后端未重复下载。
 */
export async function downloadModArchive({ modKey, langCode, version, fileUrl, fileName, displayName }) {
  return await invoke('db_download_mod_archive', {
    mod_key: modKey,
    lang_code: langCode || '',
    version: version || '',
    file_url: fileUrl,
    file_name: fileName || '',
    // 悬浮下载条与「离开页面后恢复进度」展示用：后端把它存进任务快照，
    // 恢复查询拿到的是同一份显示名。缺省时前端回退到 mod_key。
    display_name: displayName || '',
  })
}

/**
 * 解析安装记录 manifest，并过滤掉非法路径（盘符/含冒号/`..`），同时把前导 `/`
 * 与反斜杠规范化，返回可直接拼接的相对路径。卸载会按这些条目拼本地路径并删除，
 * 历史 manifest 若带非法写法必须跳过，否则可能删到游戏目录之外；跳过的具体路径
 * 打到控制台便于排查。
 */
function safeManifestList(manifest) {
  let parsed
  try {
    parsed = manifest ? JSON.parse(manifest) : []
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out = []
  for (const p of parsed) {
    if (!isSafeRelativePath(p)) {
      console.warn(`[uninstallMod] 跳过非法清单路径: ${p}`)
      continue
    }
    const norm = p.replace(/\\/g, '/').replace(/^\/+/, '')
    if (norm) out.push(norm)
  }
  return out
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
    const fileList = safeManifestList(manifest)
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
    // v1: 按 manifest 中的相对路径逐个删除文件，并清理空目录。
    // 安装记录含目录条目（末尾 /），只收集父目录无法清掉多级空目录链，
    // 这里对每个条目收集「自身 + 所有祖先目录」（不越过 CustomMissions 根）。
    const fileList = safeManifestList(manifest)
    const dirsToCheck = new Set()
    for (const filePath of fileList) {
      const isDir = filePath.endsWith('/')
      const normalizedPath = filePath.replace(/\//g, '\\').replace(/\\+$/, '')
      const fullPath = `${base}\\CustomMissions\\${normalizedPath}`
      try {
        if (!isDir && await exists(fullPath)) {
          await remove(fullPath)
        }
        const parts = normalizedPath.split('\\').filter(Boolean)
        for (let i = parts.length; i > 0; i -= 1) {
          dirsToCheck.add(`${base}\\CustomMissions\\${parts.slice(0, i).join('\\')}`)
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
    // 安装记录含目录条目（末尾 /）；与 v1 一样收集每个条目的祖先目录链，
    // 清理空目录直到游戏根下（不会越过游戏根）。
    const fileList = safeManifestList(manifest)
    const dirsToCheck = new Set()
    for (const filePath of fileList) {
      const isDir = filePath.endsWith('/')
      const normalizedPath = filePath.replace(/\//g, '\\').replace(/\\+$/, '')
      const fullPath = `${base}\\${normalizedPath}`
      try {
        if (!isDir && await exists(fullPath)) {
          await remove(fullPath)
        }
        const parts = normalizedPath.split('\\').filter(Boolean)
        // 至少保留一级顶层目录（如 BepInEx），不把游戏根下的公共目录删掉
        for (let i = parts.length; i > 1; i -= 1) {
          dirsToCheck.add(`${base}\\${parts.slice(0, i).join('\\')}`)
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
