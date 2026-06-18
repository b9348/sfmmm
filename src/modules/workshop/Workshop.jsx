import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles } from '@fluentui/react-components'
import { Cloud24Regular, Person24Regular } from '@fluentui/react-icons'
import { BrowseMods } from './BrowseMods'
import { MyMods } from './MyMods'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    gap: '8px',
  },
  tabs: {
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    position: 'relative',
  },
  tabContent: {
    height: '100%',
  },
  tabHidden: {
    display: 'none',
  },
})

export function Workshop() {
  const { t } = useTranslation()
  const styles = useStyles()

  // 从 URL hash 恢复 tab（Ctrl+R 刷新后保持）
  const getInitialTab = () => {
    const m = window.location.hash.match(/^#\/workshop\/(\w+)/)
    return m && ['browse', 'my'].includes(m[1]) ? m[1] : 'browse'
  }
  const [subTab, setSubTab] = useState(getInitialTab)

  const handleTabSelect = (_, d) => {
    setSubTab(d.value)
    window.location.hash = `#/workshop/${d.value}`
  }

  // 初始化时同步一次 hash（可能被其他组件覆盖）
  useEffect(() => {
    const tab = getInitialTab()
    if (tab !== subTab) setSubTab(tab)
  }, [])

  return (
    <div className={styles.root}>
      <TabList
        className={styles.tabs}
        selectedValue={subTab}
        onTabSelect={handleTabSelect}
      >
        <Tab value="browse" icon={<Cloud24Regular />}>{t('workshop.cloud')}</Tab>
        <Tab value="my" icon={<Person24Regular />}>{t('workshop.mine')}</Tab>
      </TabList>

      <div className={styles.content}>
        <div className={`${styles.tabContent}${subTab !== 'browse' ? ` ${styles.tabHidden}` : ''}`}>
          <BrowseMods />
        </div>
        <div className={`${styles.tabContent}${subTab !== 'my' ? ` ${styles.tabHidden}` : ''}`}>
          <MyMods />
        </div>
      </div>
    </div>
  )
}
