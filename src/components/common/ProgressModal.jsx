import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  ProgressBar, Text, Button, makeStyles, tokens,
} from '@fluentui/react-components'

const useStyles = makeStyles({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minWidth: '320px',
    maxWidth: '480px',
    outline: 'none',
  },
  step: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
  },
  speed: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
  },
  error: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorPaletteRedForeground1,
    wordBreak: 'break-all',
    maxHeight: '120px',
    overflowY: 'auto',
  },
})

/**
 * 进度弹窗：
 * - 默认不可关闭（alert 模式），用于纯展示的进行中任务
 * - 传入 onCancel 后显示手动取消按钮，便于网络卡住/出错时退出
 * - speedText 显示实时速度（如 "上传速度 1.2 MB/s"）
 * - errorText 在弹窗内展示错误，配合 onCancel 由用户手动关闭
 */
export function ProgressModal({ open, title, percent, stepText, speedText, errorText, onCancel, cancelLabel }) {
  const styles = useStyles()
  return (
    <Dialog open={open} onOpenChange={() => {}} modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <div className={styles.content} tabIndex={0}>
              <ProgressBar value={percent / 100} />
              {stepText && <Text size="small" className={styles.step}>{stepText}</Text>}
              {!errorText && speedText && <Text size="small" className={styles.speed}>{speedText}</Text>}
              {errorText && <Text size="small" className={styles.error}>{errorText}</Text>}
            </div>
          </DialogContent>
          {onCancel && (
            <DialogActions>
              <Button size="small" appearance={errorText ? 'primary' : 'secondary'} onClick={onCancel}>
                {cancelLabel}
              </Button>
            </DialogActions>
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
