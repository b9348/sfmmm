import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Text, makeStyles, tokens,
} from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { UserAvatar } from './UserAvatar'

const useStyles = makeStyles({
  surface: {
    maxWidth: '520px',
    width: 'calc(100vw - 48px)',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    outline: 'none',
  },
  desc: {
    color: tokens.colorNeutralForeground2,
    lineHeight: '1.6',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    maxHeight: '40vh',
    overflowY: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  info: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
  },
  username: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
})

/**
 * 旧版账号恢复弹窗：列出 0.3.x 时代留在本机的账号，点「继续使用」换取新令牌。
 * 未点「不再提醒」时每次启动都会再弹；「稍后再说」只关闭本次。
 */
export function LegacyAccountDialog({ open, accounts, busyId, error, onRestore, onMute, onClose }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const single = accounts.length === 1

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose?.() }}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>{t('legacyAccount.title')}</DialogTitle>
          <DialogContent>
            <Text className={styles.desc}>
              {single
                ? t('legacyAccount.singleDesc', { name: accounts[0]?.username || '' })
                : t('legacyAccount.multiDesc')}
            </Text>
            <div className={styles.list}>
              {accounts.map((account) => (
                <div key={account.user_id} className={styles.row}>
                  <UserAvatar avatar={account.avatar} name={account.username} size={32} userId={account.user_id} />
                  <div className={styles.info}>
                    <Text weight="semibold" className={styles.username}>{account.username}</Text>
                    <Text className={styles.meta}>ID: {account.user_id}</Text>
                  </div>
                  <Button
                    size="small"
                    appearance="primary"
                    disabled={busyId != null}
                    onClick={() => onRestore(account)}
                  >
                    {busyId === account.user_id ? t('workshop.processing') : t('legacyAccount.continue')}
                  </Button>
                </div>
              ))}
            </div>
            {error && <Text size="small" className={styles.error}>{error}</Text>}
          </DialogContent>
          <DialogActions>
            <Button appearance="subtle" onClick={onClose}>{t('legacyAccount.later')}</Button>
            <Button appearance="secondary" onClick={onMute}>{t('legacyAccount.mute')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
