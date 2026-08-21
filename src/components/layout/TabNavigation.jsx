import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import APP_VERSION from '../../version.js'
import {
  Menu,
  MenuTrigger,
  MenuList,
  MenuItem,
  MenuPopover,
  Divider,
} from '@fluentui/react-components'
import {
  BoxMultiple24Regular,
  Settings24Regular,
  Cloud24Regular,
  Person24Regular,
  SignOut24Regular,
  PersonAccounts24Regular,
  Folder24Regular,
  DocumentFolder24Regular,
  Save24Regular,
  Heart24Regular,
  Star24Regular,
  Comment24Regular,
  AlertOn24Regular,
  ArrowSync24Regular,
  ChevronDown24Regular,
  Play24Regular,
  Navigation24Regular,
  WeatherSunny24Regular,
  WeatherMoon24Regular,
  Desktop24Regular,
} from '@fluentui/react-icons'
import { useAuth } from '../../contexts/useAuth'
import { useUserNav } from '../../contexts/useUserNav'
import { useNotification } from '../../contexts/NotificationContext'
import { getConfig } from '../../services/dbHelper'
import { getAvatarUrl } from '../../utils/avatars'
import { LoginDialog, ProfileDialog } from '../../components'
import { WinNavigationView } from './WinNavigationView'
import { usePlatform } from '../../hooks/usePlatform'

// 启动游戏的特殊条目值：只触发动作，不切换标签页
const LAUNCH_VALUE = '__launch'

/**
 * 侧边导航（TabNavigation）——基于 WinUI NavigationView 风格组件实现。
 * 保留原有全部功能：登录/注册、用户菜单、标签切换、启动游戏、版本与更新徽章。
 */
export function TabNavigation({ value, onChange, isCollapsed, onToggleCollapse, updateInfo, onNavigateToSettings, themeMode, onSelectTheme, children }) {
  const { t } = useTranslation()
  const { user, isLoggedIn, logout } = useAuth()
  const { openUser } = useUserNav()
  const { unread, refreshUnread } = useNotification()
  const { isAndroid } = usePlatform()
  const [authOpen, setAuthOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [isRegister, setIsRegister] = useState(false)
  // 当前选中的 workshop 子项值（如 workshop:my），用于让 active 蓝标定位到子菜单
  const [subValue, setSubValue] = useState(null)
  // 启动时查询一次未读通知数
  useEffect(() => {
    if (!isLoggedIn) { refreshUnread(null); return }
    refreshUnread(user.user_id)
  }, [isLoggedIn, user?.user_id, refreshUnread])

  // 程序化跳转（通知列表 → 讨论区/云详情、订阅记录/用户资料 → 云详情等）只改 hash 并切 tab，
  // 不经过 handleSelect，subValue 会滞留旧值导致蓝标不随动；
  // 监听 hashchange 按 hash 重新对齐 subValue（#/workshop/<tab> 等子页 hash 与侧边栏子项一一对应，
  // #/discuss/<id>、#/mod/<id> 分别归入 讨论区/云 子项）。
  useEffect(() => {
    const syncSubValueFromHash = () => {
      const h = window.location.hash
      let next = null
      const m = h.match(/^#\/(workshop|localmods|notify)\/(\w+)/)
      if (m) {
        next = `${m[1]}:${m[2]}`
      } else if (/^#\/discuss\//.test(h)) {
        next = 'workshop:discuss'
      } else if (/^#\/mod\//.test(h)) {
        next = 'workshop:browse'
      }
      if (!next) return
      // 仅当 hash 归属分组与当前页面一致时对齐，避免残留 hash 串扰其他页签的蓝标
      if (value && next.startsWith(`${value}:`)) setSubValue(next)
    }
    syncSubValueFromHash()
    window.addEventListener('hashchange', syncSubValueFromHash)
    return () => window.removeEventListener('hashchange', syncSubValueFromHash)
  }, [value])

  const menuItems = [
    {
      value: 'localmods',
      label: t('nav.localmods'),
      icon: <BoxMultiple24Regular />,
      // 子菜单收纳本地模组 tab（mods/v1/v2/saves），
      // 与 LocalMods 页面 hash 路由 #/localmods/<tab> 对齐
      children: [
        { value: 'localmods:mods', label: t('nav.mods'), icon: <BoxMultiple24Regular /> },
        { value: 'localmods:v1', label: t('nav.v1'), icon: <Folder24Regular /> },
        { value: 'localmods:v2', label: t('nav.v2'), icon: <DocumentFolder24Regular /> },
        { value: 'localmods:saves', label: t('nav.saves'), icon: <Save24Regular /> },
      ],
    },
    // { value: 'import-export', label: '导入/导出', icon: <ArrowSwap24Regular /> },
    {
      value: 'workshop',
      label: t('nav.workshop'),
      icon: <Cloud24Regular />,
      // 子菜单对应创意工坊页面顶部 tab（browse/discuss/my/records），
      // 图标与 Workshop 页面 TabList 保持一致
      children: [
        { value: 'workshop:browse', label: t('workshop.cloud'), icon: <Cloud24Regular /> },
        { value: 'workshop:discuss', label: t('nav.discuss'), icon: <Comment24Regular /> },
        { value: 'workshop:my', label: t('workshop.mine'), icon: <Person24Regular /> },
        { value: 'workshop:records', label: t('nav.subscriptions'), icon: <ArrowSync24Regular /> },
      ],
    },
    {
      value: 'notify',
      label: t('nav.notify'),
      icon: <AlertOn24Regular />,
      // 一级 badge = 四个二级 badge 总和；点赞/评分无未读概念
      badge: (unread.applications + unread.notifications) > 0
        ? (unread.applications + unread.notifications > 99 ? '99+' : unread.applications + unread.notifications)
        : undefined,
      // 子菜单对应通知页顶部 4 个 tab（replies/apps/likes/rates），
      // 图标与 NotifyPage 页面 TabList 保持一致
      children: [
        {
          value: 'notify:replies',
          label: t('nav.replies'),
          icon: <Comment24Regular />,
          badge: unread.notifications > 0 ? (unread.notifications > 99 ? '99+' : unread.notifications) : undefined,
        },
        {
          value: 'notify:apps',
          label: t('nav.apps'),
          icon: <PersonAccounts24Regular />,
          badge: unread.applications > 0 ? (unread.applications > 99 ? '99+' : unread.applications) : undefined,
        },
        { value: 'notify:likes', label: t('nav.likes'), icon: <Heart24Regular /> },
        { value: 'notify:rates', label: t('nav.rates'), icon: <Star24Regular /> },
      ],
    },
  ]

  // 底部菜单：启动游戏紧跟设置，底部顺序为 启动游戏 → 设置 → 版本号
  const footerMenuItems = [
    { value: LAUNCH_VALUE, label: t('nav.launchGame'), icon: <Play24Regular /> },
  ]

  const handleLogout = () => {
    logout()
  }

  const handleLaunchGame = async () => {
    try {
      const gamePath = await getConfig('game_path')
      if (!gamePath) {
        alert(t('nav.launchGameNoPath'))
        return
      }
      await invoke('launch_game', { gamePath })
    } catch (e) {
      alert(t('nav.launchGameFailed') + '\n' + (e?.message || e))
    }
  }

  // 菜单选择：启动游戏只执行动作；workshop:* / localmods:* / notify:* 子项切换对应页面内部 tab；
  // 其余切换标签页
  const handleSelect = (selected) => {
    if (selected === LAUNCH_VALUE) {
      handleLaunchGame()
      return
    }
    // 分组子项值形如 <group>:<tab>（含冒号），如 workshop:my、localmods:v1、notify:replies；
    // 组头本身（workshop / localmods / notify，无冒号）走普通切页分支
    const sepIdx = selected.indexOf(':')
    if (sepIdx > 0) {
      const groupPrefix = selected.slice(0, sepIdx)
      if (['workshop', 'localmods', 'notify'].includes(groupPrefix)) {
        // 与对应页面的 hash 路由 #/<group>/<tab> 对齐，切换内部 tab；
        // 同时记录子项值，使组件蓝标定位到二级菜单项
        setSubValue(selected)
        const sub = selected.slice(sepIdx + 1)
        window.location.hash = `#/${groupPrefix}/${sub}`
        onChange(groupPrefix)
        return
      }
    }
    setSubValue(null)
    onChange(selected)
  }

  // 面板头部：登录态用户名条目（点击弹出账号选项菜单，同「清除评分」弹出框逻辑）
  const paneHeader = isLoggedIn ? (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <div
          role="button"
          tabIndex={0}
          className="winnv-item"
          title={isCollapsed ? (user?.username || '') : undefined}
        >
          {getAvatarUrl(user?.avatar) ? (
            <span className="winnv-icon winnv-icon-node">
              <img
                src={getAvatarUrl(user?.avatar)}
                alt={user?.username || ''}
                style={{ width: 16, height: 16, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
              />
            </span>
          ) : (
            <span className="winnv-icon winnv-icon-node"><Person24Regular /></span>
          )}
          <span className="winnv-label">{user?.username || ''}</span>
        </div>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {/* 查看个人主页：打开 UserProfileDialog（含自己发布的 MOD 列表） */}
          <MenuItem
            icon={<PersonAccounts24Regular />}
            onClick={() => openUser({ userId: user?.user_id, username: user?.username, avatar: user?.avatar })}
          >
            {t('userProfile.viewProfile')}
          </MenuItem>
          <MenuItem icon={<Person24Regular />} onClick={() => setProfileOpen(true)}>{t('nav.profile')}</MenuItem>
          <Divider />
          <MenuItem icon={<SignOut24Regular />} onClick={handleLogout}>
            {t('nav.logout')}
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  ) : (
    <div
      role="button"
      tabIndex={0}
      className="winnv-item"
      title={isCollapsed ? t('nav.loginRegister') : undefined}
      onClick={() => { setAuthOpen(true) }}
    >
      <span className="winnv-icon winnv-icon-node"><Person24Regular /></span>
      <span className="winnv-label">{isAndroid ? t('workshop.login') : t('nav.loginRegister')}</span>
    </div>
  )

  // 主题切换：三态菜单（亮色/深色/跟随系统），置于底部菜单顶部（启动游戏上方）
  const themeMeta = {
    light: { icon: <WeatherSunny24Regular />, label: t('nav.themeLight') },
    dark: { icon: <WeatherMoon24Regular />, label: t('nav.themeDark') },
    system: { icon: <Desktop24Regular />, label: t('nav.themeSystem') },
  }
  const currentTheme = themeMeta[themeMode] ?? themeMeta.system
  const themeToggleItem = (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <div
          role="button"
          tabIndex={0}
          className="winnv-item winnv-theme-toggle"
          title={isCollapsed ? currentTheme.label : undefined}
        >
          <span className="winnv-icon winnv-icon-node">{currentTheme.icon}</span>
          <span className="winnv-label">{currentTheme.label}</span>
        </div>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem
            icon={<WeatherSunny24Regular />}
            checkmark={{ checked: themeMode === 'light' }}
            onClick={() => onSelectTheme('light')}
          >
            {t('nav.themeLight')}
          </MenuItem>
          <MenuItem
            icon={<WeatherMoon24Regular />}
            checkmark={{ checked: themeMode === 'dark' }}
            onClick={() => onSelectTheme('dark')}
          >
            {t('nav.themeDark')}
          </MenuItem>
          <MenuItem
            icon={<Desktop24Regular />}
            checkmark={{ checked: themeMode === 'system' }}
            onClick={() => onSelectTheme('system')}
          >
            {t('nav.themeSystem')}
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  )

  // 面板底部：版本号 + 更新徽章
  const paneFooter = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        cursor: 'pointer',
        padding: '4px 0',
        borderRadius: '4px',
        fontSize: '11px',
        color: 'var(--winnv-text-secondary, rgba(0, 0, 0, 0.62))',
      }}
      onClick={() => onNavigateToSettings?.()}
      title={updateInfo?.hasUpdate ? t('app.updateFound', { version: updateInfo.latestVersion }) : ''}
    >
      <span>v{APP_VERSION}</span>
      {updateInfo?.hasUpdate && (
        <span
          style={{
            backgroundColor: '#C42B1C',
            color: '#FFFFFF',
            fontSize: '10px',
            fontWeight: 600,
            padding: '0 6px',
            borderRadius: '8px',
            lineHeight: '16px',
          }}
        >
          NEW
        </span>
      )}
    </div>
  )

  return (
    <WinNavigationView
      menuItems={menuItems}
      footerMenuItems={footerMenuItems}
      selectedValue={['workshop', 'localmods', 'notify'].includes(value) && subValue ? subValue : value}
      onSelect={handleSelect}
      paneTitle={!isCollapsed ? 'SFMMM' : ''}
      displayMode="Left"
      isPaneOpen={!isCollapsed}
      onTogglePane={onToggleCollapse}
      openPaneLength={220}
      compactPaneLength={48}
      isSettingsVisible
      settingsLabel={t('nav.settings')}
      onSettings={() => onChange('settings')}
      isBackButtonVisible={false}
      paneHeader={paneHeader}
      paneFooter={paneFooter}
      footerLeading={themeToggleItem}
      icons={{
        hamburger: <Navigation24Regular />,
        settings: <Settings24Regular />,
        chevron: <ChevronDown24Regular />,
      }}
    >
      {/* 页面内容区（由 App.jsx 传入） */}
      {children}
      {/* 对话框 */}
      <LoginDialog open={authOpen} onClose={() => { setAuthOpen(false); setIsRegister(false) }} onSuccess={() => { setAuthOpen(false); setIsRegister(false) }} defaultIsRegister={isRegister} />
      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
    </WinNavigationView>
  )
}
