export function compareSemver(a, b) {
  const normalize = v => (v || '').replace(/^v/i, '')
  const pa = normalize(a).split('.').map(Number)
  const pb = normalize(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na !== nb) return na - nb
  }
  return 0
}

/**
 * 保存 meta 时实际写库的翻译版本：以「这次真正发布出去的版本」为准。
 *
 * 发布补丁包有三种结果：
 * - 内容有变化：res.version 就是作者填写、并用于上传对象路径的新版本；
 * - 幂等（内容没变）/ 清单自愈：后端保持基线版本，不会按作者填的版本发布；
 * - 历史包条目未归一而触发的重新打包：同样落回基线版本。
 *
 * 后两种如果不覆盖，就会出现「界面提示版本保持 v1.1.0，写完库却变成表单里的
 * v2.0.0（甚至更低版本）」的静默降级。只覆盖本次成功发布过的语言，其余语言
 * 仍按作者输入写库。
 */
export function applyPublishedVersions(translations, publishedVersions) {
  const out = { ...translations }
  for (const [lang, version] of Object.entries(publishedVersions || {})) {
    if (version == null) continue
    const cur = out[lang]
    if (!cur) continue
    out[lang] = { ...cur, version }
  }
  return out
}

// manifest 是文件路径列表（JSON 字符串），用于安装记录与文件列表预览
export function parseManifest(raw) {
  try {
    const list = JSON.parse(raw || '[]')
    return Array.isArray(list) ? list.filter(p => typeof p === 'string' && p) : []
  } catch {
    return []
  }
}

// 与 Rust 端 category_install_components 同一口径：条目在安装时相对哪个目录记录。
// composite 的条目本来就相对游戏根，返回空数组表示「无需剥前缀」。
function installRootComponents(category, modKey) {
  const key = String(modKey || '').trim()
  switch (category) {
    case 'dll':
      return ['BepInEx', 'plugins']
    case 'v1':
      return ['CustomMissions']
    case 'v2':
      if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) return []
      return ['CustomMissions2', key]
    default:
      return []
  }
}

function eqComponent(a, b) {
  return a.toLowerCase() === b.toLowerCase()
}

function startsWithComponents(path, prefix) {
  return path.length >= prefix.length
    && prefix.every((seg, i) => eqComponent(seg, path[i]))
}

/**
 * 把 manifest 条目归一为「相对安装 target_dir」的键，和 Rust 端
 * normalize_entry_path 保持同一套规则（按路径段比较，不做字符串截断）：
 * 1. 反斜杠统一成 `/`，折叠空段与 `.`；
 * 2. 重复剥掉安装根前缀（`BepInEx/plugins/BepInEx/plugins/x` 这类叠加）；
 * 3. 安装根的上级/本身（`BepInEx/`、`BepInEx/plugins/`）归一为空并丢弃；
 * 4. 已经相对安装根的条目原样返回。
 */
export function normalizeManifestEntryPath(raw, category, modKey) {
  const norm = String(raw || '').replace(/\\/g, '/')
  const isDir = norm.endsWith('/')
  const comps = norm.split('/').filter(seg => seg && seg !== '.')
  if (!comps.length) return ''
  const prefix = installRootComponents(category, modKey)
  if (!prefix.length) {
    const joined = comps.join('/')
    return isDir ? `${joined}/` : joined
  }
  while (startsWithComponents(comps, prefix)) {
    comps.splice(0, prefix.length)
    if (!comps.length) break
  }
  if (!comps.length) return ''
  if (isDir && comps.length < prefix.length && startsWithComponents(prefix, comps)) return ''
  const joined = comps.join('/')
  return isDir ? `${joined}/` : joined
}

/**
 * 「查看文件列表」用：归一后只保留文件条目。
 * 目录条目（末尾 `/`）只是压缩包结构，不参与文件匹配，也不在文件列表里重复展示。
 */
export function normalizeManifestFiles(raw, category, modKey) {
  return parseManifest(raw)
    .map(p => normalizeManifestEntryPath(p, category, modKey))
    .filter(p => p && !p.endsWith('/'))
}

// 打开目录时的高亮项：manifest 路径可能带子目录前缀（作者上传的是文件夹，如
// "上级--长--.../01.json"），而 Windows 资源管理器只显示 installedDir 的【直接子项】，
// 深层文件在当前视图中不可见、无法高亮。故取每项第一段并去重——文件夹型 mod 高亮
// 文件夹本身，平铺的单/多文件高亮文件名，保证高亮目标在视图中可见、可被选中。
export function openDirHighlightItems(files) {
  const seen = new Set()
  const items = []
  for (const f of files || []) {
    const first = String(f).split(/[/\\]/)[0]
    if (first && !seen.has(first)) {
      seen.add(first)
      items.push(first)
    }
  }
  return items
}
