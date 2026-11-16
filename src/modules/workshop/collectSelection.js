import { readFile, readDir } from '@tauri-apps/plugin-fs'

/**
 * 本类别安装时相对游戏根的落点（与 Rust 端 derive_local_root 同口径）：
 * composite → 游戏根；v1 → CustomMissions；v2 → CustomMissions2/<mod_key>；
 * dll → BepInEx/plugins。
 */
function installBaseDir(gamePath, category, modKey) {
  const root = (gamePath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return ''
  switch (category) {
    case 'dll':
      return `${root}/BepInEx/plugins`
    case 'v1':
      return `${root}/CustomMissions`
    case 'v2': {
      const key = String(modKey || '').trim()
      if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) return root
      return `${root}/CustomMissions2/${key}`
    }
    default:
      return root
  }
}

/** absPath 相对 base 的路径；不在 base 之下返回 null（大小写不敏感）。 */
function relativeUnder(base, absPath) {
  const baseNorm = (base || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const absNorm = (absPath || '').replace(/\\/g, '/')
  if (!baseNorm) return null
  if (absNorm.toLowerCase() === baseNorm.toLowerCase()) return ''
  if (absNorm.toLowerCase().startsWith(baseNorm.toLowerCase() + '/')) {
    return absNorm.slice(baseNorm.length + 1)
  }
  return null
}

/**
 * 把一条用户选择（文件夹 or 文件）转换成 zip 内条目。
 *
 * 路径策略（统一 v1 / composite / dll 语义）：
 *   - 若选择位于该类别安装根之下：zipPath = 相对安装根的路径（用 / 分隔）。
 *     安装根按 category 推导：composite→游戏根、v1→CustomMissions、
 *     v2→CustomMissions2/<mod_key>、dll→BepInEx/plugins。
 *     这样 manifest 条目始终相对安装 target_dir，不会把父文件夹写进路径。
 *   - 不在安装根之下但位于游戏目录下：退回相对游戏根（兼容手动选择游戏内其他位置）。
 *   - 再不在游戏目录下（外部目录）：fallback 为 "最后一段目录名/文件名"，
 *     仍保留"用户选择顶层"的可见性。
 *
 * 空文件夹忠实记录：
 *   - 选择文件夹时，其下任何空目录（含选择本身就是空文件夹的情况）
 *     都会在 dirs 中留下条目，压缩阶段由调用方 zip.folder() 显式写入。
 *
 * @param {object}  opts
 * @param {string}  opts.selection        用户选择的绝对路径
 * @param {boolean} opts.isDirectory      是否是文件夹
 * @param {string}  opts.gamePath         游戏根目录（绝对路径）
 * @param {string}  [opts.category]       v1 / v2 / dll / composite
 * @param {string}  [opts.modKey]         v2 的 mod_key
 * @returns {Promise<{ files: Array<{zipPath:string,data:Uint8Array,size:number}>, dirs: string[] }>}
 */
export async function collectOneSelection({
  selection, isDirectory, gamePath, category, modKey,
}) {
  const files = []
  const dirs = []

  // 优先按安装根取相对路径；再看游戏根；最后退回 parentDir/fileName。
  const computeZipPath = (absPath) => {
    const base = installBaseDir(gamePath, category, modKey)
    const relBase = relativeUnder(base, absPath)
    if (relBase != null) return relBase
    const relGame = relativeUnder(gamePath, absPath)
    if (relGame != null) return relGame
    const parts = absPath.replace(/\\/g, '/').split('/')
    const fileName = parts.pop() || ''
    const parentDir = parts.pop() || ''
    return parentDir ? `${parentDir}/${fileName}` : fileName
  }

  if (!isDirectory) {
    // 单文件选择
    const zipPath = computeZipPath(selection)
    try {
      const data = await readFile(selection)
      files.push({ zipPath, data, size: data.byteLength })
    } catch (e) {
      console.warn(`[collectSelection] 跳过无法读取的文件: ${selection}`, e)
    }
    return { files, dirs }
  }

  // 文件夹选择：递归收集
  // 同时记录"选择本身就是空文件夹"和"选择内部的空子文件夹"。
  const zipRoot = computeZipPath(selection) // 可能是 "BepInEx/plugins/CosplayShop"

  const collectDir = async (dirPath, prefix) => {
    let entries
    try {
      entries = await readDir(dirPath)
    } catch (e) {
      console.warn(`[collectSelection] 无法读取目录: ${dirPath}`, e)
      return
    }
    if (entries.length === 0) {
      // 空目录忠实记录
      if (prefix) dirs.push(prefix)
      return
    }
    for (const entry of entries) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        await collectDir(`${dirPath}/${entry.name}`, fullPath)
      } else if (entry.isFile) {
        try {
          const data = await readFile(`${dirPath}/${entry.name}`)
          files.push({ zipPath: fullPath, data, size: data.byteLength })
        } catch (e) {
          console.warn(`[collectSelection] 跳过无法读取的文件: ${dirPath}/${entry.name}`, e)
        }
      }
    }
  }

  await collectDir(selection, zipRoot)
  return { files, dirs }
}

/**
 * 把一组用户选择（混合 文件夹 + 文件）转成统一结构。
 *
 * @param {object}  opts
 * @param {Array<{path:string, isDirectory:boolean}>} opts.selections
 * @param {string}  opts.gamePath
 * @returns {Promise<{ files: Array, dirs: string[] }>}
 *   - files: [{ zipPath, data, size }]
 *   - dirs : 空目录的 zipPath 列表
 */
export async function collectSelection({ selections, gamePath, category, modKey }) {
  const allFiles = []
  const allDirs = []
  for (const sel of selections) {
    const { files, dirs } = await collectOneSelection({
      selection: sel.path,
      isDirectory: sel.isDirectory,
      gamePath,
      category,
      modKey,
    })
    allFiles.push(...files)
    allDirs.push(...dirs)
  }
  return { files: allFiles, dirs: allDirs }
}
