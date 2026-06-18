import { writeFile, mkdir, exists } from '@tauri-apps/plugin-fs'
import Database from '@tauri-apps/plugin-sql'
import JSZip from 'jszip'

const IMGBED_URL = 'https://img.b9349.dpdns.org'

async function getGamePath() {
  const db = await Database.load('sqlite:config.db')
  const rows = await db.select("SELECT value FROM config WHERE `key` = 'game_path'")
  return rows[0]?.value || null
}

export async function installMod({ modKey, category, fileUrl, version, fileHash }) {
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
    } else {
      targetPath = `${targetDir}/${path}`
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

  // 组合：解压后删除压缩包（保持路径一致，避免残留）
  if (category === 'composite') {
    // 删除 zip 包已无意义(已解压到内存)，保持目标目录干净即可
  }

  // 保存安装记录到本地 SQLite，用于侧边栏展示"创意工坊"标签
  try {
    const db = await Database.load('sqlite:config.db')
    await db.execute(
      `INSERT OR REPLACE INTO installed_workshop_mods
       (id, mod_key, category, installed_version, file_hash)
       VALUES (
         (SELECT id FROM installed_workshop_mods WHERE mod_key = $1),
         $1, $2, $3, $4
       )`,
      [modKey, category, version || '1.0.0', fileHash || '']
    )
  } catch (e) {
    console.warn('[installMod] 保存安装记录失败:', e)
  }

  return { targetDir, fileCount }
}
