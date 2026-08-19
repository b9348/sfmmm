import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { makeStyles, tokens, Text, Button, Card, Spinner, ProgressBar } from '@fluentui/react-components'
import { ArrowClockwise24Regular, ArrowDownload24Regular, Warning24Regular, CheckmarkCircle24Regular } from '@fluentui/react-icons'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { stat } from '@tauri-apps/plugin-fs'
import { localizeError } from '../../utils/localizeError'
import { formatSpeed, formatBytes } from '../../utils/formatSpeed'
import {
  PREREQ_DOWNLOAD_POINTS,
  RECOMMENDED_DOORSTOP_VERSION,
  V1_PREREQ_MARKER,
  V2_PREREQ_MARKER,
  V2_PREREQ_FONT,
  RMMOSAIC_MARKER,
} from './prereqPoints'

export { PREREQ_DOWNLOAD_POINTS, BEPINEX_URL, V1_PREREQ_URL, V2_PREREQ_URL, RMMOSAIC_URL } from './prereqPoints'

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
  prereqBannerOk: {
    padding: '12px 14px',
    flexShrink: 0,
    border: `1px solid ${tokens.colorStatusSuccessStroke1}`,
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
// - prereqKey='bepinex'：调用 scan_mods 检测 BepInEx 是否已装；scan_mods 同时返回
//   .doorstop_version 版本与推荐版本比对结果（doorstopCompatible），版本不兼容时
//   即使已安装也提示更换为 SFMMM 推荐版本（RECOMMENDED_DOORSTOP_VERSION）。
// - prereqKey='v1'：检测游戏根目录 BepInEx/plugins/SFM_custom_mission.dll 是否存在。
// 未装则显示警示 banner 与一键安装按钮（下载点来自 PREREQ_DOWNLOAD_POINTS 枚举，
// 名为"内置下载点"；BepInEx 支持内置 + HuggingFace + 蓝奏云多下载点切换），安装成功后通过
// onInstalled 回调通知父级刷新目录。
// category 复用创意工坊详情页的 workshop.category_* 语言键（dll/v1/v2 等）来显示分类名。
//
// 下载改为 Rust 后台任务（db_install_bepinex，与订阅记录同模式）：
// 下载复用渐进式多线程引擎（db/download.rs），进度经全局事件 "bepinex-progress"
// 广播（含 percent/downloaded/total/speed），本页按 taskId 匹配刷新；
// 离开页面/切换标签下载照常执行，回来自动恢复进行中的进度。
export function BepInExPrereqBanner({ gamePath, onInstalled, category = 'dll', prereqKey = 'bepinex' }) {
  const { t, i18n } = useTranslation()
  const styles = useStyles()
  const categoryLabel = t(`workshop.category_${category}`, { defaultValue: category })
  const points = PREREQ_DOWNLOAD_POINTS[prereqKey] || PREREQ_DOWNLOAD_POINTS.bepinex
  const [sourceIndex, setSourceIndex] = useState(0)
  const downloadPoint = points[sourceIndex] || points[0]
  const isBepinex = prereqKey === 'bepinex'
  // 安装/下载/解压进度文案按前置类型取键：BepInEx 用专属键，其余用通用键(带分类名)
  const installingLabel = isBepinex
    ? t('mods.installingBepInEx')
    : t('mods.installingPrereq', { category: categoryLabel })
  const downloadingLabel = isBepinex
    ? t('mods.downloadingBepInEx')
    : t('mods.downloadingPrereq', { category: categoryLabel })
  const extractingLabel = isBepinex
    ? t('mods.extractingBepInEx')
    : t('mods.extractingPrereq', { category: categoryLabel })
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh')
  // status: null=检测中, { installed, fontInstalled?, doorstopVersion?, doorstopCompatible? }
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState(0)
  const [downloaded, setDownloaded] = useState(0)
  const [total, setTotal] = useState(0)
  const [speed, setSpeed] = useState(0)
  const [stage, setStage] = useState('')
  const taskIdRef = useRef(null)

  const check = useCallback(async () => {
    if (!gamePath) return
    try {
      const root = gamePath.replace(/\/+$/, '')
      if (prereqKey === 'v1') {
        // v1 前置安装产物：BepInEx/plugins/SFM_custom_mission.dll
        let installed = false
        try {
          await stat(`${root}/${V1_PREREQ_MARKER}`)
          installed = true
        } catch { /* missing */ }
        setStatus({ installed })
      } else if (prereqKey === 'v2') {
        // v2 前置：插件 dll 必须存在；中文字体仅中文用户需要检测（其他语言不检测）
        let installed = false
        let fontInstalled = undefined
        try {
          await stat(`${root}/${V2_PREREQ_MARKER}`)
          installed = true
        } catch { /* missing */ }
        if (isZh) {
          fontInstalled = false
          try {
            await stat(`${root}/${V2_PREREQ_FONT}`)
            fontInstalled = true
          } catch { /* missing */ }
        }
        setStatus({ installed, fontInstalled })
      } else if (prereqKey === 'rmmosaic') {
        // 去马赛克补丁：检测游戏根目录 d3d11.dll 是否存在
        let installed = false
        try {
          await stat(`${root}/${RMMOSAIC_MARKER}`)
          installed = true
        } catch { /* missing */ }
        setStatus({ installed })
      } else {
        const res = await invoke('scan_mods', { gamePath })
        setStatus({
          installed: res.bepinExInstalled === true,
          doorstopVersion: res.doorstopVersion || '',
          doorstopCompatible: res.doorstopCompatible === true,
        })
      }
    } catch (e) {
      setError(String(e))
    }
  }, [gamePath, prereqKey, isZh])

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
      setDownloaded(payload.downloaded ?? 0)
      setTotal(payload.total ?? 0)
      setSpeed(payload.speed ?? 0)
      setStage(payload.stage || '')
      if (payload.status === 'done') {
        setInstalling(false)
        setStage('')
        // 安装完成后重新检测真实文件状态（v2 中文用户会一并刷新字体是否到位）
        check()
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
  }, [onInstalled, check])

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
          setDownloaded(task.downloaded ?? 0)
          setTotal(task.total ?? 0)
          setStage(task.stage || 'downloading')
        } else if (task.status === 'failed') {
          setError(task.error || '')
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [downloadPoint.url])

  const install = useCallback(async (index) => {
    // 下载源按钮直接传 index；未传（如 v1/v2 单源场景）时回退到当前选中源
    const point = points[index] ?? points[sourceIndex] ?? points[0]
    setSourceIndex(index ?? sourceIndex)
    setInstalling(true)
    setProgress(0)
    setDownloaded(0)
    setTotal(0)
    setSpeed(0)
    setStage('downloading')
    setError('')
    try {
      const result = await invoke('db_install_bepinex', { url: point.url })
      // 命中进行中任务时返回 deduplicated=true，同样接管其进度
      taskIdRef.current = result.taskId
    } catch (e) {
      setError(String(e))
      setInstalling(false)
      setStage('')
    }
  }, [points, sourceIndex])

  // 下载/解压进度块（已安装/未安装卡片共用）：显示百分比 + 已下载/总大小 + 实时速度
  const renderProgress = () => (
    installing && (
      <div className={styles.prereqProgress}>
        <ProgressBar value={progress / 100} />
        <Text size="small" className={styles.prereqText}>
          {stage === 'downloading' && (
            <>
              {downloadingLabel} {formatBytes(downloaded)} / {formatBytes(total)}（{progress}%）
              {speed > 0 ? ` · ${formatSpeed(speed)}` : ''}
            </>
          )}
          {stage === 'extracting' && extractingLabel}
        </Text>
      </div>
    )
  )

  // 下载源按钮：并列排列，点击即从该源安装/重装（BepInEx 三源；单源前置仅一个按钮）。
  // 按钮文字直接用源全拼（Cloudflare / HuggingFace / Lanzou），不再叫"内置下载点"。
  const renderSourceButtons = () => (
    <div className={styles.prereqRow}>
      {points.map((p, i) => (
        <Button
          key={p.url}
          size="small"
          icon={installing && sourceIndex === i ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
          onClick={() => install(i)}
          disabled={installing}
        >
          {installing && sourceIndex === i ? installingLabel : (p.name.startsWith('mods.') ? t(p.name) : p.name)}
        </Button>
      ))}
    </div>
  )

  // 已安装：始终显示绿色状态卡（各页面前置状态一目了然）
  if (status && status.installed) {
    // BepInEx 版本不兼容：即使已安装也提示更换为 SFMMM 推荐版本
    const versionMismatch = isBepinex && status.doorstopCompatible === false
    return (
      <Card className={styles.prereqBannerOk}>
        <div className={styles.prereqRow}>
          <CheckmarkCircle24Regular style={{ color: tokens.colorStatusSuccessForeground1 }} />
          <Text size="small" weight="semibold">
            {isBepinex
              ? t('mods.prereqInstalledWithBepInEx', { category: categoryLabel })
              : t('mods.prereqInstalledWithCategory', { category: categoryLabel })}
          </Text>
          <Button size="small" icon={<ArrowClockwise24Regular />} appearance="subtle" onClick={check} disabled={installing}>{t('mods.reDetect')}</Button>
        </div>
        {/* BepInEx 版本兼容性警告：.doorstop_version 非推荐版本时提示 */}
        {versionMismatch && (
          <div className={styles.prereqRow}>
            <Warning24Regular style={{ color: tokens.colorStatusWarningForeground1 }} />
            <Text size="small" className={styles.prereqText} style={{ color: tokens.colorStatusWarningForeground1 }}>
              {t('mods.bepInExVersionMismatch', { current: status.doorstopVersion || '?', recommended: RECOMMENDED_DOORSTOP_VERSION })}
            </Text>
          </div>
        )}
        {/* v2 中文用户：仅字体缺失时提示并可从下载点安装（已安装则不显示） */}
        {prereqKey === 'v2' && isZh && status.fontInstalled === false && (
          <div className={styles.prereqRow}>
            <Text size="small" className={styles.prereqText}>
              {`${t('mods.v2FontLabel')}：${t('mods.prereqNotInstalled')}`}
            </Text>
            <Button
              size="small"
              icon={installing ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
              onClick={install}
              disabled={installing}
            >
              {installing ? installingLabel : t(downloadPoint.name)}
            </Button>
          </div>
        )}
        {/* 常驻"重新安装"（仅 BepInEx）：版本不兼容或想升级时，从所选源一键重装 */}
        {isBepinex && renderSourceButtons()}
        {renderProgress()}
      </Card>
    )
  }

  // 检测中
  if (status === null) {
    return (
      <Card className={styles.prereqBanner}>
        <div className={styles.prereqRow}>
          <Spinner size="tiny" />
          <Text size="small">{t('mods.prereqChecking')}</Text>
        </div>
      </Card>
    )
  }

  // 未安装：警示 + 一键安装
  return (
    <Card className={styles.prereqBanner}>
      <div className={styles.prereqRow}>
        <Warning24Regular />
        <Text size="small" weight="semibold">
          {isBepinex
            ? t('mods.prereqNotInstalledWithBepInEx', { category: categoryLabel })
            : t('mods.prereqNotInstalledWithCategory', { category: categoryLabel })}
        </Text>
        <Button size="small" icon={<ArrowClockwise24Regular />} appearance="subtle" onClick={check} disabled={installing}>{t('mods.reDetect')}</Button>
      </div>
      {/* 前置说明：v1/v2 用各自文案，去马赛克补丁不显示该句 */}
      {prereqKey !== 'rmmosaic' && (
        <Text size="small" className={styles.prereqText}>
          {prereqKey === 'v1'
            ? t('mods.prereqHintV1', { category: categoryLabel })
            : prereqKey === 'v2'
              ? t('mods.prereqHintV2', { category: categoryLabel })
              : t('mods.bepInExHint', { category: categoryLabel })}
        </Text>
      )}
      {/* v2 中文用户：插件已装但字体缺失时单独提示 */}
      {prereqKey === 'v2' && isZh && status.fontInstalled === false && (
        <div className={styles.prereqRow}>
          <Text size="small" className={styles.prereqText} style={{ color: tokens.colorStatusWarningForeground1 }}>
            {`${t('mods.v2FontLabel')}：${t('mods.prereqNotInstalled')}`}
          </Text>
          <Button
            size="small"
            icon={installing ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
            onClick={install}
            disabled={installing}
          >
            {installing ? installingLabel : t(downloadPoint.name)}
          </Button>
        </div>
      )}
      {error && <Text size="small" className={styles.prereqText} style={{ color: tokens.colorStatusDangerForeground1 }}>{localizeError(t, error)}</Text>}
      {/* 下载源按钮：并列排列，点击即从该源安装（BepInEx 三源各一个按钮） */}
      {renderSourceButtons()}
      {/* 手动安装说明仅限 BepInEx 前置（作者官网链接及其描述仅适用于该前置） */}
      {prereqKey === 'bepinex' && (
        <Text size="small" className={styles.prereqText}>
          {t('mods.bepInExManualHint1')}
          {' '}
          <a href="https://builds.bepinex.dev/projects/bepinex_be" target="_blank" rel="noopener noreferrer">
            {t('mods.bepInExManualHintLink')}
          </a>
          {t('mods.bepInExManualHint2')}
        </Text>
      )}
      {renderProgress()}
    </Card>
  )
}
