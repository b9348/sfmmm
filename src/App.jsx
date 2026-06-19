import { useState, useEffect, useReducer } from 'react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'
import { TabNavigation, WelcomeScreen, TitleBar } from './components'
import { ModList, SaveManagement, ImportExport, GameSettings, Workshop, MissionFolder, ApplicationsPage } from './modules'
import { AuthProvider } from './contexts/AuthContext'
import { NotificationProvider } from './contexts/NotificationContext'
import { usePersistUI } from './hooks/usePersistUI'
import Database from '@tauri-apps/plugin-sql'
import { checkVersion } from './services/updateApi'
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

  useEffect(() => {
    let isMounted = true

    const initialize = async () => {
      try {
        const db = await Database.load('sqlite:config.db')
        const rows = await db.select(`SELECT ` + "`key`" + `, value FROM config`)

        if (!isMounted) {
          return
        }

        const configMap = {}
        rows.forEach(row => {
          configMap[row.key] = row.value
        })

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
      const db = await Database.load('sqlite:config.db')
      await db.execute(
        `INSERT OR REPLACE INTO config (id, ` + "`key`" + `, value) VALUES ((SELECT id FROM config WHERE ` + "`key`" + ` = $1), $1, $2)`,
        ['selected_tab', tab]
      )
    } catch (e) {
      console.error('Failed to persist selected tab:', e)
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
              {selectedTab === 'mods' && <ModList config={state.config} />}
              {selectedTab === 'v1' && <MissionFolder config={state.config} subfolder="CustomMissions" />}
              {selectedTab === 'v2' && <MissionFolder config={state.config} subfolder="CustomMissions2" />}
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
      </AuthProvider>
    </FluentProvider>
  )
}

export default App