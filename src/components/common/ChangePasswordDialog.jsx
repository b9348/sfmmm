import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useAuth } from '../../contexts/useAuth'
import { changePassword } from '../../services/workshopApi'

const useStyles = makeStyles({
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
    marginTop: '8px',
  },
})

/**
 * 修改密码：旧密码校验 + 新密码输入两次确认。
 * 成功后不退出登录，当前令牌继续有效。
 */
export function ChangePasswordDialog({ open, onClose, onSuccess }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user } = useAuth()

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 每次打开重置输入（渲染期调整 state，避免 effect 级联渲染）
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setError('')
      setSaving(false)
    }
  }

  const canSubmit = !!oldPassword && !!newPassword && !!confirmPassword && !saving

  const handleSubmit = async () => {
    if (!user || saving) return
    if (!oldPassword || !newPassword || !confirmPassword) return
    setError('')

    if (Array.from(newPassword).length < 4) {
      setError(t('password.tooShort'))
      return
    }
    if (newPassword !== confirmPassword) {
      setError(t('password.mismatch'))
      return
    }
    if (newPassword === oldPassword) {
      setError(t('password.sameAsOld'))
      return
    }

    setSaving(true)
    try {
      await changePassword({
        user_id: user.user_id,
        old_password: oldPassword,
        new_password: newPassword,
      })
      onSuccess?.()
      onClose?.()
    } catch (e) {
      setError(e?.message || t('password.failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open && !saving) onClose?.() }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('password.title')}</DialogTitle>
          <DialogContent>
            <div className={styles.fields}>
              <Field label={t('password.old')} required>
                <Input
                  type="password"
                  value={oldPassword}
                  autoComplete="current-password"
                  onChange={(_, d) => setOldPassword(d.value)}
                  disabled={saving}
                />
              </Field>
              <Field label={t('password.new')} required>
                <Input
                  type="password"
                  value={newPassword}
                  autoComplete="new-password"
                  onChange={(_, d) => setNewPassword(d.value)}
                  disabled={saving}
                />
              </Field>
              <Field label={t('password.confirm')} required>
                <Input
                  type="password"
                  value={confirmPassword}
                  autoComplete="new-password"
                  onChange={(_, d) => setConfirmPassword(d.value)}
                  disabled={saving}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
                />
              </Field>
            </div>
            {error && <Text className={styles.error}>{error}</Text>}
          </DialogContent>
          <DialogActions>
            <Button size="small" appearance="subtle" onClick={onClose} disabled={saving}>
              {t('workshop.cancel')}
            </Button>
            <Button
              size="small"
              appearance="primary"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {saving ? <Spinner size="tiny" /> : t('password.submit')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}

export default ChangePasswordDialog
