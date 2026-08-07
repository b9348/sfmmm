import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { makeStyles, tokens, Text, Button, Card, Spinner, ProgressBar } from '@fluentui/react-components'
import { ArrowClockwise24Regular, ArrowDownload24Regular, Warning24Regular } from '@fluentui/react-icons'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// BepInEx 官方分发点（业务 URL：变更时所有引用方同步更新）
export const BEPINEX_URL = 'https://img.b9349.dpdns.org/file/sfm/BepInEx6/BepInEx6.7z'

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

// BepInEx 前置检测与一键安装共用组件。
// 用于任何以 BepInEx 作为前置的模组/任务页（DLL 模组页、自定义任务 v1/v2 等）：
// 挂载时调用 scan_mods 检测 BepInEx 是否已装；未装则显示警示 banner 与一键安装按钮，
// 安装成功后通过 onInstalled 回调通知父级刷新目录。
// category 复用创意工坊详情页的 workshop.category_* 语言键（dll/v1/v2 等）来显示分类名。
//
// 下载改为 Rust 后台任务（db_install_bepinex，与订阅记录同模式）：
// 进度经全局事件 "bepinex-progress" 广播，本页按 taskId 匹配刷新；
// 离开页面/切换标签下载照常执行，回来自动恢复进行中的进度。
export function BepInExPrereqBanner({ gamePath, onInstalled, category = 'dll' }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const categoryLabel = t(`workshop.category_${category}`, { defaultValue: category })
  const [missing, setMissing] = useState(null) // null=检测中, true=缺, false=已装
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const taskIdRef = useRef(null)

  const check = useCallback(async () => {
    if (!gamePath) return
    try {
      const res = await invoke('scan_mods', { gamePath })
      setMissing(res.bepinExInstalled !== true)
    } catch (e) {
      setError(String(e))
    }
  }, [gamePath])

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
  }, [])

  const install = useCallback(async () => {
    setInstalling(true)
    setProgress(0)
    setStage('downloading')
    setError('')
    try {
      const result = await invoke('db_install_bepinex', { url: BEPINEX_URL })
      // 命中进行中任务时返回 deduplicated=true，同样接管其进度
      taskIdRef.current = result.taskId
    } catch (e) {
      setError(String(e))
      setInstalling(false)
      setStage('')
    }
  }, [])

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
          {installing ? t('mods.installingBepInEx') : t('mods.cloudflareDownload')}
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
