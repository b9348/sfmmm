import { useTranslation } from 'react-i18next'
import { Text, Button, Spinner, makeStyles, tokens } from '@fluentui/react-components'
import { ArrowClockwise24Regular } from '@fluentui/react-icons'
import { formatDbError } from '../../services/workshopApi'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
    padding: '32px',
    textAlign: 'center',
  },
})

export function AsyncView({ loading, error, onRetry, loadingLabel, children }) {
  const { t } = useTranslation()
  const styles = useStyles()

  if (loading) {
    return (
      <div className={styles.root}>
        <Spinner size="small" label={loadingLabel || t('app.loading')} />
      </div>
    )
  }

  if (error) {
    // 后端结构化错误（[DBERR:*]）转成面向用户的友好文案；
    // 非结构化错误（前端超时兜底等）原样展示
    const errorText = formatDbError(error, t)
    return (
      <div className={styles.root}>
        <Text weight="semibold">{t('workshop.loadFailed')}</Text>
        <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>{errorText}</Text>
        {onRetry && (
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={onRetry}>
            {t('workshop.retry')}
          </Button>
        )}
      </div>
    )
  }

  return children
}