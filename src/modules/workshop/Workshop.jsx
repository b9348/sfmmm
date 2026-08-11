import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles } from '@fluentui/react-components'
import { Cloud24Regular, Person24Regular, ArrowSync24Regular } from '@fluentui/react-icons'
import { BrowseMods } from './BrowseMods'
import { MyMods } from './MyMods'
import SubscriptionRecords from '../subscribe/SubscriptionRecords'

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

export function Workshop({ initialModId, initialCommentId, onConsumeNavTarget }) {
  const { t } = useTranslation()
  const styles = useStyles()

  // 从 URL hash 恢复 tab（Ctrl+R 刷新后保持）
  const getInitialTab = () => {
    const m = window.location.hash.match(/^#\/workshop\/(\w+)/)
    return m && ['browse', 'my', 'records'].includes(m[1]) ? m[1] : 'browse'
  }
  const [subTab, setSubTab] = useState(getInitialTab)

  const handleTabSelect = (_, d) => {
    setSubTab(d.value)
    window.location.hash = `#/workshop/${d.value}`
  }

  // 初始化时同步一次 hash（可能被其他组件覆盖）
  useEffect(() => {
    const tab = getInitialTab()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab !== subTab) setSubTab(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部跳转进入 mod 详情页（如订阅记录页的云 icon、用户资料弹窗），
  // App.jsx 设 hash 为 #/mod/<id> 并切到 workshop tab；
  // 这里监听 initialModId，强制把 subTab 切到 browse，BrowseMods 才会按 modKey 拉详情。
  useEffect(() => {
    if (initialModId === undefined || initialModId === null) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSubTab('browse')
  }, [initialModId])

  // 侧边栏「创意工坊」子菜单点击会设置 hash（#/workshop/<tab>），
  // 监听 hashchange 同步内部 tab，保证已在本页时也能切换。
  useEffect(() => {
    const onHashChange = () => {
      const tab = getInitialTab()
      setSubTab((prev) => (tab !== prev ? tab : prev))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
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
        <Tab value="records" icon={<ArrowSync24Regular />}>{t('nav.subscriptions')}</Tab>
      </TabList>

      <div className={styles.content}>
        <div className={`${styles.tabContent}${subTab !== 'browse' ? ` ${styles.tabHidden}` : ''}`}>
          <BrowseMods initialModId={initialModId} initialCommentId={initialCommentId} onConsumeNavTarget={onConsumeNavTarget} />
        </div>
        <div className={`${styles.tabContent}${subTab !== 'my' ? ` ${styles.tabHidden}` : ''}`}>
          <MyMods />
        </div>
        <div className={`${styles.tabContent}${subTab !== 'records' ? ` ${styles.tabHidden}` : ''}`}>
          <SubscriptionRecords />
        </div>
      </div>
    </div>
  )
}
