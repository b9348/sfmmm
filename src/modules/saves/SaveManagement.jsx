import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Input,
  Badge,
  Tooltip,
  Spinner,
  useToastController,
  Toast,
  ToastTitle,
  ToastBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  ArrowClockwise24Regular,
  Save24Regular,
  ArrowSync24Regular,
  Edit24Regular,
  Checkmark24Regular,
  Dismiss24Regular,
} from '@fluentui/react-icons'
import { ConfirmDialog } from '../../components/common/ConfirmDialog'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    height: '100%',
    minHeight: 0,
  },
  toolbarCard: {
    padding: '8px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  push: {
    marginLeft: 'auto',
  },
  tableWrap: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
  },
  table: {
    width: '100%',
    minWidth: '560px',
  },
  nameCell: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
  },
  fileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  renameInput: {
    maxWidth: '260px',
  },
  actionCell: {
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap',
  },
  empty: {
    padding: '32px 8px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
  },
  loading: {
    padding: '32px 8px',
    textAlign: 'center',
  },
})

// 格式化文件大小：B / KB / MB
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// 类型徽章文案与配色（kind: save=存档 / settings=设置 / backup=备份）
const KIND_META = {
  save: { labelKey: 'saves.kindSave', color: 'informative' },
  settings: { labelKey: 'saves.kindSettings', color: 'warning' },
  backup: { labelKey: 'saves.kindBackup', color: 'success' },
}

export function SaveManagement() {
  const styles = useStyles()
  const { t } = useTranslation()
  const { dispatchToast } = useToastController()
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)
  const [busyName, setBusyName] = useState(null) // 正在备份/还原/改名的文件名
  // 内联改名状态：{ name, value }，name 为原始文件名
  const [editing, setEditing] = useState(null)
  // 还原命名冲突确认弹窗：非 null 时记录待覆盖还原的备份文件名
  const [confirmRestoreName, setConfirmRestoreName] = useState(null)
  const renameRef = useRef(null)

  // 统一 toast：content 必须是 JSX（react-toast 9.8 的 dispatchToast 签名
  // 为 (content: ReactNode, options?)，intent 走第二个参数，不支持数据对象形式）
  const showToast = useCallback((intent, title, body) => {
    dispatchToast(
      <Toast>
        <ToastTitle>{title}</ToastTitle>
        {body ? <ToastBody>{body}</ToastBody> : null}
      </Toast>,
      { intent },
    )
  }, [dispatchToast])

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      const list = await invoke('list_save_files')
      setFiles(list || [])
    } catch (e) {
      showToast('error', t('saves.loadFailed'), e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [showToast, t])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // 打开存档目录
  const openFolder = useCallback(async () => {
    try {
      const dir = await invoke('get_save_dir')
      await invoke('open_folder', { path: dir })
    } catch (e) {
      showToast('error', t('saves.openFolderFailed'), e?.message || String(e))
    }
  }, [showToast, t])

  // 备份：{name}.sd → {name}.sd.bak
  const backup = useCallback(async (name) => {
    setBusyName(name)
    try {
      await invoke('backup_save_file', { name })
      showToast('success', t('saves.backupSuccess', { name }))
      await loadFiles()
    } catch (e) {
      showToast('error', t('saves.backupFailed'), e?.message || String(e))
    } finally {
      setBusyName(null)
    }
  }, [showToast, t, loadFiles])

  // 还原：{name}.sd.bak → {name}.sd。
  // 指纹校验通过后若目标同名存档已存在，Rust 返回 `CONFLICT:` 错误码，
  // 此处改为弹窗询问用户是否覆盖，而不是直接 toast 报错。
  const restore = useCallback(async (name) => {
    setBusyName(name)
    try {
      await invoke('restore_save_file', { name, overwrite: false })
      showToast('success', t('saves.restoreSuccess', { name }))
      await loadFiles()
    } catch (e) {
      const msg = e?.message || String(e)
      if (msg.startsWith('CONFLICT:')) {
        setConfirmRestoreName(name)
      } else {
        showToast('error', t('saves.restoreFailed'), msg)
      }
    } finally {
      setBusyName(null)
    }
  }, [showToast, t, loadFiles])

  // 用户确认覆盖后：带 overwrite=true 重新调用还原
  const confirmRestoreOverwrite = useCallback(async () => {
    const name = confirmRestoreName
    setConfirmRestoreName(null)
    if (!name) return
    setBusyName(name)
    try {
      await invoke('restore_save_file', { name, overwrite: true })
      showToast('success', t('saves.restoreSuccess', { name }))
      await loadFiles()
    } catch (e) {
      showToast('error', t('saves.restoreFailed'), e?.message || String(e))
    } finally {
      setBusyName(null)
    }
  }, [confirmRestoreName, showToast, t, loadFiles])

  // 提交内联改名
  const submitRename = useCallback(async () => {
    if (!editing) return
    const { name, value } = editing
    setEditing(null)
    const newName = value.trim()
    if (!newName || newName === name) return
    setBusyName(name)
    try {
      await invoke('rename_save_file', { name, newName })
      showToast('success', t('saves.renameSuccess', { name: newName }))
      await loadFiles()
    } catch (e) {
      showToast('error', t('saves.renameFailed'), e?.message || String(e))
    } finally {
      setBusyName(null)
    }
  }, [editing, showToast, t, loadFiles])

  // 取消内联改名
  const cancelRename = useCallback(() => setEditing(null), [])

  const startRename = useCallback((name) => {
    setEditing({ name, value: name })
    requestAnimationFrame(() => renameRef.current?.focus())
  }, [])

  return (
    <div className={styles.root}>
      <div className={styles.toolbarCard}>
        <Button size="small" icon={<Folder24Regular />} onClick={openFolder}>{t('saves.openFolder')}</Button>
        <Button size="small" icon={<ArrowClockwise24Regular />} onClick={loadFiles} disabled={loading}>{t('saves.refresh')}</Button>
        <Button
          size="small"
          icon={<Save24Regular />}
          appearance="primary"
          onClick={openFolder}
          className={styles.push}
        >
          {t('saves.backupHint')}
        </Button>
      </div>

      <div className={styles.tableWrap}>
        {loading ? (
          <div className={styles.loading}><Spinner size="small" label={t('saves.loading')} /></div>
        ) : files.length === 0 ? (
          <div className={styles.empty}>{t('saves.empty')}</div>
        ) : (
          <Table className={styles.table} size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('saves.name')}</TableHeaderCell>
                <TableHeaderCell>{t('saves.type')}</TableHeaderCell>
                <TableHeaderCell>{t('saves.size')}</TableHeaderCell>
                <TableHeaderCell>{t('saves.modified')}</TableHeaderCell>
                <TableHeaderCell>{t('saves.actions')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => {
                const meta = KIND_META[file.kind] || KIND_META.save
                const isEditing = editing?.name === file.name
                const isBusy = busyName === file.name
                const isBackup = file.kind === 'backup'
                return (
                  <TableRow key={file.path}>
                    <TableCell>
                      {isEditing ? (
                        <Input
                          ref={renameRef}
                          className={styles.renameInput}
                          size="small"
                          value={editing.value}
                          onChange={(_, d) => setEditing((prev) => prev ? { ...prev, value: d.value } : prev)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitRename()
                            if (e.key === 'Escape') cancelRename()
                          }}
                          aria-label={t('saves.renamePlaceholder')}
                        />
                      ) : (
                        <div className={styles.nameCell}>
                          <Tooltip content={file.name} relationship="label">
                            <Text size="small" className={styles.fileName}>{file.name}</Text>
                          </Tooltip>
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<Edit24Regular />}
                            onClick={() => startRename(file.name)}
                            disabled={isBusy}
                            aria-label={t('saves.rename')}
                          />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge color={meta.color} appearance="filled">{t(meta.labelKey)}</Badge>
                    </TableCell>
                    <TableCell><Text size="small">{formatSize(file.size)}</Text></TableCell>
                    <TableCell><Text size="small">{file.modified}</Text></TableCell>
                    <TableCell>
                      <div className={styles.actionCell}>
                        {isEditing ? (
                          <>
                            <Button size="small" icon={<Checkmark24Regular />} appearance="primary" onClick={submitRename} disabled={isBusy}>
                              {t('saves.confirm')}
                            </Button>
                            <Button size="small" icon={<Dismiss24Regular />} onClick={cancelRename}>
                              {t('saves.cancel')}
                            </Button>
                          </>
                        ) : isBackup ? (
                          <Button
                            size="small"
                            icon={isBusy ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
                            onClick={() => restore(file.name)}
                            disabled={isBusy}
                          >
                            {t('saves.restore')}
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            icon={isBusy ? <Spinner size="tiny" /> : <Save24Regular />}
                            onClick={() => backup(file.name)}
                            disabled={isBusy}
                          >
                            {t('saves.backup')}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* 还原命名冲突确认弹窗：目标同名存档已存在，询问是否覆盖 */}
      <ConfirmDialog
        open={!!confirmRestoreName}
        onClose={() => setConfirmRestoreName(null)}
        title={t('saves.restoreConflictTitle')}
        confirmText={t('saves.overwrite')}
        onConfirm={confirmRestoreOverwrite}
      >
        {t('saves.restoreConflictBody', { name: confirmRestoreName || '' })}
      </ConfirmDialog>
    </div>
  )
}

export default SaveManagement
