import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input, Button, Text, tokens, Avatar, Tooltip, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger } from '@fluentui/react-components'
import { login, register } from '../../services/workshopApi'
import { useAuth } from '../../contexts/useAuth'
import { getAvatarUrl, getAllAvatars } from '../../utils/avatars'

export function LoginForm({ onSuccess, defaultIsRegister }) {
  const { t } = useTranslation()
  const { loginSuccess } = useAuth()
  const [isRegister, setIsRegister] = useState(() => !!defaultIsRegister)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedAvatar, setSelectedAvatar] = useState(null)
  const allAvatars = getAllAvatars()

  const handleSubmit = async () => {
    setError('')
    setBusy(true)
    try {
      const fn = isRegister ? () => register(username, password, selectedAvatar) : () => login(username, password)
      const data = await fn()
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
        {isRegister && (
          <>
            <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>{t('profile.avatar')}</Text>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(6, 1fr)',
              gap: '6px',
              maxHeight: '180px',
              overflowY: 'auto',
              padding: '4px 0',
            }}>
              {allAvatars.map((filename) => (
                <Tooltip key={filename} content={filename} relationship="label">
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      cursor: 'pointer',
                      border: selectedAvatar === filename ? `2px solid ${tokens.colorBrandForeground1}` : '2px solid transparent',
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'border-color 0.2s ease, transform 0.15s ease',
                    }}
                    onClick={() => setSelectedAvatar(filename)}
                  >
                    <img src={getAvatarUrl(filename)} alt="" style={{ width: '32px', height: '32px' }} />
                  </div>
                </Tooltip>
              ))}
            </div>
            {selectedAvatar && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <img src={getAvatarUrl(selectedAvatar)} alt="" style={{ width: '24px', height: '24px', borderRadius: '50%' }} />
                <Text size="small">{t('profile.currentAvatar')}</Text>
              </div>
            )}
          </>
        )}
        {error && (
          <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>
        )}
      </div>
      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
        <Button size="small" appearance="primary" onClick={handleSubmit} disabled={busy}>
          {busy ? t('workshop.processing') : isRegister ? t('workshop.registerBtn') : t('workshop.login')}
        </Button>
        <Button size="small" appearance="subtle" onClick={() => { setIsRegister(!isRegister); setError(''); setSelectedAvatar(null) }}>
          {isRegister ? t('workshop.hasAccount') : t('workshop.noAccount')}
        </Button>
      </div>
    </>
  )
}

export function LoginDialog({ open, onClose, onSuccess, defaultIsRegister }) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose?.() }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('workshop.login')}</DialogTitle>
          <DialogContent>
            <div style={{ marginBottom: '12px' }}>
              <LoginForm onSuccess={onSuccess} defaultIsRegister={defaultIsRegister} />
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