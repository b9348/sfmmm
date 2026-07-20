import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input, Button, Text, tokens, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger } from '@fluentui/react-components'
import { login, register } from '../../services/workshopApi'
import { useAuth } from '../../contexts/useAuth'

export function LoginForm({ onSuccess }) {
  const { t } = useTranslation()
  const { loginSuccess } = useAuth()
  const [isRegister, setIsRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async () => {
    setError('')
    setBusy(true)
    try {
      const fn = isRegister ? register : login
      const data = await fn(username, password)
      loginSuccess(data.data)
      onSuccess?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
        <Input
          size="small"
          placeholder={t('workshop.username')}
          value={username}
          onChange={(_, d) => setUsername(d.value)}
        />
        <Input
          size="small"
          type="password"
          placeholder={t('workshop.password')}
          value={password}
          onChange={(_, d) => setPassword(d.value)}
        />
        {error && (
          <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>
        )}
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
        <Button size="small" appearance="primary" onClick={handleSubmit} disabled={busy}>
          {busy ? t('workshop.processing') : isRegister ? t('workshop.registerBtn') : t('workshop.login')}
        </Button>
        <Button size="small" appearance="subtle" onClick={() => { setIsRegister(!isRegister); setError('') }}>
          {isRegister ? t('workshop.hasAccount') : t('workshop.noAccount')}
        </Button>
      </div>
    </>
  )
}

export function LoginDialog({ open, onClose, onSuccess }) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose?.() }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('workshop.login')}</DialogTitle>
          <DialogContent>
            <div style={{ marginBottom: '12px' }}>
              <LoginForm onSuccess={onSuccess} />
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle">{t('workshop.cancel')}</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}