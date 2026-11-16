import { useTranslation } from 'react-i18next'
import { Button } from '@fluentui/react-components'
import { ArrowLeft24Regular } from '@fluentui/react-icons'

export function BackButton({ onClick, disabled = false }) {
  const { t } = useTranslation()
  return (
    <Button size="small" icon={<ArrowLeft24Regular />} appearance="subtle" onClick={onClick} disabled={disabled}>
      {t('workshop.back')}
    </Button>
  )
}
