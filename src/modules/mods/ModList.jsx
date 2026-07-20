import {
  Card,
  Text,
  Badge,
  Button,
  SearchBox,
  Spinner,
  Tooltip,
  ProgressBar,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  FolderOpen24Regular,
  Dismiss16Regular,
  Play24Regular,
  Pause24Regular,
  Delete24Regular,
  ArrowDownload24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens, mergeClasses } from '@fluentui/react-components'
import { invoke, Channel } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInstalledMods } from '../../hooks/useInstalledMods'
import { LANG_LABELS } from '../../i18n/languages'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    gap: '6px',
  },
  toolbarCard: {
    padding: '8px',
    flexShrink: 0,
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  search: {
    flex: '1 1 160px',
    minWidth: '120px',
    maxWidth: '240px',
  },
  pathLine: {
    marginTop: '6px',
    display: 'block',
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  listPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '44px',
    padding: '4px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    ':last-child': {
      borderBottom: 'none',
    },
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  rowTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  truncatedText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  muted: {
    color: tokens.colorNeutralForeground2,
  },
  toggleButton: {
    minWidth: '32px',
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 0,
  },
  emptyState: {
    height: '100%',
    minHeight: '120px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
    padding: '16px',
    textAlign: 'center',
  },
  emptyDetails: {
    maxWidth: '100%',
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  missingList: {
    maxWidth: '100%',
    maxHeight: '120px',
    overflow: 'auto',
    textAlign: 'left',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  missingItem: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  statusBar: {
    flexShrink: 0,
    minHeight: '24px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '0 4px',
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
  },
  statusText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  progressRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    width: '100%',
    maxWidth: '280px',
  },
})

function formatScanTime(value, t) {
  if (!value) {
    return t('mods.notScanned')
  }

  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return value
  }

  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function getKindLabel(kind, t) {
  return kind === 'dll' ? t('mods.dllMod') : t('mods.file')
}

export function ModList({ config, onUninstall }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const gamePath = config?.game_path || ''
  const [search, setSearch] = useState('')
  const [mods, setMods] = useState([])
  const [scanInfo, setScanInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [installingBepInEx, setInstallingBepInEx] = useState(false)
  const [bepInExProgress, setBepInExProgress] = useState(0)
  const [bepInExStage, setBepInExStage] = useState('')
  const { installed, updates, modDetails } = useInstalledMods()

  const scanMods = useCallback(async () => {
    if (!gamePath) {
      setMods([])
      setScanInfo(null)
      setError('')
      return
    }

    setLoading(true)
    setError('')

    try {
      const result = await invoke('scan_mods', { gamePath })
      setMods(result.mods || [])
      setScanInfo(result)
    } catch (e) {
      setMods([])
      setScanInfo(null)
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [gamePath])

  useEffect(() => {
    Promise.resolve().then(scanMods)
  }, [scanMods])

  const filteredMods = useMemo(() => {
    const keyword = search.trim().toLowerCase()

    if (!keyword) {
      return mods
    }

    return mods.filter(mod => [mod.name, mod.relativePath, getKindLabel(mod.kind, t)]
      .some(value => value.toLowerCase().includes(keyword)))
  }, [mods, search, t])

  // 检查是否是已安装的工坊模组
  const workshopInfo = useMemo(() => {
    const map = new Map()
    for (const mod of mods) {
      const key = mod.name.replace(/\.\w+$/, '').replace(/\/$/, '') // DLL 去扩展名，目录去斜杠
      if (installed.has(key)) {
        const detail = modDetails.get(key)
        map.set(mod.id, {
          isWorkshop: true,
          hasUpdate: updates.has(key),
          version: detail?.version,
          langCode: detail?.langCode,
        })
      }
    }
    return map
  }, [mods, installed, updates, modDetails])

  const openPath = async (path) => {
    if (path) {
      await invoke('open_folder', { path })
    }
  }

  const toggleModEnabled = async (mod) => {
    try {
      const [newIsBanned, newPath] = await invoke('toggle_mod_enabled', { path: mod.path })
      setMods(prev => prev.map(m => {
        if (m.id === mod.id) {
          return {
            ...m,
            isBanned: newIsBanned,
            path: newPath,
            name: newIsBanned ? m.name.replace(/\s*\[ban\]$/, '') + ' [ban]' : m.name.replace(/\s*\[ban\]$/, ''),
          }
        }
        return m
      }))
    } catch (e) {
      console.error('Failed to toggle mod enabled:', e)
    }
  }

  const handleBatchToggle = useCallback(async (ban) => {
    const targets = filteredMods.filter(m => m.isBanned !== ban)
    if (targets.length === 0) return
    setLoading(true)
    try {
      for (const mod of targets) {
        await invoke('toggle_mod_enabled', { path: mod.path })
      }
      await scanMods()
    } catch (e) {
      console.error('Failed to batch toggle:', e)
    } finally {
      setLoading(false)
    }
  }, [filteredMods, scanMods])

  const installBepInEx = useCallback(async () => {
    if (!gamePath) return
    setInstallingBepInEx(true)
    setBepInExProgress(0)
    setBepInExStage('downloading')
    setError('')
    try {
      const channel = new Channel((msg) => {
        setBepInExProgress(msg.percent)
        setBepInExStage(msg.stage)
      })
      await invoke('download_and_extract_7z', {
        url: 'https://img.b9349.dpdns.org/file/sfm/BepInEx6/BepInEx6.7z',
        targetDir: gamePath,
        onProgress: channel,
      })
      await scanMods()
    } catch (e) {
      setError(String(e))
    } finally {
      setInstallingBepInEx(false)
      setBepInExStage('')
    }
  }, [gamePath, scanMods])

  const activeDir = scanInfo?.activeDirs?.[0]
  const missingCoreFiles = scanInfo?.missingCoreFiles || []
  const prerequisiteInstalled = scanInfo?.bepinExInstalled === true
  const pathText = activeDir ? `${t('mods.pluginDir')}：${activeDir}` : `${t('mods.gameDir')}：${gamePath || t('mods.notConfigured')}`
  const prerequisiteText = prerequisiteInstalled ? t('mods.prereqInstalled') : t('mods.prereqNotInstalled')
  const warningText = scanInfo?.warnings?.[0] || ''
  const checkedText = scanInfo?.checkedDirs?.length ? `${t('mods.checked')}：${scanInfo.checkedDirs.join('、')}` : ''

  const renderEmptyState = () => {
    if (loading) {
      return (
        <div className={styles.emptyState}>
          <Spinner size="small" label={t('mods.scanning')} />
        </div>
      )
    }

    if (!gamePath) {
      return (
        <div className={styles.emptyState}>
          <Text weight="semibold">{t('mods.noGameDir')}</Text>
          <Text size="small" className={styles.emptyDetails}>{t('mods.noGameDirHint')}</Text>
        </div>
      )
    }

    if (error) {
      return (
        <div className={styles.emptyState}>
          <Text weight="semibold">{t('mods.scanFailed')}</Text>
          <Text size="small" className={styles.emptyDetails} title={error}>{error}</Text>
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={scanMods}>{t('mods.reScan')}</Button>
        </div>
      )
    }

    if (mods.length > 0 && filteredMods.length === 0) {
      return (
        <div className={styles.emptyState}>
          <Text weight="semibold">{t('mods.noMatch', { search })}</Text>
          <Button size="small" icon={<Dismiss16Regular />} onClick={() => setSearch('')}>{t('mods.clearSearch')}</Button>
        </div>
      )
    }

    if (missingCoreFiles.length > 0) {
      return (
        <div className={styles.emptyState}>
          <Text weight="semibold">{t('mods.prereqNotInstalled')}</Text>
          <Text size="small" className={styles.emptyDetails}>{t('mods.missingFiles', { count: missingCoreFiles.length })}</Text>
          <div className={styles.missingList}>
            {missingCoreFiles.slice(0, 20).map(file => (
              <div key={file} className={styles.missingItem} title={file}>{t('mods.missing')} {file}</div>
            ))}
            {missingCoreFiles.length > 20 && (
              <div className={styles.missingItem}>{t('mods.moreFiles', { count: missingCoreFiles.length - 20 })}</div>
            )}
          </div>
          <div className={styles.toolbarRow}>
            <Button size="small" icon={<ArrowClockwise24Regular />} onClick={scanMods} disabled={loading || installingBepInEx}>{t('mods.reDetect')}</Button>
            <Button size="small" icon={<FolderOpen24Regular />} onClick={() => openPath(gamePath)} disabled={installingBepInEx}>{t('mods.openGameDir')}</Button>
          </div>
          <div className={styles.toolbarRow}>
            <Button
              size="small"
              icon={installingBepInEx ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
              onClick={installBepInEx}
              disabled={installingBepInEx || loading}
            >
              {installingBepInEx ? t('mods.installingBepInEx') : t('mods.downloadInstallBepInEx')}
            </Button>
          </div>
          {installingBepInEx && (
            <div className={styles.progressRow}>
              <ProgressBar value={bepInExProgress} />
              <Text size="small" className={styles.muted}>
                {bepInExStage === 'downloading' && `${t('mods.downloadingBepInEx')} ${bepInExProgress}%`}
                {bepInExStage === 'extracting' && t('mods.extractingBepInEx')}
              </Text>
            </div>
          )}
        </div>
      )
    }

    return (
      <div className={styles.emptyState}>
        <Text weight="semibold">{t('mods.noDllMods')}</Text>
        <Text size="small" className={styles.emptyDetails} title={warningText || checkedText}>
          {warningText || t('mods.noDllInPluginDir')}
        </Text>
        {checkedText && (
          <Text size="small" className={styles.emptyDetails} title={checkedText}>{checkedText}</Text>
        )}
        <div className={styles.toolbarRow}>
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={scanMods}>{t('mods.scan')}</Button>
          <Button size="small" icon={<FolderOpen24Regular />} onClick={() => openPath(gamePath)}>{t('mods.openGameDir')}</Button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <Card className={styles.toolbarCard}>
        <div className={styles.toolbarRow}>
          <SearchBox
            className={styles.search}
            size="small"
            placeholder={t('mods.searchPlaceholder')}
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            disabled={!mods.length}
          />
          {scanInfo && (
            <Badge appearance={prerequisiteInstalled ? 'filled' : 'outline'} color={prerequisiteInstalled ? 'success' : 'danger'} size="small">
              {prerequisiteText}
            </Badge>
          )}
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={scanMods} disabled={!gamePath || loading}>
            {t('mods.scan')}
          </Button>
          <Button size="small" icon={<FolderOpen24Regular />} onClick={() => openPath(activeDir || gamePath)} disabled={!gamePath}>
            {t('mods.openPluginDir')}
          </Button>
          <Button size="small" icon={<Pause24Regular />} appearance="subtle" onClick={() => handleBatchToggle(true)} disabled={!gamePath || loading || filteredMods.length === 0} title={t('mods.disableAll')} />
          <Button size="small" icon={<Play24Regular />} appearance="subtle" onClick={() => handleBatchToggle(false)} disabled={!gamePath || loading || filteredMods.length === 0} title={t('mods.enableAll')} />
        </div>
        <Text size="small" className={styles.pathLine} title={pathText}>{pathText}</Text>
      </Card>

      <div className={styles.listPanel}>
        {filteredMods.length === 0 ? renderEmptyState() : filteredMods.map(mod => (
          <div key={mod.id} className={styles.row}>
            <div className={styles.rowInfo}>
              <div className={styles.rowTitle}>
                <Text size="small" weight="semibold" className={styles.truncatedText} title={mod.name}>{mod.name}</Text>
                <Badge appearance="outline" size="small">{getKindLabel(mod.kind, t)}</Badge>
                {mod.isDirectoryMod && <Badge appearance="filled" color="brand" size="small">{t('mods.folderConfig')}</Badge>}
                {mod.isBanned && <Badge appearance="filled" color="danger" size="small">{t('mods.disabled')}</Badge>}
                {workshopInfo.get(mod.id)?.isWorkshop && <Badge appearance="filled" color="success" size="small">{t('mods.workshopBadge')}</Badge>}
                {workshopInfo.get(mod.id)?.isWorkshop && workshopInfo.get(mod.id)?.version && <Badge appearance="outline" size="small">v{workshopInfo.get(mod.id).version}</Badge>}
                {workshopInfo.get(mod.id)?.isWorkshop && workshopInfo.get(mod.id)?.langCode && <Badge appearance="outline" size="small">{LANG_LABELS[workshopInfo.get(mod.id).langCode] || workshopInfo.get(mod.id).langCode}</Badge>}
                {workshopInfo.get(mod.id)?.hasUpdate && <Badge appearance="filled" color="warning" size="small">{t('mods.hasUpdate')}</Badge>}
              </div>
              <Text size="small" className={mergeClasses(styles.truncatedText, styles.muted)} title={mod.relativePath}>
                {mod.relativePath}
              </Text>
            </div>
            <div className={styles.actionRow}>
              {workshopInfo.get(mod.id)?.isWorkshop && (
                <Tooltip content={t('mods.uninstall')} relationship="label">
                  <Button
                    size="small"
                    icon={<Delete24Regular />}
                    appearance="subtle"
                    className={styles.toggleButton}
                    onClick={() => onUninstall?.(mod)}
                  />
                </Tooltip>
              )}
              <Tooltip content={mod.isBanned ? t('mods.enable') : t('mods.disable')} relationship="label">
                <Button
                  size="small"
                  icon={mod.isBanned ? <Play24Regular /> : <Pause24Regular />}
                  appearance="subtle"
                  className={styles.toggleButton}
                  onClick={() => toggleModEnabled(mod)}
                />
              </Tooltip>
              <Tooltip content={t('mods.openContainingFolder')} relationship="label">
                <Button
                  size="small"
                  icon={<FolderOpen24Regular />}
                  appearance="subtle"
                  onClick={() => openPath(mod.kind === 'directory' ? mod.path : mod.sourceDir)}
                />
              </Tooltip>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.statusBar}>
        <Text size="small" className={styles.statusText}>{t('mods.status', { total: mods.length, shown: filteredMods.length })}</Text>
        <Text size="small" className={mergeClasses(styles.statusText, styles.spacer)} title={warningText || pathText}>
          {error || warningText || (scanInfo ? `${prerequisiteText} · ${pathText}` : pathText)}
        </Text>
        <Text size="small">{formatScanTime(scanInfo?.scannedAt, t)}</Text>
      </div>
    </div>
  )
}
