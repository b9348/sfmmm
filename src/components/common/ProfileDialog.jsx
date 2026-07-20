import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  makeStyles,
  tokens,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogTrigger,
  Button,
  Input,
  Text,
  Avatar,
  Tooltip,
  Spinner,
} from '@fluentui/react-components'
import { Dismiss24Regular } from '@fluentui/react-icons'
import { useAuth } from '../../contexts/useAuth'
import { updateProfile } from '../../services/workshopApi'
import { getAvatarUrl, getAllAvatars } from '../../utils/avatars'

const useStyles = makeStyles({
  avatarGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: '8px',
    padding: '8px 0',
    maxHeight: '280px',
    overflowY: 'auto',
  },
  avatarOption: {
    width: '40px',
    height: '40px',
    cursor: 'pointer',
    border: '2px solid transparent',
    borderRadius: '4px',
    transition: 'border-color 0.2s ease, transform 0.15s ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    '&:hover': {
      transform: 'scale(1.15)',
    },
  },
  avatarOptionSelected: {
    border: `2px solid ${tokens.colorBrandForeground1}`,
    transform: 'scale(1.15)',
  },
  avatarImg: {
    width: '36px',
    height: '36px',
  },
  currentAvatar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '12px',
  },
  divider: {
    height: '1px',
    backgroundColor: tokens.colorNeutralStroke2,
    margin: '16px 0',
  },
  fieldLabel: {
    fontSize: '12px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
    marginBottom: '4px',
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: '12px',
    marginTop: '4px',
  },
})

export function ProfileDialog({ open, onClose }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user, updateUser } = useAuth()

  const [selectedAvatar, setSelectedAvatar] = useState(user?.avatar || '')
  const [username, setUsername] = useState(user?.username || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const allAvatars = getAllAvatars()

  // 每次 dialog 打开时重置为当前用户值
  useEffect(() => {
    if (open && user) {
      setSelectedAvatar(user.avatar || '')
      setUsername(user.username || '')
      setError('')
    }
  }, [open, user])

  const handleSave = async () => {
    if (!user) return
    setError('')
    setSaving(true)
    try {
      const result = await updateProfile({
        user_id: user.user_id,
        avatar: selectedAvatar || null,
        username: username.trim() !== user.username ? username.trim() : null,
      })
      // 更新本地 auth 状态
      updateUser({
        username: result.username,
        avatar: result.avatar || null,
      })
      onClose?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = selectedAvatar !== (user?.avatar || '') || username.trim() !== (user?.username || '')

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose?.() }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('profile.title')}</DialogTitle>
          <DialogContent>
            {/* 当前头像预览 */}
            <div className={styles.currentAvatar}>
              {selectedAvatar ? (
                <img
                  src={getAvatarUrl(selectedAvatar)}
                  alt="avatar"
                  style={{ width: '48px', height: '48px' }}
                />
              ) : (
                <Avatar
                  name={username || user?.username}
                  size={48}
                  color="brand"
                />
              )}
              <div>
                <Text weight="semibold">{username || user?.username}</Text>
                <Text size="small" style={{ display: 'block', color: tokens.colorNeutralForeground2 }}>
                  {t('profile.currentAvatar')}
                </Text>
              </div>
            </div>

            {/* 头像选择网格 */}
            <Text className={styles.fieldLabel}>{t('profile.avatar')}</Text>
            <div className={styles.avatarGrid}>
              {allAvatars.map((filename) => (
                <Tooltip key={filename} content={filename} relationship="label">
                  <div
                    className={`${styles.avatarOption} ${
                      selectedAvatar === filename ? styles.avatarOptionSelected : ''
                    }`}
                    onClick={() => setSelectedAvatar(filename)}
                  >
                    <img
                      src={getAvatarUrl(filename)}
                      alt={filename}
                      className={styles.avatarImg}
                    />
                  </div>
                </Tooltip>
              ))}
            </div>

            <div className={styles.divider} />

            {/* 用户名修改 */}
            <Text className={styles.fieldLabel}>{t('profile.username')}</Text>
            <Input
              size="small"
              value={username}
              onChange={(_, d) => setUsername(d.value)}
              placeholder={user?.username || ''}
            />

            {error && (
              <Text className={styles.errorText}>{error}</Text>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle">{t('workshop.cancel')}</Button>
            </DialogTrigger>
            <Button
              size="small"
              appearance="primary"
              onClick={handleSave}
              disabled={saving || !hasChanges || !username.trim()}
            >
              {saving ? <Spinner size="tiny" /> : t('profile.save')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}