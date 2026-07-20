import { useTranslation } from 'react-i18next'
import { Button, Text, makeStyles } from '@fluentui/react-components'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '6px',
    padding: '12px 0',
    flexWrap: 'wrap',
  },
})

export function Pagination({ page, totalPages, onChange, disabled = false }) {
  const { t } = useTranslation()
  const styles = useStyles()

  if (totalPages <= 1) return null

  return (
    <div className={styles.root}>
      <Button size="small" disabled={page <= 1 || disabled} onClick={() => onChange(page - 1)}>
        {t('workshop.prevPage')}
      </Button>
      <Text size="small">{page} / {totalPages}</Text>
      <Button size="small" disabled={page >= totalPages || disabled} onClick={() => onChange(page + 1)}>
        {t('workshop.nextPage')}
      </Button>
    </div>
  )
}