import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Divider,
  Text,
  Button,
  Input,
  Spinner,
  Select,
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
import { getCdnStatus, setCdnMode } from '../../services/cdnApi'
import { getLineStatus, setLineMode, probeLine, normalizeLineStatus } from '../../services/lineApi'
import { hasNonAsciiPath } from '../../services/pathCheck'
import { Acknowledgments } from './Acknowledgments'
import i18n from '../../i18n'
import { checkVersion, checkGitHubUpdate, prepareUpdate, applyUpdate, getUpdateStatus, compareVersions, armPendingUpdate, cancelUpdate } from '../../services/updateApi'
import APP_VERSION from '../../version.js'
import { DownloadProgress } from '../../components'
import { usePlatform } from '../../hooks/usePlatform'

// 外部链接由构建期环境变量提供（根 .env），未配置时对应入口不渲染
const QUARK_URL = import.meta.env.VITE_QUARK_URL || ''
const GITHUB_REPO = import.meta.env.VITE_GITHUB_REPO || ''

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '24px',
    padding: '14px 4px',
    // 窄窗口（≈移动端宽度）适配：240px 固定标签列与控件列并排时，控件会被挤到
    // 溢出页面（出现整页横向滚动），改为标签在上、控件在下的堆叠布局
    '@media (max-width: 768px)': {
      flexDirection: 'column',
      gap: '8px',
      padding: '12px 4px',
    },
  },
  itemLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    width: '240px',
    flexShrink: 0,
    '@media (max-width: 768px)': {
      // 堆叠后标签列不再需要固定宽度占位，交给整行
      width: 'auto',
    },
  },
  itemTitle: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
  },
  itemDesc: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
  },
  itemControl: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  itemControlStack: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  updateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '4px 0',
    // 版本标签 + 下载源按钮一行放不下时换行（窄窗口下尤其明显）
    flexWrap: 'wrap',
  },
  updateInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
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
  // 手机端隐藏「游戏目录」和「程序更新」两类桌面独占设置：
  // 前者要读写本地游戏目录，后者是 PC 安装包自更新（APK 更新不走这条链）
  const { isMobile } = usePlatform()
  const [gamePath, setGamePath] = useState(config?.game_path || '')
  // 游戏路径含中文等非 ASCII 字符时的红字提示（BepInEx 无法在中文路径下工作）
  const [pathError, setPathError] = useState('')
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
  // 已就绪安装包的目标版本（来自 update_tasks.version，缺失时回退最新检测结果）。
  // 单独存一份而不是只读 updateInfo.latestVersion：启动检测失败时后者为 null，
  // "重启并更新"行会渲染成 "v0.2.67 → v"（箭头右侧空白）。
  const [preparedVersion, setPreparedVersion] = useState('')
  // 进度监听只在挂载时注册一次，闭包里的 updateInfo 永远是挂载瞬间的值（通常是
  // null）；用 ref 提供"当前最新版"，供 ready 分支的提升门禁使用
  const latestVersionRef = useRef('')

  const browseGameFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t('settings.selectDialogTitle'),
    })
    if (selected) {
      // 中文路径会被 BepInEx 前置拒绝，直接拦下不落库
      if (await hasNonAsciiPath(selected)) {
        setPathError(t('settings.errNonAsciiPath'))
        return
      }
      setPathError('')
      setGamePath(selected)
      await saveConfig({ game_path: selected })
    }
  }

  const openGameFolder = async () => {
    if (gamePath) {
      await invoke('open_folder', { path: gamePath })
    }
  }

  // 手输路径：失焦/回车时落库（与选择目录按钮同一存储键），去首尾空白。
  // 与已存值相同则不写库，避免无意义频繁写 config.db。
  const commitGamePath = async () => {
    const next = (gamePath || '').trim()
    // 手输同样拦截中文路径：回退到已保存值并红字说明，避免输入框显示的值与库里不一致
    if (next && await hasNonAsciiPath(next)) {
      setPathError(t('settings.errNonAsciiPath'))
      setGamePath(config?.game_path || '')
      return
    }
    setPathError('')
    setGamePath(next)
    if (next === (config?.game_path || '')) return
    await saveConfig({ game_path: next })
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

  // 同步最新版本到 ref，供只注册一次的进度监听使用（见 latestVersionRef 声明处）
  useEffect(() => {
    latestVersionRef.current = updateInfo?.latestVersion || ''
  }, [updateInfo])

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
          // 恢复任务 id：否则重进页面后「取消下载」拿不到 taskId 直接 return，
          // 进度能显示却取消不了（刷新/离开页面再回来就是这个表现）
          taskIdRef.current = st.id ?? null
          setDownloading(true)
          setDownloadProgress(st.percent ?? 0)
          setDownloadedBytes(st.downloaded ?? 0)
          setTotalBytes(st.total ?? 0)
          setDownloadStage('downloading')
        } else if (st.status === 'ready') {
          // 只有在「安装包确实在盘上」且「任务版本比当前运行版本新」时才恢复
          // "重启并更新"。更新成功后残留的 ready 行（安装包已被静默安装脚本删除、
          // 版本等于当前版本）否则会在每次打开设置页时恢复出上次的可用更新状态，
          // 按钮点下去还会报"未找到更新安装包"。
          // 失效行的删除统一由下方 validate 负责（同一份判定逻辑，避免两处重复清理）。
          if (st.installerExists && (!st.version || compareVersions(st.version, APP_VERSION) > 0)) {
            setPreparedVersion(st.version || '')
            setPrepared(true)
          }
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
        // 展示的版本以任务记录为准（事件 payload 不含版本），取不到时回退最新检测结果。
        // Rust 端先写库再广播事件，此处查询一定能读到 ready 行的 version。
        getUpdateStatus()
          .then((st) => setPreparedVersion(st?.version || latestVersionRef.current))
          .catch(() => setPreparedVersion(latestVersionRef.current))
        // 复用共享提升门禁（armPendingUpdate：版本 + 安装包在盘校验 + 写
        // pending_update + 清退避），与 App.jsx 全局监听行为一致：仅当记录版本
        // === 当前最新版才安排下次启动自动应用，陈旧下载不自动武装（防下次启动
        // 被版本门禁判废后整包重下）；"稍后"按钮语义不变
        // 注意用 ref 而非闭包里的 updateInfo：监听只注册一次，闭包恒为挂载值（null），
        // 直接读会让版本门禁永远拿空串、静默更新无法武装
        armPendingUpdate(latestVersionRef.current).then((armed) => {
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
      // 优先用任务自身记录的版本判断，不依赖启动检测是否成功：任务版本不高于
      // 当前运行版本即为过期残留（典型场景：更新已装成功，安装包被脚本删掉但
      // ready 行还在）。任务版本未知（migration 16 遗留行）时才回退到服务器最新版。
      const target = st.version || updateInfo?.latestVersion
      // 版本未知（启动检测未返回/服务器不可达）时保守保留，等 updateInfo 到达后重跑
      if (!target) return
      // 确实存在更新的版本：保留"立即重启并更新"
      if (compareVersions(target, APP_VERSION) > 0) return
      // 过期残留：清理并退出"重启并更新"状态
      try {
        await invoke('db_clear_update')
      } catch (e) {
        console.warn('[Update] 清理过期更新任务失败:', e)
        return
      }
      if (cancelled) return
      setPreparedVersion('')
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
    setPreparedVersion('')
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
      const res = await prepareUpdate(updateInfo.updateUrl, updateInfo.latestVersion)
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
      const res = await prepareUpdate(data.updateUrl, data.version)
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
      setPreparedVersion('')
      setPrepared(false)
    } catch (e) {
      console.error('[Update] 保存待更新状态失败:', e)
    }
  }

  // 开发环境专用：清理已就绪的安装包与任务记录，重置回可再次选择下载源的状态
  const handleClearAndReset = async () => {
    try {
      await invoke('db_clear_update')
      setPreparedVersion('')
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

  // 资源加速线路：'auto'（测速更快）/ 'mirror'（CDN 加速）/ 'primary'（原始线路）。
  // 显示值来自启动时 initCdnMode 已拉取的 Rust 生效状态（含测速结论）；
  // 切换由 cdnApi.setCdnMode 落库 config.db 并即时应用，失败回滚 UI。
  const [cdnMode, setCdnModeState] = useState('auto')
  useEffect(() => {
    getCdnStatus().then((s) => {
      if (s?.mode) setCdnModeState(s.mode)
    }).catch(() => {})
  }, [])
  const handleCdnModeChange = async (mode) => {
    const prev = cdnMode
    setCdnModeState(mode)
    try {
      await setCdnMode(mode)
    } catch (e) {
      console.error('Failed to switch cdn mode:', e)
      setCdnModeState(prev)
    }
  }
  const cdnModeOptions = [
    { value: 'auto', label: t('settings.cdnModeAuto') },
    { value: 'line2', label: t('settings.cdnModeLine2') },
    { value: 'line3', label: t('settings.cdnModeLine3') },
    { value: 'primary', label: t('settings.cdnModePrimary') },
  ]

  // 数据库线路：'auto'（探测可达则经香港中继）/ 'direct'（强制直连云库）/ 'relay'（强制中继）。
  // 生效线路由 Rust 端决定（探测结论 + 冷却 + 用户偏好），前端只展示不推断：
  // 切换偏好后新线路在下次建池时生效，不会打断正在执行的查询。
  const [lineStatus, setLineStatus] = useState(normalizeLineStatus(null))
  const [lineBusy, setLineBusy] = useState(false)
  useEffect(() => {
    getLineStatus().then((s) => setLineStatus(normalizeLineStatus(s))).catch(() => {})
  }, [])
  const handleLineModeChange = async (mode) => {
    const prev = lineStatus.mode
    setLineBusy(true)
    setLineStatus((s) => ({ ...s, mode }))
    try {
      setLineStatus(normalizeLineStatus(await setLineMode(mode)))
    } catch (e) {
      console.error('Failed to switch db line:', e)
      setLineStatus((s) => ({ ...s, mode: prev }))
    } finally {
      setLineBusy(false)
    }
  }
  const handleLineProbe = async () => {
    setLineBusy(true)
    try {
      setLineStatus(normalizeLineStatus(await probeLine()))
    } catch (e) {
      console.error('Failed to probe db line:', e)
    } finally {
      // 探测失败时也重新拉一次状态：后端可能已记录冷却/降级原因
      getLineStatus().then((s) => setLineStatus(normalizeLineStatus(s))).catch(() => {})
      setLineBusy(false)
    }
  }
  const lineModeOptions = [
    { value: 'auto', label: t('settings.dbLineAuto') },
    { value: 'direct', label: t('settings.dbLineDirect') },
    { value: 'relay', label: t('settings.dbLineRelay') },
  ]
  // 生效线路文案：中继带延迟，直连不带（直连是默认能力，数字反而像告警）
  const lineEffectiveText = lineStatus.effective === 'relay'
    ? t('settings.dbLineEffectiveRelay', {
      latency: lineStatus.relayLatencyMs == null ? '-' : lineStatus.relayLatencyMs,
    })
    : t('settings.dbLineEffectiveDirect')
  const lineProbeText = lineStatus.relayAvailable === null
    ? t('settings.dbLineProbeUnknown')
    : lineStatus.relayAvailable
      ? t('settings.dbLineProbeOk')
      : t('settings.dbLineProbeFail')

  return (
    <div className={styles.page}>
      <div className={styles.item}>
        <div className={styles.itemLabel}>
          <Text className={styles.itemTitle}>{t('settings.language')}</Text>
          <Text className={styles.itemDesc}>{t('settings.languageDesc')}</Text>
        </div>
        <div className={styles.itemControl}>
          <Select value={language} onChange={(e) => {
            const newLang = e.target.value
            setLanguage(newLang)
            i18n.changeLanguage(newLang)
            saveConfig({ language: newLang })
          }} style={{ width: '200px' }}>
            {languageOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
        </div>
      </div>

      <Divider />

      <div className={styles.item}>
        <div className={styles.itemLabel}>
          <Text className={styles.itemTitle}>{t('settings.cdnMode')}</Text>
          <Text className={styles.itemDesc}>{t('settings.cdnModeDesc')}</Text>
        </div>
        <div className={styles.itemControl}>
          <Select value={cdnMode} onChange={(e) => handleCdnModeChange(e.target.value)} style={{ width: '200px' }}>
            {cdnModeOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
        </div>
      </div>

      <Divider />

      {lineStatus.relayConfigured && (
        <>
          <div className={styles.item}>
            <div className={styles.itemLabel}>
              <Text className={styles.itemTitle}>{t('settings.dbLine')}</Text>
              <Text className={styles.itemDesc}>{t('settings.dbLineDesc')}</Text>
            </div>
            <div className={styles.itemControl}>
              <Select value={lineStatus.mode} disabled={lineBusy} onChange={(e) => handleLineModeChange(e.target.value)} style={{ width: '200px' }}>
                {lineModeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </Select>
            </div>
          </div>

          <div className={styles.item}>
            <div className={styles.itemLabel}>
              <Text className={styles.itemTitle}>{t('settings.dbLineCurrent')}</Text>
              <Text className={styles.itemDesc}>
                {lineEffectiveText}
                {' · '}
                {lineProbeText}
                {lineStatus.relayCoolingDown ? ` · ${t('settings.dbLineCoolingDown')}` : ''}
              </Text>
            </div>
            <div className={styles.itemControl}>
              <Button
                appearance="secondary"
                icon={<ArrowSync24Regular />}
                disabled={lineBusy}
                onClick={handleLineProbe}
              >
                {lineBusy ? t('settings.dbLineProbing') : t('settings.dbLineReprobe')}
              </Button>
            </div>
          </div>

          <Divider />
        </>
      )}

      {/* 桌面独占：游戏目录 + 程序自更新。手机端没有本地游戏目录，也没有 PC 安装包更新管线 */}
      {!isMobile && (<>
      <div className={styles.item}>
        <div className={styles.itemLabel}>
          <Text className={styles.itemTitle}>{t('settings.gamePath')}</Text>
          <Text className={styles.itemDesc}>{t('settings.changeHint')}</Text>
        </div>
        <div className={styles.itemControlStack}>
          {/* 保留换行：窗口收窄时两个按钮会挤到下一行（原 itemControl 有 flexWrap） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' }}>
            <Input
              size="small"
              value={gamePath}
              placeholder={t('settings.selectGameDir')}
              style={{ flex: 1, minWidth: '200px' }}
              onChange={(_, data) => {
                setGamePath(data.value)
                setPathError('')
              }}
              onBlur={commitGamePath}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <Button size="small" icon={<Folder24Regular />} onClick={browseGameFolder}>{t('settings.change')}</Button>
            <Button size="small" icon={<Folder24Regular />} onClick={openGameFolder}>{t('settings.openGameDir')}</Button>
          </div>
          {pathError && (
            <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>
              {pathError}
            </Text>
          )}
        </div>
      </div>

      <Divider />

      <div className={styles.item}>
        <div className={styles.itemLabel}>
          <Text className={styles.itemTitle}>{t('settings.updateTitle')}</Text>
          <Text className={styles.itemDesc}>{t('settings.currentVersion', { version: APP_VERSION })}</Text>
        </div>
        <div className={styles.itemControlStack}>
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
                  <span className={styles.newTag}>v{preparedVersion || updateInfo?.latestVersion}</span>
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
                  {/* 第三下载源：夸克网盘（浏览器打开分享链接，由用户自行下载安装包）。
                      分享链接由 VITE_QUARK_URL 提供，未配置时不显示该入口 */}
                  {QUARK_URL && (
                    <Button
                      size="small"
                      icon={<Link24Regular />}
                      onClick={() => openUrl(QUARK_URL)}
                      disabled={downloading || ghResolving}
                    >
                      {t('settings.quarkDownload')}
                    </Button>
                  )}
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
          {/* 下载进度与网络报错：换行显示在更新按钮行下方 */}
          {(downloading || downloadError) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {downloading && (
                <DownloadProgress
                  label={downloadStage === 'downloading' ? t('settings.downloadingUpdate') : ''}
                  percent={downloadProgress}
                  downloaded={downloadedBytes}
                  total={totalBytes}
                  speed={downloadSpeed}
                />
              )}
              {downloadError && (
                <Text size="small" className={styles.noUpdate}>{downloadError}</Text>
              )}
            </div>
          )}
        </div>
      </div>

      <Divider />
      </>)}

      <div className={styles.item}>
        <div className={styles.itemLabel}>
          <Text className={styles.itemTitle}>{t('settings.aboutTitle')}</Text>
          <Text className={styles.itemDesc}>{t('settings.aboutDesc')}</Text>
        </div>
        <div className={styles.itemControl}>
          {GITHUB_REPO && (
            <>
              <Button
                size="small"
                icon={<Link24Regular />}
                onClick={() => openUrl(`https://github.com/${GITHUB_REPO}`)}
              >
                {t('settings.openGitHub')}
              </Button>
              <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
                https://github.com/{GITHUB_REPO}
              </Text>
            </>
          )}
        </div>
      </div>

      <Divider />

      <div style={{ paddingTop: '12px' }}>
        <Acknowledgments />
      </div>
    </div>
  )
}
