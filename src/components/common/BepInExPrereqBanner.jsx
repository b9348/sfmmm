import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { makeStyles, tokens, Text, Button, Card, Spinner, ProgressBar } from '@fluentui/react-components'
import { ArrowClockwise24Regular, ArrowDownload24Regular, Warning24Regular } from '@fluentui/react-icons'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { stat } from '@tauri-apps/plugin-fs'
import { PREREQ_DOWNLOAD_POINTS, V1_PREREQ_MARKER } from './prereqPoints'

export { PREREQ_DOWNLOAD_POINTS, BEPINEX_URL, V1_PREREQ_URL } from './prereqPoints'

const useStyles = makeStyles({
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

// 前置检测与一键安装共用组件。
// 用于任何以前置作为先决条件的模组/任务页（DLL 模组页、自定义任务 v1/v2 等）：
// - prereqKey='bepinex'：调用 scan_mods 检测 BepInEx 是否已装；
// - prereqKey='v1'：检测游戏根目录 BepInEx/plugins/SFM_custom_mission.dll 是否存在。
// 未装则显示警示 banner 与一键安装按钮（下载点来自 PREREQ_DOWNLOAD_POINTS 枚举，
// 名为"内置下载点"），安装成功后通过 onInstalled 回调通知父级刷新目录。
// category 复用创意工坊详情页的 workshop.category_* 语言键（dll/v1/v2 等）来显示分类名。
//
// 下载改为 Rust 后台任务（db_install_bepinex，与订阅记录同模式）：
// 进度经全局事件 "bepinex-progress" 广播，本页按 taskId 匹配刷新；
// 离开页面/切换标签下载照常执行，回来自动恢复进行中的进度。
export function BepInExPrereqBanner({ gamePath, onInstalled, category = 'dll', prereqKey = 'bepinex' }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const categoryLabel = t(`workshop.category_${category}`, { defaultValue: category })
  const downloadPoint = PREREQ_DOWNLOAD_POINTS[prereqKey]?.[0] || PREREQ_DOWNLOAD_POINTS.bepinex[0]
  const [missing, setMissing] = useState(null) // null=检测中, true=缺, false=已装
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const taskIdRef = useRef(null)

  const check = useCallback(async () => {
    if (!gamePath) return
    try {
      if (prereqKey === 'v1') {
        // v1 前置安装产物：BepInEx/plugins/SFM_custom_mission.dll
        const marker = `${gamePath.replace(/\/+$/, '')}/${V1_PREREQ_MARKER}`
        try {
          await stat(marker)
          setMissing(false)
        } catch {
          setMissing(true)
        }
      } else {
        const res = await invoke('scan_mods', { gamePath })
        setMissing(res.bepinExInstalled !== true)
      }
    } catch (e) {
      setError(String(e))
    }
  }, [gamePath, prereqKey])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (gamePath) check()
  }, [gamePath, check])

  // 全局进度事件：后台任务 emit 广播，本页按 taskId 匹配（与订阅记录页同模式）
  useEffect(() => {
    let unlistenFn = null
    listen('bepinex-progress', (ev) => {
      const payload = ev.payload || {}
      if (taskIdRef.current === null || payload.taskId !== taskIdRef.current) return
      setProgress(payload.percent ?? 0)
      setStage(payload.stage || '')
      if (payload.status === 'done') {
        setInstalling(false)
        setStage('')
        setMissing(false)
        onInstalled?.()
      } else if (payload.status === 'failed' || payload.status === 'cancelled') {
        setInstalling(false)
        setStage('')
        setError(payload.error || String(payload.status))
      }
    })
      .then(fn => { unlistenFn = fn })
      .catch(() => {})
    return () => { if (unlistenFn) unlistenFn() }
  }, [onInstalled])

  // 挂载时恢复进行中的后台任务（离开页面再回来，下载不中断）
  useEffect(() => {
    let cancelled = false
    invoke('db_get_bepinex_task')
      .then((task) => {
        if (cancelled || !task) return
        // 只接管与当前前置下载点匹配的任务，避免 v1 页误接管 BepInEx 安装进度
        if (task.url !== downloadPoint.url) return
        const running = ['pending', 'downloading', 'extracting'].includes(task.status)
        if (running) {
          taskIdRef.current = task.id
          setInstalling(true)
          setProgress(task.percent ?? 0)
          setStage(task.stage || 'downloading')
        } else if (task.status === 'failed') {
          setError(task.error || '')
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [downloadPoint.url])

  const install = useCallback(async () => {
    setInstalling(true)
    setProgress(0)
    setStage('downloading')
    setError('')
    try {
      const result = await invoke('db_install_bepinex', { url: downloadPoint.url })
      // 命中进行中任务时返回 deduplicated=true，同样接管其进度
      taskIdRef.current = result.taskId
    } catch (e) {
      setError(String(e))
      setInstalling(false)
      setStage('')
    }
  }, [downloadPoint.url])

  // 已安装则不渲染
  if (missing === false) return null

  if (missing === null) {
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
        <Button size="small" icon={<ArrowClockwise24Regular />} appearance="subtle" onClick={check} disabled={installing}>{t('mods.reDetect')}</Button>
      </div>
      <Text size="small" className={styles.prereqText}>{t('mods.bepInExHint', { category: categoryLabel })}</Text>
      {error && <Text size="small" className={styles.prereqText} style={{ color: tokens.colorStatusDangerForeground1 }}>{error}</Text>}
      <div className={styles.prereqRow}>
        <Button
          size="small"
          icon={installing ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
          onClick={install}
          disabled={installing}
        >
          {installing ? t('mods.installingBepInEx') : t(downloadPoint.name)}
        </Button>
      </div>
      <Text size="small" className={styles.prereqText}>
        {t('mods.bepInExManualHint1')}
        {' '}
        <a href="https://builds.bepinex.dev/projects/bepinex_be" target="_blank" rel="noopener noreferrer">
          {t('mods.bepInExManualHintLink')}
        </a>
        {t('mods.bepInExManualHint2')}
      </Text>
      {installing && (
        <div className={styles.prereqProgress}>
          <ProgressBar value={progress / 100} />
          <Text size="small" className={styles.prereqText}>
            {stage === 'downloading' && `${t('mods.downloadingBepInEx')} ${progress}%`}
            {stage === 'extracting' && t('mods.extractingBepInEx')}
          </Text>
        </div>
      )}
    </Card>
  )
}
