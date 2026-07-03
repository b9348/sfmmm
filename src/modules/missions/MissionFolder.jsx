import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { makeStyles, tokens, Text, Button, Spinner, Card, CardHeader, Badge, Tooltip } from '@fluentui/react-components'
import { FolderOpen24Regular, ArrowClockwise24Regular, Document24Regular, Folder24Regular, ChevronRight24Regular, Play24Regular, Pause24Regular, Delete24Regular } from '@fluentui/react-icons'
import { invoke } from '@tauri-apps/api/core'
import { readDir } from '@tauri-apps/plugin-fs'
import { useInstalledMods } from '../../hooks/useInstalledMods'

const LANG_LABELS = { zh: '中文', en: 'English', ja: '日本語' }

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
    justifyContent: 'flex-start',
    marginTop: '4px',
  },
})

let entryCache = {}

async function listFiles(dir) {
  try {
    // 将 Windows 反斜杠路径转换为正斜杠，以兼容 Tauri FS API
    const normalizedDir = dir.replace(/\\/g, '/')
    const entries = await readDir(normalizedDir)
    return entries.filter(e => !e.name?.startsWith('.'))
      .map(e => {
        const name = e.name
        // 检测 [ban] 禁用标记：xxx[ban]json 或 xxx[ban]dll
        const lower = name.toLowerCase()
        const isBanned = lower.endsWith('[ban]json') || lower.endsWith('[ban]dll')
        return { name, isDir: e.isDirectory === true || e.children !== undefined, isBanned }
      })
      .sort((a, b) => {
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
    const count = entries.filter(e => !e.name?.startsWith('.')).length
    const dirs = entries.filter(e => !e.name?.startsWith('.') && (e.isDirectory || e.children !== undefined)).length
    const result = { total: count, dirs }
    entryCache[dirPath] = result
    return result
  } catch {
    return { total: 0, dirs: 0 }
  }
}

function getExt(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

async function openInExplorer(dir) {
  try {
    // Windows 需要原生反斜杠路径
    const normalized = dir.replace(/\//g, '\\')
    await invoke('open_folder', { path: normalized })
  } catch (e) {
    console.error('Failed to open folder:', e)
  }
}

function FolderCard({ name, fullPath, onNavigate, isWorkshop, workshopDetail, onUninstall }) {
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

  return (
    <Card className={styles.card} appearance="outline" onClick={() => onNavigate(fullPath)}>
      <CardHeader
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <Folder24Regular />
            <Text size="small" weight="semibold" className={styles.fileName}>{name}</Text>
            {isWorkshop && <Badge appearance="filled" color="success" size="small">{t('mods.workshopBadge')}</Badge>}
            {isWorkshop && workshopDetail?.version && <Badge appearance="outline" size="small">v{workshopDetail.version}</Badge>}
            {isWorkshop && workshopDetail?.langCode && <Badge appearance="outline" size="small">{LANG_LABELS[workshopDetail.langCode] || workshopDetail.langCode}</Badge>}
            {isWorkshop && onUninstall && (
              <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onUninstall({ name }) }} />
            )}
          </div>
        }
        description={
          childInfo && (
            <Text size="small" className={styles.meta}>
              {childInfo.dirs > 0
                ? t('mission.folderCount', { dirs: childInfo.dirs, files: childInfo.total - childInfo.dirs })
                : t('mission.itemCount', { count: childInfo.total })}
            </Text>
          )
        }
      />
    </Card>
  )
}

function FileCard({ name, fullPath, isBanned, onToggle, isWorkshop, hasUpdate, workshopDetail, onUninstall }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const ext = getExt(name)
  return (
    <Card className={styles.card} appearance="outline" onClick={() => openInExplorer(fullPath)}>
      <CardHeader
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <Document24Regular />
            <Text size="small" weight="semibold" className={styles.fileName}>{name}</Text>
          </div>
        }
        description={
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
            <Badge appearance="outline" size="small">{ext.toUpperCase()}</Badge>
            {isBanned && <Badge appearance="filled" color="danger" size="small">{t('mods.disabled')}</Badge>}
            {isWorkshop && <Badge appearance="filled" color="success" size="small">{t('mods.workshopBadge')}</Badge>}
            {isWorkshop && workshopDetail?.version && <Badge appearance="outline" size="small">v{workshopDetail.version}</Badge>}
            {isWorkshop && workshopDetail?.langCode && <Badge appearance="outline" size="small">{LANG_LABELS[workshopDetail.langCode] || workshopDetail.langCode}</Badge>}
            {hasUpdate && <Badge appearance="filled" color="warning" size="small">{t('mods.hasUpdate')}</Badge>}
            {isWorkshop && onUninstall && (
              <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); onUninstall({ name }) }} />
            )}
          </div>
        }
      />
      <div className={styles.buttonRow}>
        <Tooltip content={isBanned ? t('mods.enable') : t('mods.disable')} relationship="label">
          <Button
            size="small"
            icon={isBanned ? <Play24Regular /> : <Pause24Regular />}
            appearance="subtle"
            onClick={(e) => { e.stopPropagation(); onToggle(fullPath) }}
          />
        </Tooltip>
      </div>
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
  const { installed, updates, modDetails } = useInstalledMods()

  // 检查文件/文件夹是否是已安装的工坊模组
  const getWorkshopKey = (name) => name.replace(/\.\w+$/, '').replace(/\/$/, '')
  const isWorkshopMod = (name) => installed.has(getWorkshopKey(name))
  const hasUpdate = (name) => updates.has(getWorkshopKey(name))
  const getWorkshopDetail = (name) => modDetails.get(getWorkshopKey(name))

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

  const navigateTo = useCallback((targetDir) => {
    entryCache = {}
    setCurrentDir(targetDir)
  }, [])

  const navigateBreadcrumb = useCallback((targetDir) => {
    entryCache = {}
    setCurrentDir(targetDir)
  }, [])

  // Build breadcrumb segments: root folder name + subfolder names
  const breadcrumbSegments = []
  if (currentDir && currentDir.startsWith(gamePath)) {
    const relative = currentDir.slice(gamePath.length + 1) // skip trailing /
    const parts = relative.split('/')
    // 第一个 segment 是 root（CustomMissions 或 CustomMissions2）
    for (let i = 0; i < parts.length; i++) {
      // 构建到当前部分的完整路径
      const targetPath = `${gamePath}/${parts.slice(0, i + 1).join('/')}`
      breadcrumbSegments.push({
        label: parts[i],
        targetPath,
        isLast: i === parts.length - 1,
      })
    }
  }

  // Refresh a folder (re-cache and reload)
  const refresh = useCallback(() => {
    entryCache = {}
    loadFiles()
  }, [loadFiles])

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

      {loading && (
        <div className={styles.emptyState}>
          <Spinner size="small" label={t('app.loading')} />
        </div>
      )}

      {!loading && files.length === 0 && (
        <div className={styles.emptyState}>
          <Text weight="semibold">{currentDir ? t('mission.folderEmpty') : t('mission.noGameDir')}</Text>
          {currentDir && (
            <Text size="small" className={styles.meta}>{t('mission.noFilesInDir')}</Text>
          )}
        </div>
      )}

      {!loading && files.length > 0 && (
        <div className={styles.grid}>
          {files.map((f, i) => {
            const fullPath = `${currentDir}/${f.name}`
            const detail = getWorkshopDetail(f.name)
            return f.isDir
              ? <FolderCard key={i} name={f.name} fullPath={fullPath} onNavigate={navigateTo} isWorkshop={isWorkshopMod(f.name)} workshopDetail={detail} onUninstall={onUninstall} />
              : <FileCard key={i} name={f.name} fullPath={fullPath} isBanned={f.isBanned} onToggle={toggleItemEnabled} isWorkshop={isWorkshopMod(f.name)} hasUpdate={hasUpdate(f.name)} workshopDetail={detail} onUninstall={onUninstall} />
          })}
        </div>
      )}
    </div>
  )
}
