import { open } from '@tauri-apps/plugin-dialog'
import { readFile, readDir } from '@tauri-apps/plugin-fs'
import { collectSelection } from '../modules/workshop/collectSelection'

function getRelativePath(filePath, baseDir) {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedBase || !normalizedFile.startsWith(normalizedBase + '/')) {
    return filePath.split(/[/\\]/).pop()
  }
  return normalizedFile.substring(normalizedBase.length + 1)
}

/**
 * 选择模组文件（按 category 四种分支）
 * @param {'v1'|'v2'|'dll'|'composite'} category
 * @param {string} gamePath
 * @returns {Promise<Array<{name: string, zipPath?: string, data: Uint8Array, size: number}>>}
 */
export async function selectModFiles({ category, gamePath }) {
  if (category === 'v2') {
    const folder = await open({ directory: true, multiple: false })
    if (!folder) return []
    const files = []
    const collectDir = async (dirPath, prefix) => {
      const entries = await readDir(dirPath)
      for (const entry of entries) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory) {
          await collectDir(`${dirPath}/${entry.name}`, fullPath)
        } else if (entry.isFile) {
          const data = await readFile(`${dirPath}/${entry.name}`)
          files.push({ name: fullPath, data, size: data.byteLength })
        }
      }
    }
    await collectDir(folder, '')
    return files
  }

  if (category === 'composite') {
    const selected = await open({ multiple: true, filters: [{ name: 'All Files', extensions: ['*'] }] })
    if (!selected || selected.length === 0) return []
    const selections = selected.map(p => ({ path: p, isDirectory: false }))
    const { files } = await collectSelection({ selections, gamePath })
    if (files.length === 0) return []
    return files.map(f => ({ zipPath: f.zipPath, data: f.data, size: f.size, isDir: false }))
  }

  if (category === 'dll') {
    const selected = await open({ multiple: false, filters: [{ name: 'DLL 文件', extensions: ['dll'] }] })
    if (!selected) return []
    const files = []
    for (const filePath of [selected].flat()) {
      const data = await readFile(filePath)
      const name = filePath.split(/[/\\]/).pop()
      files.push({ name, data, size: data.byteLength })
    }
    return files
  }

  // v1 (default)
  const selected = await open({ multiple: true, filters: [{ name: 'Mod Files', extensions: ['json', 'code', 'txt', 'zip'] }] })
  if (!selected || selected.length === 0) return []
  const files = []
  const baseDir = category === 'v1' && gamePath ? `${gamePath}\\CustomMissions` : null
  for (const filePath of selected) {
    const data = await readFile(filePath)
    const name = filePath.split(/[/\\]/).pop()
    const zipPath = baseDir ? getRelativePath(filePath, baseDir) : name
    files.push({ name, zipPath, data, size: data.byteLength })
  }
  return files
}

/**
 * 选择模组文件夹（composite 专用）
 * @param {string} gamePath
 * @returns {Promise<Array<{zipPath: string, isDir: boolean, size: number, data?: Uint8Array}>>}
 */
export async function selectModFolders({ gamePath }) {
  const folders = await open({ directory: true, multiple: true })
  if (!folders || folders.length === 0) return []
  const selections = folders.map(p => ({ path: p, isDirectory: true }))
  const { files, dirs } = await collectSelection({ selections, gamePath })
  return [
    ...files.map(f => ({ zipPath: f.zipPath, data: f.data, size: f.size, isDir: false })),
    ...dirs.map(d => ({ zipPath: d, isDir: true, size: 0 })),
  ]
}