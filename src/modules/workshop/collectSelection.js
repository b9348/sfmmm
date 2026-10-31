import { readFile, readDir } from '@tauri-apps/plugin-fs'

/**
 * 把一条用户选择（文件夹 or 文件）转换成 zip 内条目。
 *
 * 路径策略（统一 v1 / composite / dll 语义）：
 *   - 若选择位于 gamePath 之下：zipPath = 相对 gamePath 的路径（用 / 分隔）。
 *   - 若选择不在 gamePath 之下（外部目录）：fallback 为 "最后一段目录名/文件名"，
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
 * @returns {Promise<{ files: Array<{zipPath:string,data:Uint8Array,size:number}>, dirs: string[] }>}
 */
export async function collectOneSelection({ selection, isDirectory, gamePath }) {
  const files = []
  const dirs = []

  // 计算相对游戏根目录的 zipPath；找不到则取 selection 末两段（parentDir/fileName）。
  const computeZipPath = (absPath) => {
    const normGame = (gamePath || '').replace(/\\/g, '/').replace(/\/+$/, '')
    const normAbs = absPath.replace(/\\/g, '/')
    if (normGame && normAbs.toLowerCase().startsWith(normGame.toLowerCase() + '/')) {
      return normAbs.substring(normGame.length + 1)
    }
    // 不在游戏目录下：保留 parentDir/fileName 形态
    const parts = normAbs.split('/')
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
export async function collectSelection({ selections, gamePath }) {
  const allFiles = []
  const allDirs = []
  for (const sel of selections) {
    const { files, dirs } = await collectOneSelection({
      selection: sel.path,
      isDirectory: sel.isDirectory,
      gamePath,
    })
    allFiles.push(...files)
    allDirs.push(...dirs)
  }
  return { files: allFiles, dirs: allDirs }
}
