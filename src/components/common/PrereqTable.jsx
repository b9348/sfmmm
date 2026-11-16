import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import {
  ArrowClockwise24Regular,
  ArrowDownload24Regular,
  ChevronDown24Regular,
  ChevronRight24Regular,
  Warning24Regular,
} from '@fluentui/react-icons'
import { localizeError } from '../../utils/localizeError'
import { getConfig, setConfig } from '../../services/dbHelper'
import { DownloadProgress } from './DownloadProgress'
import { RECOMMENDED_DOORSTOP_VERSION } from './prereqPoints'
import { usePrereqRow } from './usePrereqRow'

// 折叠状态存 sqlite config 表；三页共用同一个展示偏好
const COLLAPSED_KEY = 'prereq_table_collapsed'

const NAME_KEYS = {
  bepinex: 'mods.prereqNameBepInEx',
  v1: 'mods.prereqNameV1',
  v2: 'mods.prereqNameV2',
  font: 'mods.prereqNameFont',
  rmmosaic: 'mods.prereqNameRmmosaic',
}

const CATEGORY_BY_KEY = {
  bepinex: 'dll',
  v1: 'v1',
  v2: 'v2',
  font: 'v2',
  rmmosaic: 'rmmosaic',
}

const useStyles = makeStyles({
  card: {
    flexShrink: 0,
    padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '32px',
  },
  toggleBtn: {
    paddingLeft: 0,
    paddingRight: 0,
  },
  hidden: {
    display: 'none',
  },
  table: {
    tableLayout: 'fixed',
    width: '100%',
  },
  nameCell: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  nameText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  infoCell: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  infoText: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  },
  statusIcon: {
    color: tokens.colorStatusDangerForeground1,
  },
  statusIconWarning: {
    color: tokens.colorStatusWarningForeground1,
  },
  actionCell: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px',
  },
})

function isOutdated(key, status) {
  if (!status || !status.installed) return false
  if (key === 'bepinex') return status.doorstopCompatible === false
  if (key === 'v2') return status.outdated === true
  return false
}

/**
 * 前置内容检测表格：本地模组的模组 / v1 / v2 三个页面共用。
 * 每页展示统一的前置全集（不随 tab 变化），每种前置一行，
 * 列从左到右为 前置 / 状态 / 说明 / 操作 / 检测：
 * - 前置：名称（BepInEx 加载器、v1 任务前置、v2 任务前置、中文字体、去马赛克补丁）
 * - 状态：检测中 / 已安装 / 未安装 / 需更新
 * - 说明：安装产物要求、版本兼容性、缺失提示与错误
 * - 操作：各下载点一键安装，安装中显示进度与取消
 * - 检测：重新检测该行
 *
 * 卡片可折叠：表头常驻一行摘要（检测中 / N 个前置未安装 / N 个前置需更新 / 已全部安装），
 * 折叠状态写入 sqlite config 表（prereq_table_collapsed），三个页面共用。
 *
 * items 形如 [{ key: 'bepinex' }, { key: 'rmmosaic' }]，key 见 NAME_KEYS。
 */
export function PrereqTable({ gamePath, items, onInstalled }) {
  const { t } = useTranslation()
  const styles = useStyles()
  // null=折叠状态读取中：先隐藏表格，避免展开态闪一下再折叠
  const [collapsed, setCollapsed] = useState(null)
  // 各行检测结果汇总到表头，供折叠后的「未安装 / 需更新 / 已全部安装」统计
  const [statusMap, setStatusMap] = useState({})

  useEffect(() => {
    let cancelled = false
    getConfig(COLLAPSED_KEY)
      .then((raw) => { if (!cancelled) setCollapsed(raw === 'true') })
      .catch(() => { if (!cancelled) setCollapsed(false) })
    return () => { cancelled = true }
  }, [])

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed
    setCollapsed(next)
    setConfig(COLLAPSED_KEY, next ? 'true' : 'false').catch(() => {})
  }, [collapsed])

  const handleStatus = useCallback((key, status) => {
    setStatusMap((prev) => (prev[key] === status ? prev : { ...prev, [key]: status }))
  }, [])

  const noGamePath = !gamePath
  const rowStatuses = items.map((it) => statusMap[it.key])
  const checking = rowStatuses.some((s) => s === undefined || s === null)
  const failedCount = rowStatuses.filter((s) => s?.failed).length
  const missingCount = rowStatuses.filter((s) => s && !s.failed && !s.installed).length
  const outdatedCount = items.filter((it) => isOutdated(it.key, statusMap[it.key])).length

  let summary
  let summaryColor = 'subtle'
  if (noGamePath) {
    summary = t('mods.prereqSummaryNoGamePath')
  } else if (checking) {
    summary = t('mods.prereqSummaryChecking')
  } else if (failedCount > 0) {
    summary = t('mods.prereqSummaryFailed', { count: failedCount })
    summaryColor = 'danger'
  } else if (missingCount > 0) {
    summary = t('mods.prereqSummaryMissing', { count: missingCount })
    summaryColor = 'danger'
  } else if (outdatedCount > 0) {
    summary = t('mods.prereqSummaryOutdated', { count: outdatedCount })
    summaryColor = 'warning'
  } else {
    summary = t('mods.prereqSummaryAllInstalled')
    summaryColor = 'success'
  }

  // 未配置游戏目录时没有可检测的目标，直接收起表格（页面下方已有"未配置游戏目录"空状态）
  const tableHidden = noGamePath || collapsed !== false

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <Button
          size="small"
          appearance="transparent"
          className={styles.toggleBtn}
          icon={collapsed === false && !noGamePath ? <ChevronDown24Regular /> : <ChevronRight24Regular />}
          onClick={toggleCollapsed}
          disabled={noGamePath}
        >
          {t('mods.prereqTitle')}
        </Button>
        <Badge size="small" appearance="tint" color={summaryColor}>{summary}</Badge>
      </div>
      <div className={tableHidden ? styles.hidden : undefined}>
        <Table className={styles.table} size="small">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: '16%' }}>{t('mods.prereqColName')}</TableHeaderCell>
              <TableHeaderCell style={{ width: '11%' }}>{t('mods.prereqColStatus')}</TableHeaderCell>
              <TableHeaderCell style={{ width: '35%' }}>{t('mods.prereqColInfo')}</TableHeaderCell>
              <TableHeaderCell style={{ width: '24%' }}>{t('mods.prereqColAction')}</TableHeaderCell>
              <TableHeaderCell style={{ width: '14%' }}>{t('mods.prereqColCheck')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <PrereqRow
                key={item.key}
                prereqKey={item.key}
                gamePath={gamePath}
                onInstalled={onInstalled}
                onStatus={handleStatus}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function PrereqRow({ prereqKey, gamePath, onInstalled, onStatus }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const {
    points,
    status,
    error,
    installing,
    progress,
    downloaded,
    total,
    speed,
    stage,
    activeUrl,
    check,
    install,
    cancelInstall,
  } = usePrereqRow({ gamePath, prereqKey, onInstalled })

  // 上报本行检测结果给表头，用于折叠后的统计摘要
  useEffect(() => {
    onStatus?.(prereqKey, status)
  }, [onStatus, prereqKey, status])

  const categoryLabel = t(`workshop.category_${CATEGORY_BY_KEY[prereqKey] || 'dll'}`, {
    defaultValue: CATEGORY_BY_KEY[prereqKey] || 'dll',
  })
  const isBepinex = prereqKey === 'bepinex'
  const isFont = prereqKey === 'font'
  const versionMismatch = isBepinex && status?.installed && status.doorstopCompatible === false
  const v2Outdated = prereqKey === 'v2' && status?.installed && status.outdated === true

  const installingLabel = isBepinex
    ? t('mods.installingBepInEx')
    : isFont
      ? t('mods.installingFont')
      : t('mods.installingPrereq', { category: categoryLabel })
  const downloadingLabel = isBepinex
    ? t('mods.downloadingBepInEx')
    : isFont
      ? t('mods.installingFont')
      : t('mods.downloadingPrereq', { category: categoryLabel })
  const extractingLabel = isBepinex
    ? t('mods.extractingBepInEx')
    : isFont
      ? t('mods.installingFont')
      : t('mods.extractingPrereq', { category: categoryLabel })

  const renderStatus = () => {
    if (status === null) {
      return (
        <div className={styles.nameCell}>
          <Spinner size="tiny" />
          <Text size="small">{t('mods.prereqStatusChecking')}</Text>
        </div>
      )
    }
    if (status.failed) {
      return <Badge size="small" appearance="filled" color="severe">{t('mods.prereqStatusFailed')}</Badge>
    }
    if (!status.installed) {
      return <Badge size="small" appearance="filled" color="danger">{t('mods.prereqStatusMissing')}</Badge>
    }
    if (versionMismatch || v2Outdated) {
      return <Badge size="small" appearance="filled" color="warning">{t('mods.prereqStatusOutdated')}</Badge>
    }
    return <Badge size="small" appearance="filled" color="success">{t('mods.prereqStatusInstalled')}</Badge>
  }

  const renderInfo = () => {
    const lines = []
    if (status === null) {
      lines.push(<Text key="checking" size="small" className={styles.infoText}>{t('mods.prereqChecking')}</Text>)
    } else if (status.failed) {
      // 说明列只保留下方统一追加的错误文案，不再展示安装提示
    } else if (prereqKey === 'bepinex') {
      if (status.installed) {
        if (status.doorstopVersion) {
          lines.push(
            <Text key="doorstop" size="small" className={styles.infoText}>
              {t('mods.prereqDoorstopCurrent', {
                current: status.doorstopVersion,
                recommended: RECOMMENDED_DOORSTOP_VERSION,
              })}
            </Text>,
          )
        }
        if (versionMismatch) {
          lines.push(
            <Text key="mismatch" size="small" className={styles.infoText} style={{ color: tokens.colorStatusWarningForeground1 }}>
              <Warning24Regular style={{ verticalAlign: 'text-bottom', marginRight: '4px' }} />
              {t('mods.bepInExVersionMismatchShort', { recommended: RECOMMENDED_DOORSTOP_VERSION })}
              {' '}
              <a href="https://builds.bepinex.dev/projects/bepinex_be" target="_blank" rel="noopener noreferrer">
                {t('mods.bepInExSelfUpdateLink')}
              </a>
            </Text>,
          )
        }
      } else {
        lines.push(<Text key="hint" size="small" className={styles.infoText}>{t('mods.bepInExHint', { category: categoryLabel })}</Text>)
        lines.push(
          <Text key="manual" size="small" className={styles.infoText}>
            {t('mods.bepInExManualHint1')}
            {' '}
            <a href="https://builds.bepinex.dev/projects/bepinex_be" target="_blank" rel="noopener noreferrer">
              {t('mods.bepInExManualHintLink')}
            </a>
            {t('mods.bepInExManualHint2')}
          </Text>,
        )
      }
    } else if (prereqKey === 'v1') {
      if (!status.installed) {
        lines.push(<Text key="hint" size="small" className={styles.infoText}>{t('mods.prereqHintV1', { category: categoryLabel })}</Text>)
      }
    } else if (prereqKey === 'v2') {
      if (v2Outdated) {
        lines.push(<Text key="outdated" size="small" className={styles.infoText} style={{ color: tokens.colorStatusWarningForeground1 }}>{t('mods.v2Outdated', { version: status.required })}</Text>)
      } else if (status.installed) {
        if (status.installedVersion) {
          lines.push(<Text key="version" size="small" className={styles.infoText}>{t('mods.prereqV2Version', { version: status.installedVersion })}</Text>)
        }
      } else {
        lines.push(<Text key="hint" size="small" className={styles.infoText}>{t('mods.prereqHintV2', { category: categoryLabel })}</Text>)
      }
    } else if (prereqKey === 'font') {
      if (!status.installed) {
        lines.push(<Text key="hint" size="small" className={styles.infoText}>{t('mods.prereqFontHint')}</Text>)
      }
    } else if (prereqKey === 'rmmosaic') {
      if (!status.installed) {
        lines.push(<Text key="hint" size="small" className={styles.infoText}>{t('mods.prereqRmmosaicHint')}</Text>)
      }
    }
    if (error) {
      lines.push(<Text key="error" size="small" className={styles.infoText} style={{ color: tokens.colorStatusDangerForeground1 }}>{localizeError(t, error)}</Text>)
    }
    return <div className={styles.infoCell}>{lines}</div>
  }

  // 每行常驻下载点按钮（已安装也可重装，各前置保持一致）。
  // key 带上名称：BepInEx 的 Cloudflare/HuggingFace 下载点共用同一个 URL，只用 URL 会重复。
  const renderActions = () => (
    <div className={styles.actionCell}>
      {points.map((p) => (
        <Button
          key={`${p.name}:${p.url}`}
          size="small"
          icon={installing && activeUrl === p.url ? <Spinner size="tiny" /> : <ArrowDownload24Regular />}
          onClick={() => install(p)}
          disabled={installing}
        >
          {installing && activeUrl === p.url
            ? installingLabel
            : (p.name.startsWith('mods.') ? t(p.name) : p.name)}
        </Button>
      ))}
      {installing && (
        <DownloadProgress
          label={stage === 'extracting' ? extractingLabel : downloadingLabel}
          percent={progress}
          downloaded={downloaded}
          total={total}
          speed={stage === 'extracting' ? 0 : speed}
          showDetail={stage !== 'extracting'}
          onCancel={cancelInstall}
          cancelLabel={t('mods.cancelDownload')}
        />
      )}
    </div>
  )

  return (
    <TableRow>
      <TableCell>
        <div className={styles.nameCell}>
          {status !== null && (!status.installed || versionMismatch || v2Outdated) && (
            <Warning24Regular
              className={status.installed ? styles.statusIconWarning : styles.statusIcon}
            />
          )}
          <Text size="small" weight="semibold" className={styles.nameText} title={t(NAME_KEYS[prereqKey])}>
            {t(NAME_KEYS[prereqKey])}
          </Text>
        </div>
      </TableCell>
      <TableCell>{renderStatus()}</TableCell>
      <TableCell>{renderInfo()}</TableCell>
      <TableCell>{renderActions()}</TableCell>
      <TableCell>
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowClockwise24Regular />}
          onClick={check}
          disabled={installing}
        >
          {t('mods.reDetect')}
        </Button>
      </TableCell>
    </TableRow>
  )
}

export default PrereqTable
