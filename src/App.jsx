import { useState } from 'react'
import { FluentProvider, webLightTheme } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'
import { Header, TabNavigation } from './components/layout'
import { ModList, SaveManagement, ImportExport, GameSettings } from './modules'

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
})

function App() {
  const styles = useStyles()
  const [selectedTab, setSelectedTab] = useState('mods')

  return (
    <FluentProvider theme={webLightTheme}>
      <div className={styles.appShell}>
        <Header />
        <TabNavigation value={selectedTab} onChange={setSelectedTab} />
        <main className={styles.tabContent}>
          {selectedTab === 'mods' && <ModList />}
          {selectedTab === 'saves' && <SaveManagement />}
          {selectedTab === 'import-export' && <ImportExport />}
          {selectedTab === 'settings' && <GameSettings />}
        </main>
      </div>
    </FluentProvider>
  )
}

export default App