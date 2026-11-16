import { invoke } from '@tauri-apps/api/core'
import { readDir, stat } from '@tauri-apps/plugin-fs'

let entryCache = {}

// 目录内容缓存由本模块持有，页面在换目录/刷新/前置安装后必须整体失效，
// 否则子项计数会继续展示旧目录的结果。
export function clearEntryCache() {
  entryCache = {}
}

// 列表/计数/哈希均忽略的文件（如 v1 前置附带的作者说明 readme.txt，不展示、不参与记录）
export function isIgnoredListingName(name) {
  if (!name) return false
  return name.toLowerCase() === 'readme.txt'
}

export async function listFiles(dir) {
  try {
    // 将 Windows 反斜杠路径转换为正斜杠，以兼容 Tauri FS API
    const normalizedDir = dir.replace(/\\/g, '/')
    const entries = await readDir(normalizedDir)
    const list = await Promise.all(
      entries.filter(e => !e.name?.startsWith('.') && !isIgnoredListingName(e.name))
        .map(async (e) => {
          const name = e.name
          // 检测 [ban] 禁用标记（任意扩展名：xxx[ban]json / xxx[ban]dll / xxx[ban]code），
          // 与 Rust toggle_mod_enabled 的改名规则保持一致
          const isBanned = /\[ban\][a-z0-9]+$/.test(name.toLowerCase())
          // readDir 对符号链接 / 目录交接点(junction) 的 isDirectory 不可靠（常同时报
          // isDirectory:false 与 isSymlink:false），导致文件夹被误判为文件 → 渲染成
          // FileCard，点它的“打开所在目录”图标会误打开上层父目录。先以 readDir 的 flag
          // 初始化 isDir（含 isSymlink），再用 stat 跟随链接后判定真实类型覆盖之；
          // stat 失败则保留 readDir 的判定。
          let isDir = e.isDirectory === true || e.isSymlink === true || e.children !== undefined
          try {
            const info = await stat(`${normalizedDir}/${name}`)
            isDir = info.isDirectory === true
          } catch {
            // 保留上面的 readDir flag 判定
          }
          return { name, isDir, isBanned }
        })
    )
    return list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  } catch (e) {
    // 目录不存在（如 BepInEx 未安装时 BepInEx/plugins 缺失）是预期情况，静默返回空列表；
    // 仅对真正的读取错误打日志。
    const msg = String(e?.message || e)
    const notFound = /os error 3|ENOENT|No such file|not found/i.test(msg)
    if (!notFound) console.error('[MissionFolder] listFiles error:', e)
    return []
  }
}

export async function getChildCount(dirPath) {
  if (entryCache[dirPath]) return entryCache[dirPath]
  try {
    // 将 Windows 反斜杠路径转换为正斜杠，以兼容 Tauri FS API
    const normalizedDir = dirPath.replace(/\\/g, '/')
    const entries = await readDir(normalizedDir)
    const filtered = entries.filter(e => !e.name?.startsWith('.') && !isIgnoredListingName(e.name))
    const total = filtered.length
    // 目录数同样用 stat 跟随链接后判定，避免 junction 被 readDir 漏判
    const dirFlags = await Promise.all(filtered.map(async (e) => {
      try {
        const info = await stat(`${normalizedDir}/${e.name}`)
        return info.isDirectory === true
      } catch {
        return e.isDirectory === true || e.isSymlink === true || e.children !== undefined
      }
    }))
    const dirs = dirFlags.filter(Boolean).length
    const result = { total, dirs }
    entryCache[dirPath] = result
    return result
  } catch {
    return { total: 0, dirs: 0 }
  }
}

// 取文件扩展名。禁用后文件被重命名为 xxx[ban]dll/json（点号被 [ban] 替代），
// 若只看最后一个点号会取不到扩展名，导致扩展名徽章渲染成空心圆圈；需先识别 [ban] 后缀
export function getExt(name) {
  const banned = name.match(/\[ban\]([a-z0-9]+)$/i)
  if (banned) return banned[1].toLowerCase()
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

// 归一化名称用于解析创意工坊 mod_key：去扩展名、去 [ban] 禁用标记。
// 禁用是重命名为 xxx[ban]<ext>（任意扩展名，点号被 [ban] 替代，与 Rust 端
// toggle_target_name 规则一致），必须连同其后缀一起去掉，否则 foo[ban]json
// 会归一化成 foojson 而失配。即：改名不影响来源识别，来源仍以
// installed_workshop_mods（SQLite）里的 mod_key 为准。
export function getWorkshopKey(name) {
  // 只剥已知扩展名 —— mod_key 本身可含点号（如 "Manaka's Challenge v0.2"），
  // 通用 /\.\w+$/ 会把 v0.2 的 .2 当扩展名误剥，退订时查不到安装记录。
  // [ban] 标记不限扩展名（.code 任务脚本同样可禁用）；文件名与 manifest 首段
  // 两侧必须用同一套归一化，禁用改名后文件才能继续归属同一 mod 分组。
  return name
    .replace(/\.(?:dll|json|code|zip|rar|7z)$/i, '')
    .replace(/\[ban\][a-z0-9]+$/i, '')
    .replace(/\/$/, '')
}

// 由 MissionFolder 的 subfolder 推断 mod 类别，供后端预检使用
export function categoryFromSubfolder(subfolder) {
  if (!subfolder) return 'composite'
  const sf = subfolder.toLowerCase()
  if (sf.includes('custommissions2')) return 'v2'
  if (sf.includes('custommissions')) return 'v1'
  if (sf.includes('bepinex')) return 'dll'
  return 'composite'
}

export async function openInExplorer(dir, items) {
  try {
    // Windows 需要原生反斜杠路径
    const normalized = dir.replace(/\//g, '\\')
    // selected_items 为相对 open 目录的名称列表，供 SHOpenFolderAndSelectItems 一次性高亮多个
    const selected = (items || []).map(x => x.replace(/\//g, '\\'))
    await invoke('open_folder', { path: normalized, selected_items: selected })
  } catch (e) {
    console.error('Failed to open folder:', e)
  }
}
