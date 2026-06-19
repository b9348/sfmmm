import { writeFile, mkdir, exists, remove } from '@tauri-apps/plugin-fs'
import Database from '@tauri-apps/plugin-sql'
import JSZip from 'jszip'

const IMGBED_URL = 'https://img.b9349.dpdns.org'

async function getGamePath() {
  const db = await Database.load('sqlite:config.db')
  const rows = await db.select("SELECT value FROM config WHERE `key` = 'game_path'")
  return rows[0]?.value || null
}

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
    targetDir = `${pluginsDir}\\${modKey}`
  } else {
    // 'v1' 或默认
    targetDir = `${base}\\CustomMissions\\${modKey}`
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

  const entries = []
  const extractedFiles = []
  zip.forEach((path, entry) => {
    if (!entry.dir) {
      entries.push({ path, entry })
    }
  })

  let fileCount = 0
  for (const { path, entry } of entries) {
    let targetPath

    if (category === 'dll') {
      // DLL 模组：文件直接放在 plugins 根目录
      // 取文件名（去掉 zip 内目录层级）
      const fileName = path.split('/').pop() || path
      targetPath = `${pluginsDir}\\${fileName}`
      extractedFiles.push(fileName)
    } else {
      targetPath = `${targetDir}/${path}`
      extractedFiles.push(path)
      const lastSlash = targetPath.lastIndexOf('/')
      if (lastSlash > 0) {
        const dirPath = targetPath.substring(0, lastSlash)
        const subDirExists = await exists(dirPath)
        if (!subDirExists) {
          await mkdir(dirPath, { recursive: true })
        }
      }
    }

    const data = await entry.async('uint8array')
    await writeFile(targetPath, data)
    fileCount++
  }

  // 如果没有传入 manifest，从 zip 提取的文件列表生成
  const finalManifest = manifest || JSON.stringify(extractedFiles)

  // 组合：解压后删除压缩包（保持路径一致，避免残留）
  if (category === 'composite') {
    // 删除 zip 包已无意义(已解压到内存)，保持目标目录干净即可
  }

  // 保存安装记录到本地 SQLite，用于侧边栏展示"创意工坊"标签
  try {
    const db = await Database.load('sqlite:config.db')
    // 先检查是否存在
    const existing = await db.select('SELECT id FROM installed_workshop_mods WHERE mod_key = $1', [modKey])
    if (existing.length > 0) {
      await db.execute(
        'UPDATE installed_workshop_mods SET category = $1, installed_version = $2, file_hash = $3, lang_code = $4, manifest = $5 WHERE mod_key = $6',
        [category, version || '1.0.0', fileHash || '', langCode || '', finalManifest, modKey]
      )
    } else {
      await db.execute(
        'INSERT INTO installed_workshop_mods (mod_key, category, installed_version, file_hash, lang_code, manifest) VALUES ($1, $2, $3, $4, $5, $6)',
        [modKey, category, version || '1.0.0', fileHash || '', langCode || '', finalManifest]
      )
    }
  } catch (e) {
    console.warn('[installMod] 保存安装记录失败:', e)
  }

  return { targetDir, fileCount }
}

export async function uninstallMod({ modKey }) {
  const gamePath = await getGamePath()
  if (!gamePath) {
    throw new Error('未配置游戏路径')
  }

  const db = await Database.load('sqlite:config.db')
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
  } else {
    // v1/v2/composite: 删除整个 modKey 目录
    let targetDir
    if (category === 'v2') {
      targetDir = `${base}\\CustomMissions2\\${modKey}`
    } else if (category === 'composite') {
      targetDir = `${pluginsDir}\\${modKey}`
    } else {
      targetDir = `${base}\\CustomMissions\\${modKey}`
    }

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
}
