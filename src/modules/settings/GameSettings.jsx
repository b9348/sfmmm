import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  CardHeader,
  Text,
  Title2,
  Button,
  Input,
  Spinner,
  Select,
  ProgressBar,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  ArrowSync24Regular,
  ArrowDownload24Regular,
  Link24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { getConfig, setConfig } from '../../services/dbHelper'
import { Acknowledgments } from './Acknowledgments'
import i18n from '../../i18n'
import { checkVersion, prepareUpdate, applyUpdate, getUpdateStatus, compareVersions } from '../../services/updateApi'
import APP_VERSION from '../../version.js'

const useStyles = makeStyles({
  formGrid: {
    display: 'grid',
    gridTemplateColumns: '100px 1fr',
    gap: '6px 12px',
    alignItems: 'center',
  },
  formLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  updateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '4px 0',
  },
  updateInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  currentTag: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '2px 8px',
    borderRadius: '4px',
  },
  newTag: {
    fontSize: '12px',
    fontWeight: '600',
    color: tokens.colorPaletteRedForeground1,
    backgroundColor: tokens.colorPaletteRedBackground1,
    padding: '2px 8px',
    borderRadius: '4px',
  },
  noUpdate: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
})

export function GameSettings({ config, onConfigChange, appUpdateInfo }) {
  const { t, i18n: i18nInstance } = useTranslation()
  const styles = useStyles()
  const [gamePath, setGamePath] = useState(config?.game_path || '')
  const [language, setLanguage] = useState(config?.language || i18nInstance.language || 'zh')
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [downloadStage, setDownloadStage] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const [prepared, setPrepared] = useState(false)
  const [pendingUpdate, setPendingUpdate] = useState(false)
  const [updateInfo, setUpdateInfo] = useState(null)
  // 当前后台下载任务 id：进度事件按 taskId 匹配（与订阅下载同模式）
  const taskIdRef = useRef(null)

  const browseGameFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t('settings.selectDialogTitle'),
    })
    if (selected) {
      setGamePath(selected)
      await saveConfig({ game_path: selected })
    }
  }

  const openGameFolder = async () => {
    if (gamePath) {
      await invoke('open_folder', { path: gamePath })
    }
  }

  const saveConfig = async (updates) => {
    try {
      for (const [key, value] of Object.entries(updates)) {
        await setConfig(key, value)
      }
      onConfigChange?.(updates)
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }

  // Load pending update flag on mount
  useEffect(() => {
    (async () => {
      try {
        const value = await getConfig('pending_update')
        if (value === 'true') {
          setPendingUpdate(true)
        }
      } catch (e) {
        console.warn('[Update] 读取待更新状态失败:', e)
      }
    })()
  }, [])

  // 复用 App 启动时检测的结果（与侧边栏 NEW 徽标同一数据源），打开设置页无需再手动点击检测
  useEffect(() => {
    if (appUpdateInfo) {
      setUpdateInfo(appUpdateInfo)
    }
  }, [appUpdateInfo])

  // 离开设置页后更新下载仍由 Rust 后台任务执行（与订阅下载同模式）：
  // 挂载时查询持久化状态恢复 UI；下载期间监听全局 "update-progress" 事件刷新进度。
  // 恢复以 DB 为准（同订阅记录页 refresh() 语义）：只要任务状态是 ready 就切
  // "重启并更新"，不依赖 pending_update 等前端杂项标志——该标志只负责"下次启动
  // 自动应用"，由 App.jsx 启动流程消费，二者互不干扰。
  useEffect(() => {
    let cancelled = false
    let unlistenFn = null

    const restore = async () => {
      try {
        const st = await getUpdateStatus()
        if (cancelled || !st) return
        if (st.status === 'downloading' || st.status === 'pending') {
          setDownloading(true)
          setDownloadProgress(st.percent ?? 0)
          setDownloadStage('downloading')
        } else if (st.status === 'ready') {
          setPrepared(true)
        } else if (st.status === 'failed') {
          setDownloadError(st.error || t('settings.downloadFailed'))
        }
      } catch (e) {
        console.warn('[Update] 恢复下载状态失败:', e)
      }
    }
    restore()

    listen('update-progress', (ev) => {
      const payload = ev.payload || {}
      const tid = payload.taskId
      // 事件对应的任务不是当前已知任务（换新任务/恢复的历史任务）：先重查 DB 同步，
      // 再按事件增量更新（订阅记录页"事件任务不在列表 → refresh()"同款策略）
      if (taskIdRef.current !== null && tid !== taskIdRef.current) {
        restore()
        return
      }
      if (payload.status === 'ready') {
        setDownloading(false)
        setDownloadProgress(100)
        setDownloadStage('')
        setDownloadError('')
        setPrepared(true)
        setPendingUpdate(false)
        saveConfig({ pending_update: 'false' })
      } else if (payload.status === 'failed') {
        setDownloading(false)
        setDownloadStage('')
        setDownloadError(payload.error || t('settings.downloadFailed'))
      } else {
        setDownloadProgress(payload.percent ?? 0)
        setDownloadStage(payload.stage || 'downloading')
      }
    }).then(fn => { unlistenFn = fn }).catch(e => console.warn('[Update] 监听进度事件失败:', e))

    return () => {
      cancelled = true
      unlistenFn?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 已就绪的下载任务可能是旧版本残留（已安装过同版本/更新成功后的遗留）：
  // 恢复 ready 状态时与服务器最新版本比对，最新版并未比当前版本新则视为过期残留，
  // 调用 db_clear_update 清理任务与安装包，避免版本号一致时仍一直提示"立即重启并更新"
  useEffect(() => {
    let cancelled = false
    const validate = async () => {
      const st = await getUpdateStatus()
      if (cancelled || !st || st.status !== 'ready') return
      const latest = updateInfo?.latestVersion
      // 最新版本未知（启动检测未返回/服务器不可达）时保守保留，等 updateInfo 到达后重跑
      if (!latest) return
      // 确实存在更新的版本：保留"立即重启并更新"
      if (compareVersions(latest, APP_VERSION) > 0) return
      // 过期残留：清理并退出"重启并更新"状态
      try {
        await invoke('db_clear_update')
      } catch (e) {
        console.warn('[Update] 清理过期更新任务失败:', e)
        return
      }
      if (cancelled) return
      setPrepared(false)
      setPendingUpdate(false)
      saveConfig({ pending_update: 'false' })
    }
    validate()
    return () => { cancelled = true }
    // updateInfo 依赖：App 启动检测结果异步到达后重跑，避免挂载时最新版尚未就绪而漏判
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateInfo])

  const handleCheckUpdate = async () => {
    setChecking(true)
    setUpdateInfo(null)
    setPrepared(false)
    setDownloadError('')
    try {
      const info = await checkVersion(APP_VERSION)
      setUpdateInfo(info)
    } catch (e) {
      console.error('[Update] 检测失败:', e)
      setUpdateInfo({ hasUpdate: false, error: e.message })
    } finally {
      setChecking(false)
    }
  }

  const handleDownloadUpdate = async () => {
    if (!updateInfo?.updateUrl || downloading) return
    setDownloading(true)
    setDownloadProgress(0)
    setDownloadStage('downloading')
    setDownloadError('')
    try {
      // 创建后台下载任务后立即返回；下载在 Rust 执行，进度由 update-progress 事件回传，
      // 离开设置页也不中断，重进页面通过 getUpdateStatus() 恢复
      const res = await prepareUpdate(updateInfo.updateUrl)
      taskIdRef.current = res?.taskId ?? null
    } catch (e) {
      console.error('[Update] 创建下载任务失败:', e)
      setDownloading(false)
      setDownloadStage('')
      setDownloadError(e.message || t('settings.downloadFailed'))
    }
  }

  const handleApplyUpdate = async () => {
    try {
      await applyUpdate()
    } catch (e) {
      console.error('[Update] 启动更新失败:', e)
      setUpdateInfo(prev => ({ ...prev, error: e.message }))
    }
  }

  const handleLater = async () => {
    try {
      await saveConfig({ pending_update: 'true' })
      setPendingUpdate(true)
      setPrepared(false)
    } catch (e) {
      console.error('[Update] 保存待更新状态失败:', e)
    }
  }

  const languageOptions = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
      <Card appearance="outline">
        <CardHeader header={<Title2>{t('settings.language')}</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>{t('settings.language')}</Text>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <Select value={language} onChange={(e) => {
                const newLang = e.target.value
                setLanguage(newLang)
                i18n.changeLanguage(newLang)
                saveConfig({ language: newLang })
              }} style={{ flex: 1 }}>
                {languageOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </Select>
            </div>
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            {t('settings.languageDesc')}
          </Text>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>{t('settings.gamePath')}</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>{t('settings.gameDir')}</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input
                size="small"
                value={gamePath}
                placeholder={t('settings.selectGameDir')}
                style={{ flex: 1 }}
              />
              <Button size="small" icon={<Folder24Regular />} onClick={browseGameFolder}>{t('settings.change')}</Button>
              <Button size="small" icon={<Folder24Regular />} onClick={openGameFolder}>{t('settings.openGameDir')}</Button>
            </div>
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
          {t('settings.changeHint')}
          </Text>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>{t('settings.updateTitle')}</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.updateRow}>
            <Button
              size="small"
              icon={checking ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
              onClick={handleCheckUpdate}
              disabled={checking}
            >
{checking ? t('settings.checking') : t('settings.checkUpdateBtn')}
            </Button>
            <div className={styles.updateInfo}>
              {prepared ? (
                <>
                  <span className={styles.currentTag}>v{APP_VERSION}</span>
                  <Text>→</Text>
                  <span className={styles.newTag}>v{updateInfo?.latestVersion}</span>
                  <Button
                    size="small"
                    appearance="primary"
                    icon={<ArrowDownload24Regular />}
                    onClick={handleApplyUpdate}
                  >
                    {t('settings.restartAndUpdate')}
                  </Button>
                  <Button size="small" onClick={handleLater}>
                    {t('settings.updateLater')}
                  </Button>
                </>
              ) : updateInfo?.hasUpdate ? (
                <>
                  <span className={styles.currentTag}>v{APP_VERSION}</span>
                  <Text>→</Text>
                  <span className={styles.newTag}>v{updateInfo.latestVersion}</span>
                  {downloadError && (
                    <Text size="small" className={styles.noUpdate}>{downloadError}</Text>
                  )}
                  <Button
                    size="small"
                    appearance="primary"
                    icon={downloading ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
                    onClick={handleDownloadUpdate}
                    disabled={downloading}
                  >
                    {downloading ? t('settings.downloadingUpdate') : t('settings.downloadUpdate')}
                  </Button>
                </>
              ) : pendingUpdate ? (
                <Text className={styles.noUpdate}>{t('settings.updateOnNextStart')}</Text>
              ) : updateInfo?.error ? (
                <Text className={styles.noUpdate}>{t('settings.checkFailed', { msg: updateInfo.error })}</Text>
              ) : updateInfo ? (
                <span className={styles.noUpdate}>{t('settings.alreadyLatest')}</span>
              ) : null}
            </div>
            {downloading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' }}>
                <ProgressBar value={downloadProgress / 100} />
                <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
                  {downloadStage === 'downloading' && t('settings.downloadingUpdate') + ` ${downloadProgress}%`}
                </Text>
              </div>
            )}
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            {t('settings.currentVersion', { version: APP_VERSION })}
          </Text>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>{t('settings.aboutTitle')}</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Text size="small">{t('settings.aboutDesc')}</Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <Button
              size="small"
              icon={<Link24Regular />}
              onClick={() => openUrl('https://github.com/b9348/sfmmm')}
            >
              {t('settings.openGitHub')}
            </Button>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            https://github.com/b9348/sfmmm
          </Text>
          </div>
        </div>
      </Card>

      <div style={{ gridColumn: '1 / -1' }}>
        <Acknowledgments />
      </div>
    </div>
  )
}
