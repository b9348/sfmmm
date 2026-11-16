import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Text, makeStyles, tokens,
} from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'

const useStyles = makeStyles({
  surface: {
    maxWidth: '560px',
    width: 'calc(100vw - 48px)',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    outline: 'none',
    maxHeight: '50vh',
    overflowY: 'auto',
  },
  title: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  body: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: '1.7',
    color: tokens.colorNeutralForeground2,
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
  },
})

/**
 * 启动公告弹窗。
 * - 唯一按钮「不再提醒」写入本机 SQLite；未点则每次启动都弹。
 * - 不允许点击遮罩/Esc 关闭；在线发布时会由 Provider 立即打开。
 */
export function AnnouncementModal({ announcement, onAcknowledge }) {
  const { t } = useTranslation()
  const styles = useStyles()
  return (
    <Dialog open={!!announcement} onOpenChange={() => {}} modalType="alert">
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle className={styles.title}>{announcement?.title || ''}</DialogTitle>
          <DialogContent>
            <div className={styles.content} tabIndex={0}>
              <Text className={styles.body}>{announcement?.body || ''}</Text>
              {announcement?.ends_at_ms ? (
                <Text className={styles.meta}>
                  {new Date(announcement.ends_at_ms).toLocaleString()}
                </Text>
              ) : null}
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              onClick={() => announcement && onAcknowledge(announcement.id)}
            >
              {t('announcement.ack')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
