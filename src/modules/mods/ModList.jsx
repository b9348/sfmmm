import {
  Card,
  Text,
  Badge,
  Button,
  SearchBox,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Spinner,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  FolderOpen24Regular,
  MoreHorizontal24Regular,
  Dismiss16Regular,
  Play24Regular,
  Pause24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens, mergeClasses } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useState } from 'react'

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
})

function formatScanTime(value) {
  if (!value) {
    return '未扫描'
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

function getKindLabel(kind) {
  return kind === 'dll' ? 'DLL 模组' : '文件'
}

export function ModList({ config }) {
  const styles = useStyles()
  const gamePath = config?.game_path || ''
  const [search, setSearch] = useState('')
  const [mods, setMods] = useState([])
  const [scanInfo, setScanInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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

    return mods.filter(mod => [mod.name, mod.relativePath, getKindLabel(mod.kind)]
      .some(value => value.toLowerCase().includes(keyword)))
  }, [mods, search])

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

  const activeDir = scanInfo?.activeDirs?.[0]
  const missingCoreFiles = scanInfo?.missingCoreFiles || []
  const prerequisiteInstalled = scanInfo?.bepinExInstalled === true
  const pathText = activeDir ? `插件目录：${activeDir}` : `游戏目录：${gamePath || '未配置'}`
  const prerequisiteText = prerequisiteInstalled ? 'mod 前置已安装' : 'mod 前置未安装'
  const warningText = scanInfo?.warnings?.[0] || ''
  const checkedText = scanInfo?.checkedDirs?.length ? `已检查：${scanInfo.checkedDirs.join('、')}` : ''

  const renderEmptyState = () => {
    if (loading) {
      return (
        <div className={styles.emptyState}>
          <Spinner size="small" label="正在扫描模组目录" />
        </div>
      )
    }

    if (!gamePath) {
      return (
        <div className={styles.emptyState}>
          <Text weight="semibold">尚未配置游戏目录</Text>
          <Text size="small" className={styles.emptyDetails}>请先在设置页选择游戏目录。</Text>
        </div>
      )
    }

    if (error) {
      return (
        <div className={styles.emptyState}>
          <Text weight="semibold">扫描失败</Text>
          <Text size="small" className={styles.emptyDetails} title={error}>{error}</Text>
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={scanMods}>重新扫描</Button>
        </div>
      )
    }

    if (mods.length > 0 && filteredMods.length === 0) {
      return (
        <div className={styles.emptyState}>
          <Text weight="semibold">没有匹配“{search}”的模组</Text>
          <Button size="small" icon={<Dismiss16Regular />} onClick={() => setSearch('')}>清除搜索</Button>
        </div>
      )
    }

    if (missingCoreFiles.length > 0) {
      return (
        <div className={styles.emptyState}>
          <Text weight="semibold">mod 前置未安装</Text>
          <Text size="small" className={styles.emptyDetails}>缺少 {missingCoreFiles.length} 个核心文件：</Text>
          <div className={styles.missingList}>
            {missingCoreFiles.slice(0, 20).map(file => (
              <div key={file} className={styles.missingItem} title={file}>缺少 {file}</div>
            ))}
            {missingCoreFiles.length > 20 && (
              <div className={styles.missingItem}>还有 {missingCoreFiles.length - 20} 个文件未显示</div>
            )}
          </div>
          <div className={styles.toolbarRow}>
            <Button size="small" icon={<ArrowClockwise24Regular />} onClick={scanMods}>重新检测</Button>
            <Button size="small" icon={<FolderOpen24Regular />} onClick={() => openPath(gamePath)}>打开游戏目录</Button>
          </div>
        </div>
      )
    }

    return (
      <div className={styles.emptyState}>
        <Text weight="semibold">未找到 DLL 模组</Text>
        <Text size="small" className={styles.emptyDetails} title={warningText || checkedText}>
          {warningText || '插件目录中没有 DLL 模组'}
        </Text>
        {checkedText && (
          <Text size="small" className={styles.emptyDetails} title={checkedText}>{checkedText}</Text>
        )}
        <div className={styles.toolbarRow}>
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={scanMods}>扫描</Button>
          <Button size="small" icon={<FolderOpen24Regular />} onClick={() => openPath(gamePath)}>打开游戏目录</Button>
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
            placeholder="搜索模组"
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
            扫描
          </Button>
          <Button size="small" icon={<FolderOpen24Regular />} onClick={() => openPath(activeDir || gamePath)} disabled={!gamePath}>
            打开插件目录
          </Button>
        </div>
        <Text size="small" className={styles.pathLine} title={pathText}>{pathText}</Text>
      </Card>

      <div className={styles.listPanel}>
        {filteredMods.length === 0 ? renderEmptyState() : filteredMods.map(mod => (
          <div key={mod.id} className={styles.row}>
            <div className={styles.rowInfo}>
              <div className={styles.rowTitle}>
                <Text size="small" weight="semibold" className={styles.truncatedText} title={mod.name}>{mod.name}</Text>
                <Badge appearance="outline" size="small">{getKindLabel(mod.kind)}</Badge>
                {mod.isDirectoryMod && <Badge appearance="filled" color="brand" size="small">文件夹配置</Badge>}
                {mod.isBanned && <Badge appearance="filled" color="danger" size="small">已禁用</Badge>}
              </div>
              <Text size="small" className={mergeClasses(styles.truncatedText, styles.muted)} title={mod.relativePath}>
                {mod.relativePath}
              </Text>
            </div>
            <Button
              size="small"
              icon={mod.isBanned ? <Play24Regular /> : <Pause24Regular />}
              appearance="subtle"
              className={styles.toggleButton}
              onClick={() => toggleModEnabled(mod)}
              title={mod.isBanned ? '启用' : '禁用'}
            />
            <Menu>
              <MenuTrigger>
                <Button size="small" icon={<MoreHorizontal24Regular />} appearance="subtle" />
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem onClick={() => openPath(mod.kind === 'directory' ? mod.path : mod.sourceDir)}>打开所在目录</MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        ))}
      </div>

      <div className={styles.statusBar}>
        <Text size="small" className={styles.statusText}>共 {mods.length} 个，显示 {filteredMods.length} 个</Text>
        <Text size="small" className={mergeClasses(styles.statusText, styles.spacer)} title={warningText || pathText}>
          {error || warningText || (scanInfo ? `${prerequisiteText} · ${pathText}` : pathText)}
        </Text>
        <Text size="small">{formatScanTime(scanInfo?.scannedAt)}</Text>
      </div>
    </div>
  )
}
