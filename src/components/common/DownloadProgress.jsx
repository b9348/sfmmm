import { useTranslation } from 'react-i18next'
import {
  Button,
  ProgressBar,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components'
import { formatSpeed, formatBytes } from '../../utils/formatSpeed'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    width: '100%',
    minWidth: '120px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    minWidth: 0,
  },
  text: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    wordBreak: 'break-word',
  },
})

/**
 * 下载/安装进度通用展示：进度条 + 一行文案（阶段 + 已下载/总大小/百分比 + 速度）+ 可选取消按钮。
 *
 * 下载通路的各处（前置安装、程序更新、订阅安装、仅下载）共用同一套展示，避免
 * 各自复制「ProgressBar + formatBytes + formatSpeed」导致样式/文案漂移。
 *
 * @param {string} [label] 阶段文案，如“正在下载 BepInEx”；传空则只显示数值
 * @param {number} [percent] 0-100；不传则不渲染进度条与百分比（例如纯“正在解压”提示）
 * @param {number} [downloaded] 已下载字节；与 total 同时存在时显示 “1.2 MB / 3.4 MB（35%）”
 * @param {number} [total] 总字节
 * @param {number} [speed] 字节/秒；>0 时追加 “· 2.1 MB/s”
 * @param {boolean} [showDetail=true] 为 false 时只保留 label 与进度条（如“正在解压”阶段，
 *   进度条沿用 100%，但不拼接大小/百分比）
 * @param {'medium'|'thin'} [thickness] 进度条粗细
 * @param {Function} [onCancel] 传入则显示取消按钮
 * @param {string} [cancelLabel] 取消按钮文案（默认取通用“取消下载”）
 * @param {string} [className] 追加到根节点的类名
 */
export function DownloadProgress({
  label,
  percent,
  downloaded,
  total,
  speed,
  showDetail = true,
  thickness,
  onCancel,
  cancelLabel,
  className,
}) {
  const { t } = useTranslation()
  const styles = useStyles()
  const hasPercent = typeof percent === 'number' && Number.isFinite(percent)
  const hasSize = hasPercent && typeof downloaded === 'number' && typeof total === 'number' && total > 0
  const detail = !showDetail
    ? ''
    : hasPercent
      ? (hasSize ? `${formatBytes(downloaded)} / ${formatBytes(total)}（${percent}%）` : `${percent}%`)
      : ''
  const head = [label, detail].filter(Boolean).join(' ')
  const suffix = speed > 0 ? ` · ${formatSpeed(speed)}` : ''
  const showLine = Boolean(head || suffix || onCancel)

  return (
    <div className={mergeClasses(styles.root, className)}>
      {hasPercent && <ProgressBar value={percent / 100} thickness={thickness} />}
      {showLine && (
        <div className={styles.row}>
          <Text size="small" className={styles.text}>{head}{suffix}</Text>
          {onCancel && (
            <Button size="small" appearance="secondary" onClick={onCancel}>
              {cancelLabel || t('mods.cancelDownload')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export default DownloadProgress
