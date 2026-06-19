import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import APP_VERSION from '../../version.js'
import {
  makeStyles,
  tokens,
  Button,
  Avatar,
  Tooltip,
  Menu,
  MenuTrigger,
  MenuList,
  MenuItem,
  MenuPopover,
  Divider,
  Text,
  Input,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
} from '@fluentui/react-components'
import {
  BoxMultiple24Regular,
  Settings24Regular,
  Cloud24Regular,
  PanelLeftContract24Regular,
  PanelLeftExpand24Regular,
  Person24Regular,
  SignOut24Regular,
  PersonAccounts24Regular,
  Folder24Regular,
  DocumentFolder24Regular,
} from '@fluentui/react-icons'
import { login, register } from '../../services/workshopApi'
import { useAuth } from '../../contexts/AuthContext'
import { useNotification } from '../../contexts/NotificationContext'

const useStyles = makeStyles({
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
    overflow: 'hidden',
  },
  sidebarExpanded: {
    width: '220px',
  },
  sidebarCollapsed: {
    width: '48px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    minHeight: '44px',
  },
  headerCollapsed: {
    justifyContent: 'flex-start',
    padding: '8px 4px',
  },
  collapseButton: {
    minWidth: '32px',
    width: '32px',
    height: '32px',
    padding: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userSection: {
    display: 'flex',
    flexDirection: 'column',
    padding: '12px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    gap: '8px',
  },
  userSectionCollapsed: {
    padding: '12px 8px',
    alignItems: 'flex-start',
  },
  userInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '6px 8px',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'background-color 0.2s ease',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackgroundHover,
    },
  },
  userInfoCollapsed: {
    padding: '6px 8px',
    justifyContent: 'flex-start',
  },
  userDetails: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    flex: 1,
  },
  userName: {
    fontSize: '13px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  userEmail: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  authButtons: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  authButtonsRow: {
    display: 'flex',
    gap: '6px',
  },
  authButton: {
    flex: 1,
    justifyContent: 'center',
  },
  tabList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '8px 4px',
    flex: 1,
    overflow: 'auto',
    overflowX: 'hidden',
  },
  tab: {
    justifyContent: 'flex-start',
    gap: '12px',
    padding: '8px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    color: tokens.colorNeutralForeground1,
    backgroundColor: 'transparent',
    border: 'none',
    position: 'relative',
    transition: 'background-color 0.2s ease, color 0.2s ease',
    whiteSpace: 'nowrap',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackgroundHover,
    },
  },
  tabCollapsed: {
    justifyContent: 'flex-start',
    padding: '8px 10px',
    gap: '0',
    minHeight: '44px',
  },
  tabSelected: {
    backgroundColor: tokens.colorNeutralBackgroundSelected,
    color: tokens.colorBrandForeground1,
    fontWeight: '600',
    '&::before': {
      content: '""',
      position: 'absolute',
      left: 0,
      top: '6px',
      bottom: '6px',
      width: '3px',
      backgroundColor: tokens.colorBrandForeground1,
      borderRadius: '0 2px 2px 0',
    },
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackgroundSelected,
    },
  },
  tabLabel: {
    fontSize: '13px',
    opacity: 1,
    transition: 'opacity 0.2s ease',
  },
  tabLabelHidden: {
    opacity: 0,
    width: 0,
    overflow: 'hidden',
  },
  tabIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '24px',
    height: '24px',
  },
  footer: {
    padding: '8px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  footerCollapsed: {
    padding: '8px 4px',
    alignItems: 'center',
  },
  version: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  versionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    cursor: 'pointer',
    padding: '2px 0',
    borderRadius: '4px',
    transition: 'background-color 0.2s ease',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackgroundHover,
    },
  },
  badge: {
    backgroundColor: tokens.colorPaletteRedBackground3,
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: '10px',
    fontWeight: '600',
    padding: '0 6px',
    borderRadius: '8px',
    lineHeight: '16px',
  },
})

export function TabNavigation({ value, onChange, isCollapsed, onToggleCollapse, updateInfo, onNavigateToSettings }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user, isLoggedIn, loginSuccess, logout } = useAuth()
  const { unreadCount, refreshUnread } = useNotification()
  const [authOpen, setAuthOpen] = useState(false)
  const [isRegister, setIsRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // 启动时查询一次未读通知数
  useEffect(() => {
    if (!isLoggedIn) { refreshUnread(null); return }
    refreshUnread(user.user_id)
  }, [isLoggedIn, user?.user_id, refreshUnread])

  const tabs = [
    { value: 'mods', label: t('nav.mods'), icon: BoxMultiple24Regular },
    { value: 'v1', label: 'v1', icon: Folder24Regular },
    { value: 'v2', label: 'v2', icon: DocumentFolder24Regular },
    // { value: 'saves', label: '存档', icon: Save24Regular },
    // { value: 'import-export', label: '导入/导出', icon: ArrowSwap24Regular },
    { value: 'workshop', label: t('nav.workshop'), icon: Cloud24Regular },
    { value: 'apply', label: t('nav.apply'), icon: PersonAccounts24Regular },
    { value: 'settings', label: t('nav.settings'), icon: Settings24Regular },
  ]

  const handleAuthSubmit = async () => {
    setError('')
    setBusy(true)
    try {
      const fn = isRegister ? register : login
      const data = await fn(username, password)
      loginSuccess(data.data)
      setAuthOpen(false)
      setUsername('')
      setPassword('')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = () => {
    logout()
  }

  return (
    <div
      className={`${styles.sidebar} ${
        isCollapsed ? styles.sidebarCollapsed : styles.sidebarExpanded
      }`}
    >
      {/* Header with collapse button — always top-right */}
      <div className={`${styles.header} ${isCollapsed ? styles.headerCollapsed : ''}`}>
        <Tooltip
          content={isCollapsed ? t('nav.expand') : t('nav.collapse')}
          relationship="label"
        >
          <Button
            appearance="subtle"
            className={styles.collapseButton}
            onClick={onToggleCollapse}
            icon={isCollapsed ? <PanelLeftExpand24Regular /> : <PanelLeftContract24Regular />}
          />
        </Tooltip>
      </div>

      {/* User Section */}
      <div
        className={`${styles.userSection} ${
          isCollapsed ? styles.userSectionCollapsed : ''
        }`}
      >
        {isLoggedIn ? (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <div
                className={`${styles.userInfo} ${
                  isCollapsed ? styles.userInfoCollapsed : ''
                }`}
              >
                <Avatar
                  name={user?.username || ''}
                  size={isCollapsed ? 28 : 32}
                  color="brand"
                />
                {!isCollapsed && (
                  <div className={styles.userDetails}>
                    <span className={styles.userName}>{user?.username || ''}</span>
                    {user?.email && <span className={styles.userEmail}>{user.email}</span>}
                  </div>
                )}
              </div>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<PersonAccounts24Regular />}>{t('nav.account')}</MenuItem>
                <MenuItem icon={<Person24Regular />}>{t('nav.profile')}</MenuItem>
                <Divider />
                <MenuItem icon={<SignOut24Regular />} onClick={handleLogout}>
                  {t('nav.logout')}
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        ) : (
          <div
            className={`${styles.authButtons} ${
              isCollapsed ? styles.userInfoCollapsed : ''
            }`}
          >
            {isCollapsed ? (
              <Tooltip content={t('workshop.login')} relationship="label">
                <Button
                  appearance="subtle"
                  className={styles.collapseButton}
                  onClick={() => { setIsRegister(false); setError(''); setAuthOpen(true) }}
                  icon={<Person24Regular />}
                />
              </Tooltip>
            ) : (
              <div className={styles.authButtonsRow}>
                <Button
                  appearance="secondary"
                  size="small"
                  className={styles.authButton}
                  onClick={() => { setIsRegister(false); setError(''); setAuthOpen(true) }}
                >
                  {t('workshop.login')}
                </Button>
                <Button
                  appearance="primary"
                  size="small"
                  className={styles.authButton}
                  onClick={() => { setIsRegister(true); setError(''); setAuthOpen(true) }}
                >
                  {t('workshop.register')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tab List */}
      <div className={styles.tabList}>
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isSelected = value === tab.value
          return (
            <Tooltip
              key={tab.value}
              content={tab.label}
              relationship="label"
              positioning={isCollapsed ? 'after' : undefined}
            >
              <button
                className={`${styles.tab} ${isSelected ? styles.tabSelected : ''} ${
                  isCollapsed ? styles.tabCollapsed : ''
                }`}
                onClick={() => onChange(tab.value)}
              >
                <span className={styles.tabIcon}><Icon /></span>
                <span
                  className={`${styles.tabLabel} ${
                    isCollapsed ? styles.tabLabelHidden : ''
                  }`}
                >
                  {tab.label}
                </span>
                {tab.value === 'apply' && unreadCount > 0 && (
                  <span className={styles.badge}>{unreadCount > 99 ? '99+' : unreadCount}</span>
                )}
              </button>
            </Tooltip>
          )
        })}
      </div>

      {/* Footer */}
      <div className={`${styles.footer} ${isCollapsed ? styles.footerCollapsed : ''}`}>
        <div
          className={styles.versionRow}
          onClick={() => onNavigateToSettings?.()}
          title={updateInfo?.hasUpdate ? t('app.updateFound', { version: updateInfo.latestVersion }) : ''}
        >
          <span className={styles.version}>v{APP_VERSION}</span>
          {updateInfo?.hasUpdate && (
            <span className={styles.badge}>NEW</span>
          )}
        </div>
      </div>

      {/* Auth Dialog */}
      <Dialog open={authOpen} onOpenChange={(_, d) => { setAuthOpen(d.open); if (!d.open) setError('') }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{isRegister ? t('workshop.register') : t('workshop.login')}</DialogTitle>
            <DialogContent>
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
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button size="small" appearance="subtle">{t('workshop.cancel')}</Button>
              </DialogTrigger>
              <Button size="small" appearance="primary" onClick={handleAuthSubmit} disabled={busy}>
                {busy ? t('workshop.processing') : isRegister ? t('workshop.registerBtn') : t('workshop.login')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
