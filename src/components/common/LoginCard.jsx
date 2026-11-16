import { useTranslation } from 'react-i18next'
import { Card, Text, makeStyles, tokens } from '@fluentui/react-components'
import { LoginForm } from './LoginForm'

const useStyles = makeStyles({
  card: {
    maxWidth: '360px',
    margin: '0 auto',
    padding: '16px',
  },
  title: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '12px',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export function LoginCard({ hintKey = 'workshop.loginHint', align = 'center', style }) {
  const { t } = useTranslation()
  const styles = useStyles()

  return (
    <Card className={styles.card} style={style}>
      <div className={styles.title} style={{ textAlign: align }}>
        <Text weight="semibold">{t('workshop.login')}</Text>
        <Text size="small" className={styles.meta} block>
          {t(hintKey)}
        </Text>
      </div>
      <LoginForm />
    </Card>
  )
}
