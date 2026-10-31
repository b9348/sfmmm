import { Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, Button } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'

export function ConfirmDialog({ open, onClose, title, children, onConfirm, confirmText }) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(_, { open }) => { if (!open) onClose?.() }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>{children}</DialogContent>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '12px 0 0' }}>
            <DialogTrigger>
              <Button size="small" appearance="subtle">{t('workshop.cancel')}</Button>
            </DialogTrigger>
            <Button size="small" appearance="primary" onClick={onConfirm}>{confirmText || t('workshop.confirmDelete')}</Button>
          </div>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
