import { writeFile, mkdir, exists, remove } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import JSZip from 'jszip'
import { getGamePath, getDb } from './dbHelper'
import { computeZipFileHashes } from './workshopApi'

const IMGBED_URL = 'https://img.b9349.dpdns.org'

/**
 * 安全检查：拒绝 zip slip / 绝对路径 / 跨越游戏根目录的 path。
 * 返回归一化后的相对路径（用 / 分隔），失败抛错。
 */
function safeZipPath(path) {
  if (!path) throw new Error('zip 内存在空路径')
  // 防止 \ .. 等投递
  const norm = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (/(^|\/)\.\.(\/|$)/.test(norm)) {
    throw new Error(`zip 内存在非法相对路径: ${path}`)
  }
  return norm
}

/**
 * composite 类型：zip 内每条 path 已是相对游戏根目录的完整路径
 * （例如 "BepInEx/plugins/CosplayShop/xxx.dll"），因此直接解到 gamePath 根目录。
 */
export async function installMod({ modKey, category, fileUrl, version, fileHash, langCode, manifest }) {
  const gamePath = await getGamePath()
  if (!gamePath) {
    throw new Error('未配置游戏路径，请先在设置中配置')
  }

  const base = gamePath.replace(/\/+$/, '')
  const pluginsDir = `${base}\\BepInEx\\plugins`

  let targetDir
  if (category === 'v2') {
    targetDir = `${base}\\CustomMissions2\\${modKey}`
  } else if (category === 'dll') {
    targetDir = pluginsDir
  } else if (category === 'composite') {
    // composite：zip 内 path 是相对游戏根目录的全路径，直接解到 base
    targetDir = base
  } else {
    // 'v1' 直接解压到 CustomMissions，zip 内保留相对 CustomMissions 的路径
    targetDir = `${base}\\CustomMissions`
  }

  const url = fileUrl.startsWith('http') ? fileUrl : `${IMGBED_URL}${fileUrl}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)

  let arrayBuffer
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`下载失败：HTTP ${res.status}`)
    }
    arrayBuffer = await res.arrayBuffer()
  } finally {
    clearTimeout(timeout)
  }

  const zip = await JSZip.loadAsync(arrayBuffer)

  // 确保目标目录存在
  const dirExists = await exists(targetDir)
  if (!dirExists) {
    await mkdir(targetDir, { recursive: true })
  }

  const extractedFiles = []

  /**
   * 递归解压：zip 内若嵌套了 .zip（常见于作者上传时多包了一层），
   * 继续展开其內容到同一目标目录（dll 类平铺到 plugins 根），
   * 不保留该 zip 自身文件名这一层，从而把真正的 mod 文件部署到位。
   */
  const extractAll = async (z) => {
    const dirEntries = []
    const fileEntries = []
    z.forEach((path, entry) => {
      if (entry.dir) {
        dirEntries.push({ path, entry })
      } else {
        fileEntries.push({ path, entry })
      }
    })

    // 先创建目录条目（含空文件夹）
    for (const { path } of dirEntries) {
      if (category === 'dll') continue // DLL 不保留目录结构
      const safeRel = safeZipPath(path.replace(/\/+$/, ''))
      const dirPath = `${targetDir}\\${safeRel.replace(/\//g, '\\')}`
      try {
        if (!await exists(dirPath)) {
          await mkdir(dirPath, { recursive: true })
        }
      } catch (e) {
        console.warn(`[installMod] 创建目录失败: ${dirPath}`, e)
      }
    }

    for (const { path, entry } of fileEntries) {
      const data = await entry.async('uint8array')

      // 嵌套 zip：递归展开，不写出该 zip 文件本身
      if (path.toLowerCase().endsWith('.zip')) {
        try {
          const innerZip = await JSZip.loadAsync(data)
          await extractAll(innerZip)
          continue
        } catch (e) {
          console.warn(`[installMod] 嵌套 zip 解析失败，按普通文件写出: ${path}`, e)
        }
      }

      let targetPath
      if (category === 'dll') {
        // DLL 模组：取文件名平铺到 plugins 根目录
        const fileName = path.split('/').pop() || path
        targetPath = `${pluginsDir}\\${fileName}`
        extractedFiles.push(fileName)
      } else {
        // 安全检查（拒绝 zip slip）
        const safeRel = safeZipPath(path)
        const normalizedPath = safeRel.replace(/\//g, '\\')
        targetPath = `${targetDir}\\${normalizedPath}`
        extractedFiles.push(safeRel)
        const lastSlash = targetPath.lastIndexOf('\\')
        if (lastSlash > 0) {
          const dirPath = targetPath.substring(0, lastSlash)
          const subDirExists = await exists(dirPath)
          if (!subDirExists) {
            await mkdir(dirPath, { recursive: true })
          }
        }
      }

      await writeFile(targetPath, data)
    }
  }

  await extractAll(zip)

  // composite 类别：从解出的文件推断顶层目录，使返回的 targetDir 更具体
  // （如 "BepInEx/plugins/CosplayShop" 而非游戏根目录），供前端"打开目录"精确定位。
  // 注意：extractedFiles 始终保留相对游戏根的全路径（manifest/卸载依赖此语义），
  // 返回给前端的 files 需转换为相对收窄后 targetDir 的路径，保证 open_folder 的
  // path.join(item) 能解析到真实文件。第一项是根级文件（单段路径）时保持 base。
  let openFiles = extractedFiles
  if (category === 'composite' && extractedFiles.length > 0) {
    const firstPath = extractedFiles[0] || ''
    const segments = firstPath.split('/')
    if (segments.length > 1) {
      const topDirSegs = segments.slice(0, -1)
      targetDir = `${base}\\${topDirSegs.join('\\')}`
      openFiles = extractedFiles.map(f => {
        const segs = f.split('/')
        return segs.length > topDirSegs.length
          ? segs.slice(topDirSegs.length).join('\\')
          : f.replace(/\//g, '\\')
      })
    }
  }

  // 后端回填：把本 mod 的逐文件指纹（与上传者 computeZipFileHashes、预检 compute_local_hashes 同一 basename 口径，
  // 含嵌套 zip 递归展开）写回云端 mod_files.file_hashes。始终以官方 zip 算出的规范指纹覆盖（幂等），
  // 使旧的非递归（缺内包文件）指纹也能在安装时被升级为精确指纹。失败仅告警，绝不阻断安装流程。
  let fileHashes = null
  try {
    fileHashes = await computeZipFileHashes(arrayBuffer)
    if (fileHashes) {
      await invoke('db_set_mod_file_hashes', {
        mod_key: modKey,
        lang_code: langCode || '',
        file_hashes: fileHashes,
      })
    }
  } catch (e) {
    console.warn('[installMod] 回填云端逐文件指纹失败（可忽略）:', e)
  }

  const fileCount = extractedFiles.length

  // 安装清单以“实际解出的文件”为准（含嵌套 zip 展开后的文件），
  // 这样卸载时能精确删掉真正部署的文件。
  const finalManifest = extractedFiles.length > 0
    ? JSON.stringify(extractedFiles)
    : (manifest || '[]')

  // 保存安装记录到本地 SQLite，用于侧边栏展示"创意工坊"标签
  try {
    const db = await getDb()
    // 兼容旧表：保留 mod 级记录
    const existing = await db.select('SELECT id FROM installed_workshop_mods WHERE mod_key = $1', [modKey])
    if (existing.length > 0) {
      await db.execute(
        'UPDATE installed_workshop_mods SET category = $1, installed_version = $2, file_hash = $3, lang_code = $4, manifest = $5, file_hashes = $6 WHERE mod_key = $7',
        [category, version || '1.0.0', fileHash || '', langCode || '', finalManifest, fileHashes || '', modKey]
      )
    } else {
      await db.execute(
        'INSERT INTO installed_workshop_mods (mod_key, category, installed_version, file_hash, lang_code, manifest, file_hashes) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [modKey, category, version || '1.0.0', fileHash || '', langCode || '', finalManifest, fileHashes || '']
      )
    }
    // 按语言保存安装记录，用于判断是否需要更新
    await db.execute(
      `INSERT INTO installed_workshop_mod_files (mod_key, lang_code, installed_version, file_hash, manifest)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(mod_key, lang_code) DO UPDATE SET
         installed_version = excluded.installed_version,
         file_hash = excluded.file_hash,
         manifest = excluded.manifest,
         installed_at = CURRENT_TIMESTAMP`,
      [modKey, langCode || '', version || '1.0.0', fileHash || '', finalManifest]
    )
  } catch (e) {
    console.warn('[installMod] 保存安装记录失败:', e)
  }

  return { targetDir, fileCount, files: openFiles }
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
}
