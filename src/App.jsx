import { useState, useEffect, useReducer } from 'react'
import { FluentProvider, webLightTheme, webDarkTheme, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger, Button, Text } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'
import { TabNavigation, WelcomeScreen, TitleBar } from './components'
import { SaveManagement, ImportExport, GameSettings, Workshop, LocalMods, NotifyPage } from './modules'
import { AuthProvider } from './contexts/AuthContext.jsx'
import { UserNavProvider } from './contexts/UserNavProvider.jsx'
import { NotificationProvider } from './contexts/NotificationContext'
import { usePersistUI } from './hooks/usePersistUI'
import { getConfigs, setConfig } from './services/dbHelper'
import { checkVersion, applyUpdate } from './services/updateApi'
import { uninstallMod } from './services/installMod'
import { installExternalLinkInterceptor } from './utils/externalLinks'
import { useTranslation } from 'react-i18next'
import APP_VERSION from './version.js'
import i18n from './i18n'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
  },
  appShell: {
    display: 'flex',
    flexDirection: 'row',
    flex: 1,
    backgroundColor: tokens.colorNeutralBackground2,
    overflow: 'hidden',
  },
  tabContent: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '8px',
  },
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
  },
})

const initialState = { isFirstRun: null, config: null }

function appReducer(state, action) {
  switch (action.type) {
    case 'INIT_COMPLETE':
      return { isFirstRun: false, config: action.config }
    case 'FIRST_RUN':
      return { isFirstRun: true, config: null }
    case 'WELCOME_COMPLETE':
      return { isFirstRun: false, config: action.config }
    case 'UPDATE_CONFIG':
      return { ...state, config: { ...state.config, ...action.config } }
    default:
      return state
  }
}

function App() {
  const styles = useStyles()
  const [selectedTab, setSelectedTab] = useState('mods')
  const [navTarget, setNavTarget] = useState(null)
  const { sidebarCollapsed, toggleSidebar } = usePersistUI()
  const [state, dispatch] = useReducer(appReducer, initialState)
  const [updateInfo, setUpdateInfo] = useState(null)
  // 主题模式：'light' | 'dark' | 'system'。默认跟随系统，启动后读取持久化配置覆盖。
  // 通过 class 名驱动 WinNavigationView 的自定义 CSS 变量，Fluent 组件则切换 webDarkTheme。
  const [themeMode, setThemeMode] = useState('system')
  // 系统是否处于深色模式（仅 themeMode === 'system' 时生效）
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  // 实际生效的主题：跟随系统模式下由系统偏好决定
  const resolvedTheme = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode

  // 监听系统主题变化，供"跟随系统"模式使用
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (e) => setSystemDark(e.matches)
    onChange(mq)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  // 选择主题模式（亮色/深色/跟随系统）并持久化到 config 表
  const handleSelectTheme = async (mode) => {
    if (!['light', 'dark', 'system'].includes(mode) || mode === themeMode) return
    const prev = themeMode
    setThemeMode(mode)
    try {
      await setConfig('theme_mode', mode)
    } catch (e) {
      console.error('Failed to persist theme mode:', e)
      // 保存失败时回滚 UI，避免界面声称已切换但重启后丢失
      setThemeMode(prev)
      alert(t('nav.themePersistFailed'))
    }
  }

  // 全局拦截外部链接点击：改用系统默认浏览器打开，避免 WebView 原地导航
  useEffect(() => {
    return installExternalLinkInterceptor()
  }, [])

  // 启动时检测更新（仅提示，不自动安装）
  useEffect(() => {
    let cancelled = false
    const doCheck = async () => {
      try {
        const info = await checkVersion(APP_VERSION)
        if (cancelled) return
        setUpdateInfo(info)
      } catch (e) {
        setUpdateInfo({ hasUpdate: false, error: e.message })
      }
    }
    doCheck()
    return () => { cancelled = true }
  }, [])

  // 启动时检查是否有待更新安装包，有则自动应用（仅已完成首次设置后）
  useEffect(() => {
    (async () => {
      try {
        const cfg = await getConfigs(['pending_update', 'initialized'])

        // 首次运行时不自动应用更新，避免在欢迎屏/设置流程中退出
        if (cfg.initialized !== 'true') return
        if (cfg.pending_update !== 'true') return

        // 关键：应用更新前先清除 pending_update 标志。
        // applyUpdate() 会调用 app_handle.exit(0) 终止当前进程，
        // 由 bat 脚本静默安装后重启。若不在此清标志，重启后的新进程
        // 仍会读到 pending_update='true' 并再次触发 applyUpdate()，
        // 形成"白屏 → 退出 → bat 弹窗 → 重启 → 白屏"的死循环。
        await setConfig('pending_update', 'false')

        await applyUpdate()
      } catch (e) {
        console.warn('[Update] 自动应用待更新失败:', e)
        // 失败后重置标志，避免每次启动都重试失败的更新
        try {
          await setConfig('pending_update', 'false')
        } catch (clearErr) {
          console.warn('[Update] 清除 pending_update 失败:', clearErr)
        }
      }
    })()
  }, [])

  useEffect(() => {
    let isMounted = true

    const initialize = async () => {
      try {
        const configMap = await getConfigs(['language', 'selected_tab', 'initialized', 'game_path', 'exe_path', 'theme_mode'])

        if (!isMounted) {
          return
        }

        // 应用已保存的主题模式（未保存时保持跟随系统）
        if (['light', 'dark', 'system'].includes(configMap.theme_mode)) {
          setThemeMode(configMap.theme_mode)
        }

        // 应用已保存的语言设置（在 dispatch 之前等待完成，避免 UI 渲染时语言正在切换）
        if (configMap.language) {
          try {
            await i18n.changeLanguage(configMap.language)
          } catch {
            // changeLanguage 失败不影响主流程
          }
        }

        // 旧版本把 模组/v1/v2 作为独立 tab 持久化；新版本统一收纳到 localmods
        const LEGACY_LOCAL_TABS = { mods: 'localmods', v1: 'localmods', v2: 'localmods' }
        // 旧版本 点赞/申请 独立 tab → 新版本统一收纳到 notify
        const LEGACY_NOTIFY_TABS = { likes: 'notify', apply: 'notify' }
        const validTabs = ['localmods', 'saves', 'import-export', 'workshop', 'notify', 'settings']
        let restoredTab = configMap.selected_tab
        if (LEGACY_LOCAL_TABS[restoredTab]) restoredTab = LEGACY_LOCAL_TABS[restoredTab]
        if (LEGACY_NOTIFY_TABS[restoredTab]) restoredTab = LEGACY_NOTIFY_TABS[restoredTab]
        if (restoredTab && validTabs.includes(restoredTab)) {
          setSelectedTab(restoredTab)
          // 旧值映射后回写持久化，避免每次启动都走映射
          if (configMap.selected_tab !== restoredTab) {
            setConfig('selected_tab', restoredTab).catch(() => {})
          }
        }

        if (configMap.initialized === 'true' || (configMap.game_path && configMap.exe_path)) {
          dispatch({ type: 'INIT_COMPLETE', config: { ...configMap, initialized: 'true' } })
        } else {
          dispatch({ type: 'FIRST_RUN' })
        }
      } catch (e) {
        console.error('Failed to initialize app:', e)
        if (isMounted) {
          dispatch({ type: 'FIRST_RUN' })
        }
      }
    }

    initialize()

    return () => {
      isMounted = false
    }
  }, [])

  const handleWelcomeComplete = async (configData) => {
    dispatch({ type: 'WELCOME_COMPLETE', config: configData })
  }

  const handleConfigChange = (configData) => {
    dispatch({ type: 'UPDATE_CONFIG', config: configData })
  }

  const handleTabChange = async (tab) => {
    setSelectedTab(tab)
    try {
      await setConfig('selected_tab', tab)
    } catch (e) {
      console.error('Failed to persist selected tab:', e)
    }
  }

  const { t } = useTranslation()
  const [uninstallTarget, setUninstallTarget] = useState(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [modListKey, setModListKey] = useState(0)

  const handleUninstallMod = (mod) => {
    setUninstallTarget(mod)
  }

  const confirmUninstall = async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      await uninstallMod({ modKey: uninstallTarget.name.replace(/\.\w+$/, '').replace(/\/$/, '') })
      setUninstallTarget(null)
      setModListKey(k => k + 1)
    } catch (e) {
      alert('退订失败: ' + e.message)
    } finally {
      setUninstalling(false)
    }
  }

  if (state.isFirstRun === null) {
    return (
      <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
        <div className={styles.loadingContainer}>
        </div>
      </FluentProvider>
    )
  }

  if (state.isFirstRun) {
    return (
      <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
        <div className={styles.root}>
          <TitleBar />
          <WelcomeScreen onComplete={handleWelcomeComplete} />
        </div>
      </FluentProvider>
    )
  }

  return (
    <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
      <AuthProvider>
        <UserNavProvider onOpenMod={(modId) => {
          window.location.hash = `#/mod/${modId}`
          setNavTarget({ modId, commentId: null })
          handleTabChange('workshop')
        }}>
        <NotificationProvider>
          <div className={styles.root}>
          <TitleBar />
          <div className={styles.appShell}>
            <TabNavigation
             value={selectedTab}
             onChange={handleTabChange}
             isCollapsed={sidebarCollapsed}
             onToggleCollapse={toggleSidebar}
             updateInfo={updateInfo}
             themeMode={themeMode}
             onSelectTheme={handleSelectTheme}
             onNavigateToSettings={() => handleTabChange('settings')}
           >
            <main className={styles.tabContent}>
              {selectedTab === 'localmods' && <LocalMods key={`localmods-${state.config?.game_path || ''}-${modListKey}`} config={state.config} onUninstall={handleUninstallMod} />}
              {selectedTab === 'saves' && <SaveManagement config={state.config} />}
              {selectedTab === 'import-export' && <ImportExport config={state.config} />}
              {selectedTab === 'workshop' && <Workshop initialModId={navTarget?.modId} initialCommentId={navTarget?.commentId} onConsumeNavTarget={() => setNavTarget(null)} />}
              {selectedTab === 'notify' && <NotifyPage onNavigate={(entity, targetId, commentId) => {
                if (entity === 'discussion') {
                  // 讨论区通知：设置 #/discuss/<id>?comment=<cid>，Workshop hashchange 自动切到讨论区并打开对应楼层
                  window.location.hash = commentId ? `#/discuss/${targetId}?comment=${commentId}` : `#/discuss/${targetId}`
                  handleTabChange('workshop')
                } else {
                  // mod 通知：同步写入 #/mod/<id> hash（BrowseMods 从 hash 恢复详情），
                  // 避免残留上次讨论区的 #/discuss/ hash 导致刷新/挂载时 tab 恢复错乱
                  window.location.hash = commentId ? `#/mod/${targetId}?comment=${commentId}` : `#/mod/${targetId}`
                  setNavTarget({ modId: targetId, commentId })
                  handleTabChange('workshop')
                }
              }} />}
              {selectedTab === 'settings' && <GameSettings config={state.config} onConfigChange={handleConfigChange} appUpdateInfo={updateInfo} />}
            </main>
          </TabNavigation>
          </div>
        </div>
        </NotificationProvider>
        </UserNavProvider>

        <Dialog open={!!uninstallTarget} onOpenChange={(_, { open }) => !open && setUninstallTarget(null)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{t('workshop.confirmUninstall')}</DialogTitle>
              <DialogContent>
                <Text size="small">{t('workshop.uninstallHint')}</Text>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button size="small" appearance="subtle">{t('workshop.cancel')}</Button>
                </DialogTrigger>
                <Button size="small" appearance="primary" onClick={confirmUninstall} disabled={uninstalling}>
                  {uninstalling ? t('workshop.processing') : t('workshop.uninstall')}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

      </AuthProvider>
    </FluentProvider>
  )
}

export default App