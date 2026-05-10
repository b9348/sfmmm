import { useState, useEffect, useReducer } from 'react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'
import { TabNavigation, WelcomeScreen } from './components'
import { ModList, SaveManagement, ImportExport, GameSettings } from './modules'
import Database from '@tauri-apps/plugin-sql'

const useStyles = makeStyles({
  appShell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
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
  const [state, dispatch] = useReducer(appReducer, initialState)

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
      <div className={styles.appShell}>
        <TabNavigation value={selectedTab} onChange={setSelectedTab} />
        <main className={styles.tabContent}>
          {selectedTab === 'mods' && <ModList config={state.config} />}
          {selectedTab === 'saves' && <SaveManagement config={state.config} />}
          {selectedTab === 'import-export' && <ImportExport config={state.config} />}
          {selectedTab === 'settings' && <GameSettings config={state.config} onConfigChange={handleConfigChange} />}
        </main>
      </div>
    </FluentProvider>
  )
}

export default App