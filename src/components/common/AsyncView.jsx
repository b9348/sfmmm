import { useTranslation } from 'react-i18next'
import { Text, Button, Spinner, makeStyles, tokens } from '@fluentui/react-components'
import { ArrowClockwise24Regular } from '@fluentui/react-icons'

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
    return (
      <div className={styles.root}>
        <Text weight="semibold">{t('workshop.loadFailed')}</Text>
        <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>{error}</Text>
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