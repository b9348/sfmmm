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
  Globe24Regular,
  Delete24Regular,
  Dismiss24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { getConfig, setConfig } from '../../services/dbHelper'
import { usePlatform } from '../../hooks/usePlatform'
import { Acknowledgments } from './Acknowledgments'
import i18n from '../../i18n'
import { checkVersion, checkGitHubUpdate, prepareUpdate, applyUpdate, getUpdateStatus, compareVersions, armPendingUpdate, cancelUpdate } from '../../services/updateApi'
import APP_VERSION from '../../version.js'
import { formatSpeed, formatBytes } from '../../utils/formatSpeed'

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
  const { isMobile } = usePlatform()
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
  // GitHub 下载渠道解析直链中（检测已确认发布，无需再检测版本）
  const [ghResolving, setGhResolving] = useState(false)
  // 实时下载速度（字节/秒），来自 update-progress 事件
  const [downloadSpeed, setDownloadSpeed] = useState(0)
  // 已下载/总大小（字节），来自 update-progress 事件，用于"已下载 X / Y"展示（与 BepInEx 前置同款）
  const [downloadedBytes, setDownloadedBytes] = useState(0)
  const [totalBytes, setTotalBytes] = useState(0)
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
  // "重启并更新"。pending_update 由 App.jsx 全局监听在 ready 时自动写入，负责
  // "下次启动自动应用"，二者互不干扰。
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
          setDownloadedBytes(st.downloaded ?? 0)
          setTotalBytes(st.total ?? 0)
          setDownloadStage('downloading')
        } else if (st.status === 'ready') {
          setPrepared(true)
        } else if (st.status === 'failed') {
          setDownloadError(st.error || t('settings.downloadFailedGeneric'))
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
        setDownloadSpeed(0)
        setPrepared(true)
        // 复用共享提升门禁（armPendingUpdate：版本 + 安装包在盘校验 + 写
        // pending_update + 清退避），与 App.jsx 全局监听行为一致：仅当记录版本
        // === 当前最新版才安排下次启动自动应用，陈旧下载不自动武装（防下次启动
        // 被版本门禁判废后整包重下）；"稍后"按钮语义不变
        armPendingUpdate(updateInfo?.latestVersion || '').then((armed) => {
          if (armed) {
            setPendingUpdate(true)
            saveConfig({ pending_update: 'true' })
          }
        }).catch((e) => console.warn('[Update] 提升待应用失败:', e))
      } else if (payload.status === 'failed') {
        setDownloading(false)
        setDownloadStage('')
        setDownloadSpeed(0)
        setDownloadedBytes(0)
        setTotalBytes(0)
        setDownloadError(payload.error || t('settings.downloadFailedGeneric'))
      } else if (payload.status === 'cancelled') {
        // 取消：复位 UI（taskIdRef 已在 handleCancelDownload 清除，此处兜底防止
        // 被动收到 cancelled 事件时状态残留），不当作失败显示错误
        taskIdRef.current = null
        setDownloading(false)
        setDownloadStage('')
        setDownloadProgress(0)
        setDownloadedBytes(0)
        setTotalBytes(0)
        setDownloadSpeed(0)
      } else {
        setDownloadProgress(payload.percent ?? 0)
        setDownloadStage(payload.stage || 'downloading')
        setDownloadSpeed(payload.speed ?? 0)
        setDownloadedBytes(payload.downloaded ?? 0)
        setTotalBytes(payload.total ?? 0)
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
    // 用户手动检测 = 显式解除自动更新失败退避（fire-and-forget：写失败只告警，
    // 不能把一次成功的版本检测误报为"检测失败"并隐藏更新入口）
    setConfig('auto_update_fail_at', '').catch((e) => {
      console.warn('[Update] 清除失败退避失败:', e)
    })
  }

  const handleDownloadUpdate = async () => {
    if (!updateInfo?.updateUrl || downloading) return
    setDownloading(true)
    setDownloadProgress(0)
    setDownloadStage('downloading')
    setDownloadError('')
    setDownloadedBytes(0)
    setTotalBytes(0)
    try {
      // 创建后台下载任务后立即返回；下载在 Rust 执行，进度由 update-progress 事件回传，
      // 离开设置页也不中断，重进页面通过 getUpdateStatus() 恢复
      const res = await prepareUpdate(updateInfo.updateUrl, updateInfo.latestVersion, 8)
      taskIdRef.current = res?.taskId ?? null
    } catch (e) {
      console.error('[Update] 创建下载任务失败:', e)
      setDownloading(false)
      setDownloadStage('')
      setDownloadError(e.message || t('settings.downloadFailedGeneric'))
    }
  }

  // 取消进行中的更新下载：置位取消标志让 Rust 下载引擎子任务停止并删半成品安装包，
  // 同时 abort 句柄、写 cancelled 状态。事件监听收到 cancelled 后复位 UI（与订阅取消同款）。
  const handleCancelDownload = async () => {
    const tid = taskIdRef.current
    if (tid === null) return
    try {
      await cancelUpdate(tid)
    } catch (e) {
      console.warn('[Update] 取消下载失败:', e)
      // 取消失败仍复位 UI，避免按钮卡死；真实任务状态由 getUpdateStatus 恢复
    }
    taskIdRef.current = null
    setDownloading(false)
    setDownloadStage('')
    setDownloadProgress(0)
    setDownloadedBytes(0)
    setTotalBytes(0)
    setDownloadSpeed(0)
  }

  // GitHub Releases 下载渠道：检测已确认发布完成，拉取直链后直接发起下载
  const handleGhDownloadUpdate = async () => {
    if (!updateInfo?.latestVersion || downloading || ghResolving) return
    setGhResolving(true)
    setDownloadError('')
    try {
      const data = await checkGitHubUpdate()
      // 校验 GitHub 直链版本与检测到的最新版一致（CI 发布完成后两者应相同）
      if (!data.updateUrl) {
        throw new Error(t('settings.ghNoAsset'))
      }
      if (data.version !== updateInfo.latestVersion) {
        throw new Error(t('settings.ghNotReady', { version: updateInfo.latestVersion }))
      }
      setDownloading(true)
      setDownloadProgress(0)
      setDownloadStage('downloading')
      const res = await prepareUpdate(data.updateUrl, data.version, 8)
      taskIdRef.current = res?.taskId ?? null
    } catch (e) {
      console.error('[Update] GitHub 下载失败:', e)
      setDownloadError(e.message || t('settings.downloadFailedGeneric'))
    } finally {
      setGhResolving(false)
    }
  }

  const handleApplyUpdate = async () => {
    try {
      // 手动立即应用时同步消费 pending_update：避免安装完成后下次启动
      // 又对已删除的安装包重复执行 applyUpdate（与 App 启动自动应用同语义）
      await saveConfig({ pending_update: 'false' })
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

  // 开发环境专用：清理已就绪的安装包与任务记录，重置回可再次选择下载源的状态
  const handleClearAndReset = async () => {
    try {
      await invoke('db_clear_update')
      setPrepared(false)
      setPendingUpdate(false)
      setDownloadProgress(0)
      setDownloadStage('')
      setDownloadError('')
      saveConfig({ pending_update: 'false' })
    } catch (e) {
      console.warn('[Update] 清理更新任务失败:', e)
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

      {!isMobile && (
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
      )}

      {!isMobile && (
      <Card appearance="outline">
        <CardHeader header={<Title2>{t('settings.updateTitle')}</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.updateRow}>
            {/* 主按钮三态：检测中(转圈禁用) / 下载中(改为可点击的"取消下载") / 空闲(检测更新)。
                下载中不再 disabled：点击即取消后台下载（与 BepInEx 前置"安装中"可取消同语义），
                取消后复位回空闲态可重新选源/检测。ghResolving(解析 GitHub 直链)期间仍禁用。 */}
            <Button
              size="small"
              icon={checking || ghResolving ? <Spinner size="tiny" /> : downloading ? <Dismiss24Regular /> : <ArrowSync24Regular />}
              onClick={downloading ? handleCancelDownload : handleCheckUpdate}
              disabled={checking || ghResolving}
            >
              {checking
                ? t('settings.checking')
                : downloading
                  ? t('settings.cancelDownload')
                  : ghResolving
                    ? t('settings.downloadingUpdate')
                    : t('settings.checkUpdateBtn')}
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
                  {/* 开发环境专用：清理安装包并重置更新状态，便于连续测试不同下载源 */}
                  {import.meta.env.DEV && (
                    <Button
                      size="small"
                      icon={<Delete24Regular />}
                      onClick={handleClearAndReset}
                    >
                      {t('settings.clearAndReset')}
                    </Button>
                  )}
                </>
              ) : updateInfo?.hasUpdate ? (
                <>
                  <span className={styles.currentTag}>v{APP_VERSION}</span>
                  <Text>→</Text>
                  <span className={styles.newTag}>v{updateInfo.latestVersion}</span>
                  {/* 两个下载渠道：默认图床源 / GitHub Release 源（检测已确认发布，只需选源下载）。
                      对等并列，样式保持一致，仅以图标区分来源，避免暗示优先级。
                      下载/解析中统一由「检测更新」按钮转圈，此处保持静态仅禁用 */}
                  <Button
                    size="small"
                    icon={<ArrowDownload24Regular />}
                    onClick={handleDownloadUpdate}
                    disabled={downloading || ghResolving}
                  >
                    {t('settings.downloadUpdate')}
                  </Button>
                  <Button
                    size="small"
                    icon={<Globe24Regular />}
                    onClick={handleGhDownloadUpdate}
                    disabled={downloading || ghResolving}
                  >
                    {t('settings.ghDownloadUpdate')}
                  </Button>
                  {/* 第三下载源：夸克网盘（浏览器打开分享链接，由用户自行下载安装包） */}
                  <Button
                    size="small"
                    icon={<Link24Regular />}
                    onClick={() => openUrl('https://pan.quark.cn/s/6717bb155e47')}
                    disabled={downloading || ghResolving}
                  >
                    {t('settings.quarkDownload')}
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
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            {t('settings.currentVersion', { version: APP_VERSION })}
          </Text>
          {/* 下载进度与网络报错：独立换行显示在版本文案下方，避免抢占更新按钮行空间 */}
          {(downloading || downloadError) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {downloading && (
                <>
                  <ProgressBar value={downloadProgress / 100} />
                  <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
                    {downloadStage === 'downloading' && (
                      <>
                        {t('settings.downloadingUpdate')} {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}（{downloadProgress}%）
                        {downloadSpeed > 0 ? ` · ${formatSpeed(downloadSpeed)}` : ''}
                      </>
                    )}
                  </Text>
                </>
              )}
              {downloadError && (
                <Text size="small" className={styles.noUpdate}>{downloadError}</Text>
              )}
            </div>
          )}
        </div>
      </Card>
      )}

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
