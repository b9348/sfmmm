import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { makeStyles, tokens, Text, Button, Card, CardHeader, Badge, Tooltip, Spinner, ProgressBar } from '@fluentui/react-components'
import { FolderOpen24Regular, ArrowClockwise24Regular, Document24Regular, Folder24Regular, ChevronRight24Regular, Play24Regular, Pause24Regular, Delete24Regular, Cloud24Regular, ArrowDownload24Regular, Warning24Regular } from '@fluentui/react-icons'
import { invoke, Channel } from '@tauri-apps/api/core'
import { readDir, stat } from '@tauri-apps/plugin-fs'
import { useInstalledMods } from '../../hooks/useInstalledMods'
import { useUserNav } from '../../contexts/useUserNav'
import { getModDetail } from '../../services/workshopApi'
import { installMod } from '../../services/installMod'
import { AsyncView, EmptyState } from '../../components'
import { LANG_LABELS } from '../../i18n/languages'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  toolbarCard: {
    padding: '8px',
    flexShrink: 0,
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  breadcrumbRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    flexWrap: 'wrap',
  },
  breadcrumbBtn: {
    minWidth: 'unset',
    padding: '2px 6px',
    height: '24px',
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
  },
  breadcrumbBtnActive: {
    color: tokens.colorNeutralForeground1,
    fontWeight: '600',
  },
  breadcrumbChevron: {
    fontSize: '10px',
    color: tokens.colorNeutralForeground3,
    display: 'inline-flex',
    alignItems: 'center',
  },
  grid: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    alignContent: 'flex-start',
  },
  card: {
    padding: '12px',
    cursor: 'pointer',
    transition: 'box-shadow 0.2s ease',
    minWidth: '180px',
    flex: '1 1 0px',
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  // 同一创意工坊订阅的分组容器：横贯整行，带淡绿描边（创意工坊徽章同色更淡，避免与单选高亮的品牌蓝撞色）
  groupCard: {
    padding: '12px 14px',
    flexBasis: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    border: `2px solid ${tokens.colorStatusSuccessBackground2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: `0 0 0 3px ${tokens.colorStatusSuccessBackground3}, ${tokens.shadow4}`,
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    minWidth: 0,
  },
  groupActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  },
  groupActionsPush: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    marginLeft: 'auto',
  },
  groupInnerGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
  },
  // 组内成员的紧凑卡片
  innerCard: {
    padding: '8px 10px',
    cursor: 'pointer',
    transition: 'box-shadow 0.2s ease',
    minWidth: '160px',
    flex: '1 1 0px',
    backgroundColor: tokens.colorNeutralBackground1,
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    marginTop: '4px',
  },
  fileName: {
    overflow: 'hidden',
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
    padding: '32px',
    textAlign: 'center',
    flex: 1,
  },
  pathText: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  folderCount: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
    marginTop: '2px',
  },
  buttonRow: {
    display: 'flex',
    gap: '4px',
    justifyContent: 'flex-end',
    marginTop: '4px',
  },
  // BepInEx 前置未安装时的提示 banner（仅 DLL 模组页 subfolder 含 bepinex 时出现）
  prereqBanner: {
    padding: '12px 14px',
    flexShrink: 0,
    border: `1px solid ${tokens.colorStatusDangerStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  prereqRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  prereqText: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  prereqProgress: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    width: '100%',
    maxWidth: '320px',
  },
})

let entryCache = {}

async function listFiles(dir) {
  try {
    // 将 Windows 反斜杠路径转换为正斜杠，以兼容 Tauri FS API
    const normalizedDir = dir.replace(/\\/g, '/')
    const entries = await readDir(normalizedDir)
    const list = await Promise.all(
      entries.filter(e => !e.name?.startsWith('.'))
        .map(async (e) => {
          const name = e.name
          // 检测 [ban] 禁用标记：xxx[ban]json 或 xxx[ban]dll
          const lower = name.toLowerCase()
          const isBanned = lower.endsWith('[ban]json') || lower.endsWith('[ban]dll')
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
    console.error('[MissionFolder] listFiles error:', e)
    return []
  }
}

async function getChildCount(dirPath) {
  if (entryCache[dirPath]) return entryCache[dirPath]
  try {
    // 将 Windows 反斜杠路径转换为正斜杠，以兼容 Tauri FS API
    const normalizedDir = dirPath.replace(/\\/g, '/')
    const entries = await readDir(normalizedDir)
    const filtered = entries.filter(e => !e.name?.startsWith('.'))
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
function getExt(name) {
  const banned = name.match(/\[ban\]([a-z0-9]+)$/i)
  if (banned) return banned[1].toLowerCase()
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

// 归一化名称用于解析创意工坊 mod_key：去扩展名、去 [ban] 禁用标记。
// 禁用是重命名为 xxx[ban]dll/json（[ban] 后直接跟无点号的扩展名），必须连同其后缀
// 一起去掉，否则 foo[ban]json 会归一化成 foojson 而失配。即：改名不影响来源识别，
// 来源仍以 installed_workshop_mods（SQLite）里的 mod_key 为准。
function getWorkshopKey(name) {
  return name.replace(/\.\w+$/, '').replace(/\[ban\][^./]*$/i, '').replace(/\/$/, '')
}

// 由 MissionFolder 的 subfolder 推断 mod 类别，供后端预检使用
function categoryFromSubfolder(subfolder) {
  if (!subfolder) return 'composite'
  const sf = subfolder.toLowerCase()
  if (sf.includes('custommissions2')) return 'v2'
  if (sf.includes('custommissions')) return 'v1'
  if (sf.includes('bepinex')) return 'dll'
  return 'composite'
}

async function openInExplorer(dir, items) {
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

// 创意工坊 mod 的操作按钮组：查看详情 / 更新（仅当有更新）/ 退订，三者并排
// 单卡片与分组组头共用，替代原来的三点菜单
function ModCardActions({ modKey, hasUpdate, onViewDetail, onUpdate, onUninstall, pushRight = true }) {
  const { t } = useTranslation()
  const styles = useStyles()
  if (!modKey) return null
  return (
    <div className={pushRight ? styles.groupActionsPush : styles.groupActions}>
      <Tooltip content={t('mods.menuViewDetail')} relationship="label">
        <Button size="small" icon={<Cloud24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onViewDetail(modKey) }} />
      </Tooltip>
      {hasUpdate && (
        <Tooltip content={t('mods.menuUpdate')} relationship="label">
          <Button size="small" icon={<ArrowDownload24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onUpdate(modKey) }} />
        </Tooltip>
      )}
      {onUninstall && (
        <Tooltip content={t('mods.uninstall')} relationship="label">
          <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onUninstall({ name: modKey }) }} />
        </Tooltip>
      )}
    </div>
  )
}

function FolderCard({ name, fullPath, onNavigate, isWorkshop, workshopDetail, cloudInfo, onUninstall, hasUpdate, modKey, onViewDetail, onUpdate, inGroup = false, selected = false, onSelect, onOpenLocation }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const [childInfo, setChildInfo] = useState(null)

  useEffect(() => {
    let cancelled = false
    getChildCount(fullPath).then(info => {
      if (!cancelled) setChildInfo(info)
    })
    return () => { cancelled = true }
  }, [fullPath])

  // 分组模式下工坊信息统一显示在组头，成员卡片保持精简
  const showWorkshopInfo = isWorkshop && !inGroup

  return (
    <Card
      className={inGroup ? styles.innerCard : styles.card}
      appearance="outline"
      onClick={(e) => { onSelect?.(fullPath, e) }}
      onDoubleClick={(e) => { if (!e.ctrlKey && !e.shiftKey) onNavigate(fullPath) }}
      style={{
        border: `2px solid ${selected ? tokens.colorBrandStroke1 : 'transparent'}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}, ${tokens.shadow4}` : undefined,
      }}
    >
      <CardHeader
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <Folder24Regular />
            <Text size="small" weight="semibold" className={styles.fileName}>{name}</Text>
          </div>
        }
        description={
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
            {childInfo && (
              <Text size="small" className={styles.meta}>
                {childInfo.dirs > 0
                  ? t('mission.folderCount', { dirs: childInfo.dirs, files: childInfo.total - childInfo.dirs })
                  : t('mission.itemCount', { count: childInfo.total })}
              </Text>
            )}
          </div>
        }
      />
      <div className={styles.buttonRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginRight: 'auto' }}>
          {showWorkshopInfo && <Badge appearance="filled" color="success" size="small">{t('mods.workshopBadge')}</Badge>}
          {showWorkshopInfo && workshopDetail?.version && <Badge appearance="outline" size="small">v{workshopDetail.version}</Badge>}
          {showWorkshopInfo && workshopDetail?.langCode && <Badge appearance="outline" size="small">{LANG_LABELS[workshopDetail.langCode] || workshopDetail.langCode}</Badge>}
          {showWorkshopInfo && workshopDetail?.fileHash && cloudInfo?.latestFileHash && workshopDetail.fileHash !== cloudInfo.latestFileHash && (
            <Badge appearance="filled" color="danger" size="small">{t('mods.sourceMismatch')}</Badge>
          )}
        </div>
        <Tooltip content={t('mods.openContainingFolder')} relationship="label">
          <Button size="small" icon={<FolderOpen24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onOpenLocation?.(fullPath) }} />
        </Tooltip>
        {showWorkshopInfo && (
          <ModCardActions modKey={modKey} hasUpdate={hasUpdate} onViewDetail={onViewDetail} onUpdate={onUpdate} onUninstall={onUninstall} pushRight={false} />
        )}
      </div>
    </Card>
  )
}

function FileCard({ name, fullPath, isBanned, onToggle, isWorkshop, hasUpdate, workshopDetail, cloudInfo, onUninstall, modKey, onViewDetail, onUpdate, inGroup = false, selected = false, onSelect, onOpenLocation }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const ext = getExt(name)
  // 分组模式下工坊信息统一显示在组头，成员卡片保持精简
  const showWorkshopInfo = isWorkshop && !inGroup
  return (
    <Card
      className={inGroup ? styles.innerCard : styles.card}
      appearance="outline"
      onClick={(e) => { onSelect?.(fullPath, e) }}
      style={{
        border: `2px solid ${selected ? tokens.colorBrandStroke1 : 'transparent'}`,
        boxShadow: selected ? `0 0 0 2px ${tokens.colorBrandBackground2}, ${tokens.shadow4}` : undefined,
      }}
    >
      <CardHeader
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <Document24Regular />
            <Text size="small" weight="semibold" className={styles.fileName}>{name}</Text>
          </div>
        }
      />
      <div className={styles.buttonRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginRight: 'auto' }}>
          <Badge appearance="outline" size="small">{ext.toUpperCase()}</Badge>
          {isBanned && <Badge appearance="filled" color="danger" size="small">{t('mods.disabled')}</Badge>}
          {showWorkshopInfo && <Badge appearance="filled" color="success" size="small">{t('mods.workshopBadge')}</Badge>}
          {showWorkshopInfo && workshopDetail?.version && <Badge appearance="outline" size="small">v{workshopDetail.version}</Badge>}
          {showWorkshopInfo && workshopDetail?.langCode && <Badge appearance="outline" size="small">{LANG_LABELS[workshopDetail.langCode] || workshopDetail.langCode}</Badge>}
          {showWorkshopInfo && workshopDetail?.fileHash && cloudInfo?.latestFileHash && workshopDetail.fileHash !== cloudInfo.latestFileHash && (
            <Badge appearance="filled" color="danger" size="small">{t('mods.sourceMismatch')}</Badge>
          )}
          {!inGroup && hasUpdate && <Badge appearance="filled" color="warning" size="small">{t('mods.hasUpdate')}</Badge>}
        </div>
        <Tooltip content={t('mods.openContainingFolder')} relationship="label">
          <Button size="small" icon={<FolderOpen24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onOpenLocation?.(fullPath) }} />
        </Tooltip>
        <Tooltip content={isBanned ? t('mods.enable') : t('mods.disable')} relationship="label">
          <Button
            size="small"
            icon={isBanned ? <Play24Regular /> : <Pause24Regular />}
            appearance="subtle"
            onClick={(e) => { e.stopPropagation(); onToggle(fullPath) }}
          />
        </Tooltip>
        {showWorkshopInfo && (
          <ModCardActions modKey={modKey} hasUpdate={hasUpdate} onViewDetail={onViewDetail} onUpdate={onUpdate} onUninstall={onUninstall} pushRight={false} />
        )}
      </div>
    </Card>
  )
}

// 同一创意工坊订阅源（同 mod_key）下多个文件/文件夹的分组卡片：
// 订阅级信息与操作集中在组头，组内成员保留各自的独立交互（打开、启用/停用等）
function ModGroupCard({ modKey, items, children, workshopDetail, cloudInfo, hasUpdate, onViewDetail, onUpdate, onUninstall, onDisableAll, onEnableAll }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const title = cloudInfo?.displayName || modKey
  return (
    <Card className={styles.groupCard} appearance="filled-alternative">
      <div className={styles.groupHeader}>
        <Cloud24Regular />
        <Tooltip content={modKey} relationship="label">
          <Text size="small" weight="semibold" className={styles.fileName}>{title}</Text>
        </Tooltip>
      </div>
      <div className={styles.groupInnerGrid}>
        {children}
      </div>
      <div className={styles.buttonRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginRight: 'auto' }}>
          <Badge appearance="filled" color="success" size="small">{t('mods.workshopBadge')}</Badge>
          <Badge appearance="outline" size="small">{t('mods.groupCount', { count: items.length })}</Badge>
          {workshopDetail?.version && <Badge appearance="outline" size="small">v{workshopDetail.version}</Badge>}
          {workshopDetail?.langCode && <Badge appearance="outline" size="small">{LANG_LABELS[workshopDetail.langCode] || workshopDetail.langCode}</Badge>}
          {workshopDetail?.fileHash && cloudInfo?.latestFileHash && workshopDetail.fileHash !== cloudInfo.latestFileHash && (
            <Badge appearance="filled" color="danger" size="small">{t('mods.sourceMismatch')}</Badge>
          )}
          {hasUpdate && <Badge appearance="filled" color="warning" size="small">{t('mods.hasUpdate')}</Badge>}
        </div>
        <Tooltip content={t('mods.disableAll')} relationship="label">
          <Button size="small" icon={<Pause24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onDisableAll?.(modKey) }} />
        </Tooltip>
        <Tooltip content={t('mods.enableAll')} relationship="label">
          <Button size="small" icon={<Play24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onEnableAll?.(modKey) }} />
        </Tooltip>
        <ModCardActions modKey={modKey} hasUpdate={hasUpdate} onViewDetail={onViewDetail} onUpdate={onUpdate} onUninstall={onUninstall} pushRight={false} />
      </div>
    </Card>
  )
}

// DLL 模组页（subfolder 含 bepinex）缺少 BepInEx 前置时显示的提示卡片，
// 复用 ModList 的检测结论与一键安装流程
function PrereqBanner({ checking, installing, progress, stage, error, onInstall, onRescan }) {
  const { t } = useTranslation()
  const styles = useStyles()
  if (checking) {
    return (
      <Card className={styles.prereqBanner}>
        <div className={styles.prereqRow}>
          <Spinner size="tiny" />
          <Text size="small">{t('mods.prereqChecking')}</Text>
        </div>
      </Card>
    )
  }
  return (
    <Card className={styles.prereqBanner}>
      <div className={styles.prereqRow}>
        <Warning24Regular />
        <Text size="small" weight="semibold">{t('mods.prereqNotInstalled')}</Text>
        <Button size="small" icon={<ArrowClockwise24Regular />} appearance="subtle" onClick={onRescan} disabled={installing}>{t('mods.reDetect')}</Button>
      </div>
      <Text size="small" className={styles.prereqText}>{t('mods.bepInExHint')}</Text>
      {error && <Text size="small" className={styles.prereqText} style={{ color: tokens.colorStatusDangerForeground1 }}>{error}</Text>}
      <div className={styles.prereqRow}>
        <Button
          size="small"
          icon={installing ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
          onClick={onInstall}
          disabled={installing}
        >
          {installing ? t('mods.installingBepInEx') : t('mods.downloadInstallBepInEx')}
        </Button>
      </div>
      {installing && (
        <div className={styles.prereqProgress}>
          <ProgressBar value={progress} />
          <Text size="small" className={styles.prereqText}>
            {stage === 'downloading' && `${t('mods.downloadingBepInEx')} ${progress}%`}
            {stage === 'extracting' && t('mods.extractingBepInEx')}
          </Text>
        </div>
      )}
    </Card>
  )
}

export function MissionFolder({ config, subfolder, onUninstall }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const gamePath = config?.game_path?.replace(/\\/g, '/') || ''
  const rootDir = gamePath ? `${gamePath}/${subfolder}` : ''
  const [currentDir, setCurrentDir] = useState(rootDir)
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const { installed, updates, modDetails, cloudInfo } = useInstalledMods()
  // 当前选中的条目集合（支持 Ctrl/Shift 多选，高亮提示用户）；仅在本页/本目录内生效
  const [selectedPaths, setSelectedPaths] = useState(() => new Set())
  const anchorRef = useRef(null) // Shift 范围选择的锚点
  const orderedPaths = files.map(f => `${currentDir}/${f.name}`)

  // Windows 风格选择：plain=单选；Ctrl=切换；Shift=以锚点起算的范围；Ctrl+Shift=范围并入
  const handleItemSelect = (fullPath, e) => {
    const evt = e || {}
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (evt.shiftKey && anchorRef.current) {
        const startIdx = orderedPaths.indexOf(anchorRef.current)
        const endIdx = orderedPaths.indexOf(fullPath)
        if (startIdx !== -1 && endIdx !== -1) {
          const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
          if (!evt.ctrlKey) next.clear()
          for (let k = lo; k <= hi; k++) next.add(orderedPaths[k])
          return next
        }
      }
      if (evt.ctrlKey) {
        if (next.has(fullPath)) next.delete(fullPath)
        else next.add(fullPath)
      } else {
        next.clear()
        next.add(fullPath)
      }
      return next
    })
    if (!evt.shiftKey) anchorRef.current = fullPath
  }

  // 点击「打开所在目录」图标：
  //   - 多选（点击项属于一个 >1 的选择集）→ 打开父目录 currentDir 并高亮【所有选中项】
  //     （文件夹与文件一并高亮），使资源管理器的高亮与 UI 多选严格一致；不钻入文件夹，
  //     否则兄弟选中项在父目录里不可见、无法高亮。
  //   - 单选 → 把被点的完整路径 fullPath 交给 Rust 的 open_folder，由 Rust 按真实类型
  //     （std::fs::is_dir，跟随符号链接/目录交接点 junction，可靠）裁决：目录则直接打开
  //     （钻入），文件则打开其父目录并高亮该文件。**前端不再自行判定目录/文件**，从根上
  //     避免 junction 被 readDir/stat 误判为文件而错误打开上层父目录。
  const handleOpenLocation = useCallback((fullPath) => {
    const isMultiSelect = selectedPaths.size > 1 && selectedPaths.has(fullPath)
    if (isMultiSelect) {
      let selectedNames = files
        .filter(f => selectedPaths.has(`${currentDir}/${f.name}`))
        .map(f => f.name)
      if (selectedNames.length === 0) {
        // 兜底：过滤未命中（如 files 快照过期）时至少高亮被点击项本身，
        // 避免空 items 掉回单文件回退分支（junction 目录会再被 is_dir 误判而打开游戏根）。
        selectedNames = [fullPath.split(/[/\\]/).pop()]
      }
      // 多选：打开父目录并高亮全部选中项（文件夹+文件），与 UI 选择保持一致
      openInExplorer(currentDir, selectedNames)
    } else {
      // 单点：交给你 Rust 裁决（目录钻入 / 文件开父目录+高亮）
      openInExplorer(fullPath, [])
    }
    setSelectedPaths(prev => {
      const next = new Set(prev)
      next.add(fullPath)
      return next
    })
  }, [files, currentDir, selectedPaths])

  // 切换目录时清空选择，确保多选仅在本页/本目录内生效
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedPaths(new Set())
    anchorRef.current = null
  }, [currentDir])

  // 检查文件/文件夹是否是已安装的工坊模组
  // 解析出对应的创意工坊 mod_key：
  // 1) 名称直接等于 mod_key（dll / 多数 v1 顶层文件夹）
  // 2) v1 部署后顶层文件夹名可能等于某已安装 mod 的 manifest 首段
  const resolveModKey = useCallback((name) => {
    const key = getWorkshopKey(name)
    if (installed.has(key)) return key
    for (const [mk, d] of modDetails) {
      if (!d.manifest) continue
      try {
        const paths = JSON.parse(d.manifest)
        // manifest 首段可能带扩展名（如旧安装记录的 "xxx.zip"），一并归一化后再比
        if (paths.some(p => {
          const seg = String(p).split('/')[0].replace(/\.\w+$/, '').replace(/\/$/, '')
          return seg === key
        })) return mk
      } catch { /* 忽略损坏的 manifest */ }
    }
    return null
  }, [installed, modDetails])
  const isWorkshopMod = (name) => resolveModKey(name) !== null
  const hasUpdate = (name) => { const k = resolveModKey(name); return k ? updates.has(k) : false }
  const getWorkshopDetail = (name) => { const k = resolveModKey(name); return k ? modDetails.get(k) : null }
  const getCloudInfo = (name) => { const k = resolveModKey(name); return k ? cloudInfo.get(k) : null }

  const { openMod } = useUserNav()

  // 前往创意工坊查看该 mod 详情页（按 mod_key 跳转）
  const handleViewDetail = useCallback((modKey) => {
    if (!modKey) return
    openMod(modKey)
  }, [openMod])

  const loadFiles = useCallback(async () => {
    if (!currentDir) return
    try {
      const list = await listFiles(currentDir)
      setFiles(list)
    } finally {
      setLoading(false)
    }
  }, [currentDir])

  useEffect(() => {
    if (currentDir) {
      loadFiles()
    }
  }, [currentDir, loadFiles])

  // DLL 模组页（subfolder 含 bepinex）前置：检测 BepInEx 是否安装；未安装则显示一键安装 banner
  const isBepInEx = (subfolder || '').toLowerCase().includes('bepinex')
  const [prereqMissing, setPrereqMissing] = useState(null) // null=检测中, true=缺, false=已装
  const [prereqError, setPrereqError] = useState('')
  const [installingPrereq, setInstallingPrereq] = useState(false)
  const [prereqProgress, setPrereqProgress] = useState(0)
  const [prereqStage, setPrereqStage] = useState('')

  const checkPrereq = useCallback(async () => {
    if (!isBepInEx || !gamePath) return
    try {
      const res = await invoke('scan_mods', { gamePath })
      setPrereqMissing(res.bepinExInstalled !== true)
    } catch (e) {
      setPrereqError(String(e))
    }
  }, [isBepInEx, gamePath])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isBepInEx && gamePath) checkPrereq()
  }, [isBepInEx, gamePath, checkPrereq])

  const installPrereq = useCallback(async () => {
    if (!gamePath) return
    setInstallingPrereq(true)
    setPrereqProgress(0)
    setPrereqStage('downloading')
    setPrereqError('')
    try {
      const channel = new Channel((msg) => {
        setPrereqProgress(msg.percent)
        setPrereqStage(msg.stage)
      })
      await invoke('download_and_extract_7z', {
        url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx6/BepInEx6.7z',
        targetDir: gamePath,
        onProgress: channel,
      })
      setPrereqMissing(false)
      entryCache = {}
      await loadFiles()
    } catch (e) {
      setPrereqError(String(e))
    } finally {
      setInstallingPrereq(false)
      setPrereqStage('')
    }
  }, [gamePath, loadFiles])

  const navigateTo = useCallback((targetDir) => {
    entryCache = {}
    setCurrentDir(targetDir)
  }, [])

  const navigateBreadcrumb = useCallback((targetDir) => {
    entryCache = {}
    setCurrentDir(targetDir)
  }, [])

  // Build breadcrumb segments: 以 rootDir 为根（模组页根为 plugins，隐藏 BepInEx 层），
  // 其余页面根为 CustomMissions / CustomMissions2，保持原有表现。
  const breadcrumbSegments = []
  if (currentDir && currentDir.startsWith(rootDir)) {
    const rootName = rootDir.split('/').pop()
    const rel = currentDir.slice(rootDir.length).replace(/^\//, '')
    const rest = rel ? rel.split('/') : []
    const all = [rootName, ...rest]
    for (let i = 0; i < all.length; i++) {
      const sub = i === 0 ? '' : rest.slice(0, i).join('/')
      const targetPath = sub ? `${rootDir}/${sub}` : rootDir
      breadcrumbSegments.push({
        label: all[i],
        targetPath,
        isLast: i === all.length - 1,
      })
    }
  }

  // Refresh a folder (re-cache and reload)
  const refresh = useCallback(() => {
    entryCache = {}
    loadFiles()
  }, [loadFiles])

  // 就地更新：拉取云端最新文件后复用 installMod 重新安装
  const handleUpdate = useCallback(async (modKey) => {
    if (!modKey) return
    const langCode = (modDetails.get(modKey)?.langCode) || 'zh'
    try {
      const { data } = await getModDetail(modKey, langCode, null, null, modKey)
      const mod = data?.data?.mod || data?.mod
      const files = mod?.files || []
      const file = files.find(f => f.lang_code === langCode) || files[0]
      if (!file) {
        alert(t('mods.updateNoFile'))
        return
      }
      await installMod({
        modKey,
        category: mod.category || categoryFromSubfolder(subfolder),
        fileUrl: file.file_url,
        version: file.version,
        fileHash: file.file_hash,
        langCode: file.lang_code,
        manifest: file.manifest,
      })
      refresh()
    } catch (e) {
      alert(t('mods.updateFailed', { msg: e?.message || String(e) }))
    }
  }, [modDetails, subfolder, t, refresh])

  const toggleItemEnabled = useCallback(async (filePath) => {
    try {
      const [newIsBanned, newPath] = await invoke('toggle_mod_enabled', { path: filePath.replace(/\//g, '\\') })
      // 更新文件列表中的状态
      setFiles(prev => prev.map(f => {
        const fullPath = `${currentDir}/${f.name}`
        if (filePath === fullPath) {
          // 重命名后文件名变了，从新路径中提取文件名
          const newName = newPath.split(/[/\\]/).pop()
          return { ...f, name: newName, isBanned: newIsBanned }
        }
        return f
      }))
    } catch (e) {
      console.error('Failed to toggle item:', e)
    }
  }, [currentDir, setFiles])

  const handleBatchToggle = useCallback(async (ban) => {
    if (!currentDir) return
    setLoading(true)
    try {
      await invoke('batch_toggle_mod_enabled', { dir: currentDir.replace(/\//g, '\\'), ban })
      await loadFiles()
    } catch (e) {
      console.error('Failed to batch toggle:', e)
    } finally {
      setLoading(false)
    }
  }, [currentDir, loadFiles, setLoading])

  // 按 mod_key 把当前目录文件索引成 Map（O(1) 取组），供组级「暂停/继续」共用，
  // 避免每次操作都对 files 全表扫描一遍（filesByKey 依赖 resolveModKey，已用 useCallback 稳定化）
  const filesByKey = useMemo(() => {
    const map = new Map()
    for (const f of files) {
      const k = resolveModKey(f.name)
      if (!k) continue
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(f)
    }
    return map
  }, [files, resolveModKey])

  // 组级「暂停/继续」共用逻辑：
  //   ban=true  → 只把组内【未禁用】的文件禁用（已禁用的跳过）
  //   ban=false → 只把组内【已禁用】的文件恢复（未禁用的跳过）
  // 因此两个按钮始终同时显示，即使组内混有用户手动暂停的文件也各自幂等、不会误操作。
  // 与 toggleItemEnabled 相同，只就地更新 files 状态而不重新扫描目录，
  // 配合 getWorkshopKey 对 [ban] 标记的归一化，改名后文件仍留在所属分组容器内。
  const handleGroupToggleAll = useCallback(async (modKey, ban) => {
    if (!currentDir) return
    const targets = (filesByKey.get(modKey) || [])
      .filter(f => !f.isDir && (ban ? !f.isBanned : f.isBanned))
    if (targets.length === 0) return
    const results = await Promise.allSettled(
      targets.map(f => invoke('toggle_mod_enabled', { path: `${currentDir}/${f.name}`.replace(/\//g, '\\') }))
    )
    const renamed = new Map() // 旧完整路径 -> 新文件名
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const newPath = r.value[1]
        renamed.set(`${currentDir}/${targets[i].name}`, newPath.split(/[/\\]/).pop())
      } else {
        console.error(`Failed to ${ban ? 'disable' : 'enable'} group member:`, r.reason)
      }
    })
    if (renamed.size === 0) return
    setFiles(prev => prev.map(f => {
      const fullPath = `${currentDir}/${f.name}`
      const newName = renamed.get(fullPath)
      return newName ? { ...f, name: newName, isBanned: ban } : f
    }))
  }, [currentDir, filesByKey, setFiles])

  const handleGroupDisableAll = useCallback((modKey) => handleGroupToggleAll(modKey, true), [handleGroupToggleAll])
  const handleGroupEnableAll = useCallback((modKey) => handleGroupToggleAll(modKey, false), [handleGroupToggleAll])

  return (
    <div className={styles.root}>
      <Card className={styles.toolbarCard}>
        <div className={styles.toolbarRow}>
          {/* Breadcrumb navigation */}
          <div className={styles.breadcrumbRow}>
            {breadcrumbSegments.map((seg, idx) => (
              <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
                {idx > 0 && (
                  <span className={styles.breadcrumbChevron}>
                    <ChevronRight24Regular style={{ fontSize: '10px', verticalAlign: 'middle' }} />
                  </span>
                )}
                <Button
                  size="small"
                  appearance="subtle"
                  className={seg.isLast ? styles.breadcrumbBtnActive : styles.breadcrumbBtn}
                  onClick={() => navigateBreadcrumb(seg.targetPath)}
                  title={seg.targetPath}
                  disabled={seg.isLast}
                >
                  {seg.label}
                </Button>
              </span>
            ))}
          </div>

          <Button size="small" icon={<FolderOpen24Regular />} appearance="subtle" onClick={() => openInExplorer(currentDir)} disabled={!currentDir} />
          <Button size="small" icon={<ArrowClockwise24Regular />} appearance="subtle" onClick={refresh} disabled={!currentDir || loading} />
          <Button size="small" icon={<Pause24Regular />} appearance="subtle" onClick={() => handleBatchToggle(true)} disabled={!currentDir || loading} title={t('mods.disableAll')} />
          <Button size="small" icon={<Play24Regular />} appearance="subtle" onClick={() => handleBatchToggle(false)} disabled={!currentDir || loading} title={t('mods.enableAll')} />
        </div>

        <Text size="small" className={styles.pathText} title={currentDir}>
          {currentDir || t('mission.notConfigured')}
        </Text>
      </Card>

      {currentDir && (
        <Text size="small" className={styles.meta} style={{ padding: '0 4px' }}>
          {t('mission.reloadTaskHint')}
        </Text>
      )}

      {isBepInEx && prereqMissing !== false && (
        <PrereqBanner
          checking={prereqMissing === null}
          installing={installingPrereq}
          progress={prereqProgress}
          stage={prereqStage}
          error={prereqError}
          onInstall={installPrereq}
          onRescan={checkPrereq}
        />
      )}

      {!(isBepInEx && prereqMissing !== false) && (
      <AsyncView loading={loading} loadingLabel={t('app.loading')}>
        {files.length === 0 && (
          <EmptyState
            title={currentDir ? t('mission.folderEmpty') : t('mission.noGameDir')}
            description={currentDir ? t('mission.noFilesInDir') : undefined}
          />
        )}

      {files.length > 0 && (() => {
        // 统计每个 mod_key 的成员数：同一创意工坊订阅（同 mod_key）出现 >= 2 个条目时归为一组
        const keyCount = new Map()
        for (const f of files) {
          const k = resolveModKey(f.name)
          if (k) keyCount.set(k, (keyCount.get(k) || 0) + 1)
        }
        const renderedGroups = new Set()

        const renderItem = (f, i, inGroup) => {
          const fullPath = `${currentDir}/${f.name}`
          const detail = getWorkshopDetail(f.name)
          const ci = getCloudInfo(f.name)
          const mk = resolveModKey(f.name)
          return f.isDir
            ? <FolderCard key={i} name={f.name} fullPath={fullPath} onNavigate={navigateTo} isWorkshop={isWorkshopMod(f.name)} workshopDetail={detail} cloudInfo={ci} onUninstall={onUninstall} hasUpdate={hasUpdate(f.name)} modKey={mk} onViewDetail={handleViewDetail} onUpdate={handleUpdate} inGroup={inGroup} selected={selectedPaths.has(fullPath)} onSelect={handleItemSelect} onOpenLocation={handleOpenLocation} />
            : <FileCard key={i} name={f.name} fullPath={fullPath} isBanned={f.isBanned} onToggle={toggleItemEnabled} isWorkshop={isWorkshopMod(f.name)} hasUpdate={hasUpdate(f.name)} workshopDetail={detail} cloudInfo={ci} onUninstall={onUninstall} modKey={mk} onViewDetail={handleViewDetail} onUpdate={handleUpdate} inGroup={inGroup} selected={selectedPaths.has(fullPath)} onSelect={handleItemSelect} onOpenLocation={handleOpenLocation} />
        }

        return (
          <div className={styles.grid}>
            {files.map((f, i) => {
              const mk = resolveModKey(f.name)
              const grouped = mk && (keyCount.get(mk) || 0) >= 2
              if (!grouped) return renderItem(f, i, false)
              // 分组：只在第一个成员出现的位置渲染整组，其余成员跳过
              if (renderedGroups.has(mk)) return null
              renderedGroups.add(mk)
              const members = files
                .map((m, j) => ({ m, j }))
                .filter(({ m }) => resolveModKey(m.name) === mk)
              return (
                <ModGroupCard
                  key={`group-${mk}`}
                  modKey={mk}
                  items={members.map(x => x.m)}
                  workshopDetail={modDetails.get(mk)}
                  cloudInfo={cloudInfo.get(mk)}
                  hasUpdate={updates.has(mk)}
                  onViewDetail={handleViewDetail}
                  onUpdate={handleUpdate}
                  onUninstall={onUninstall}
                  onDisableAll={handleGroupDisableAll}
                  onEnableAll={handleGroupEnableAll}
                >
                  {members.map(({ m, j }) => renderItem(m, j, true))}
                </ModGroupCard>
              )
            })}
          </div>
        )
      })()}
      </AsyncView>
      )}
    </div>
  )
}
