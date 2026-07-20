import { useState, useEffect, useReducer } from 'react'
import { FluentProvider, webLightTheme, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger, Button, Text } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'
import { TabNavigation, WelcomeScreen, TitleBar } from './components'
import { ModList, SaveManagement, ImportExport, GameSettings, Workshop, MissionFolder, ApplicationsPage } from './modules'
import { AuthProvider } from './contexts/AuthContext.jsx'
import { NotificationProvider } from './contexts/NotificationContext'
import { usePersistUI } from './hooks/usePersistUI'
import { getDb, getConfigs, setConfig } from './services/dbHelper'
import { checkVersion, applyUpdate } from './services/updateApi'
import { uninstallMod } from './services/installMod'
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
  const [updateInfo, setUpdateInfo] = useState({ hasUpdate: false })

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
        const configMap = await getConfigs(['language', 'selected_tab', 'initialized', 'game_path', 'exe_path'])

        if (!isMounted) {
          return
        }

        // 应用已保存的语言设置（在 dispatch 之前等待完成，避免 UI 渲染时语言正在切换）
        if (configMap.language) {
          try {
            await i18n.changeLanguage(configMap.language)
          } catch {
            // changeLanguage 失败不影响主流程
          }
        }

        const validTabs = ['mods', 'v1', 'v2', 'saves', 'import-export', 'workshop', 'apply', 'settings']
        if (configMap.selected_tab && validTabs.includes(configMap.selected_tab)) {
          setSelectedTab(configMap.selected_tab)
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
      <FluentProvider theme={webLightTheme}>
        <div className={styles.loadingContainer}>
        </div>
      </FluentProvider>
    )
  }

  if (state.isFirstRun) {
    return (
      <FluentProvider theme={webLightTheme}>
        <WelcomeScreen onComplete={handleWelcomeComplete} />
      </FluentProvider>
    )
  }

  return (
    <FluentProvider theme={webLightTheme}>
      <AuthProvider>
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
             onNavigateToSettings={() => handleTabChange('settings')}
           />
            <main className={styles.tabContent}>
              {selectedTab === 'mods' && <ModList key={modListKey} config={state.config} onUninstall={handleUninstallMod} />}
              {selectedTab === 'v1' && <MissionFolder key={`v1-${state.config?.game_path || ''}`} config={state.config} subfolder="CustomMissions" onUninstall={handleUninstallMod} />}
              {selectedTab === 'v2' && <MissionFolder key={`v2-${state.config?.game_path || ''}`} config={state.config} subfolder="CustomMissions2" onUninstall={handleUninstallMod} />}
              {selectedTab === 'saves' && <SaveManagement config={state.config} />}
              {selectedTab === 'import-export' && <ImportExport config={state.config} />}
              {selectedTab === 'workshop' && <Workshop initialModId={navTarget?.modId} initialCommentId={navTarget?.commentId} />}
              {selectedTab === 'apply' && <ApplicationsPage onNavigate={(modId, commentId) => {
                setNavTarget({ modId, commentId })
                handleTabChange('workshop')
              }} />}
              {selectedTab === 'settings' && <GameSettings config={state.config} onConfigChange={handleConfigChange} />}
            </main>
          </div>
        </div>
        </NotificationProvider>

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