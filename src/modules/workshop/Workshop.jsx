import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles } from '@fluentui/react-components'
import { Cloud24Regular, Person24Regular, ArrowSync24Regular, Comment24Regular } from '@fluentui/react-icons'
import { BrowseMods } from './BrowseMods'
import { MyMods } from './MyMods'
import { Discussion } from './Discussion'
import SubscriptionRecords from '../subscribe/SubscriptionRecords'
import { useTabPrefetch } from '../../hooks/useTabPrefetch'

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

// tab 顺序即预加载链：当前 tab 激活时预挂载下一个（云→讨论→我的→订阅）
const TABS = ['browse', 'discuss', 'my', 'records']

export function Workshop({ initialModId, initialCommentId, onConsumeNavTarget }) {
  const { t } = useTranslation()
  const styles = useStyles()

  // 从 URL hash 恢复 tab（Ctrl+R 刷新后保持）；
  // 讨论详情跳转使用 #/discuss/<id>?comment=<cid> 前缀，也归入 discuss tab
  const getInitialTab = () => {
    if (/^#\/discuss\//.test(window.location.hash)) return 'discuss'
    const m = window.location.hash.match(/^#\/workshop\/(\w+)/)
    return m && ['browse', 'my', 'records', 'discuss'].includes(m[1]) ? m[1] : 'browse'
  }
  const [subTab, setSubTab] = useState(getInitialTab)
  // 预加载链：当前 tab 激活时预挂载下一个 tab（云→讨论→我的→订阅），切换即时展示
  const { mounted } = useTabPrefetch(subTab, TABS)

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
        <Tab value="discuss" icon={<Comment24Regular />}>{t('nav.discuss')}</Tab>
        <Tab value="my" icon={<Person24Regular />}>{t('workshop.mine')}</Tab>
        <Tab value="records" icon={<ArrowSync24Regular />}>{t('nav.subscriptions')}</Tab>
      </TabList>

      <div className={styles.content}>
        {TABS.map((tab) => {
          // 未挂载（含未预加载）的 tab 不渲染；已挂载的保持挂载，仅切换显隐
          if (!mounted.has(tab)) return null
          const visible = tab === subTab
          let content
          if (tab === 'browse') content = <BrowseMods active={visible} initialModId={initialModId} initialCommentId={initialCommentId} onConsumeNavTarget={onConsumeNavTarget} />
          else if (tab === 'discuss') content = <Discussion active={visible} />
          else if (tab === 'my') content = <MyMods active={visible} />
          else content = <SubscriptionRecords active={visible} />
          return (
            <div
              key={tab}
              className={`${styles.tabContent}${visible ? '' : ` ${styles.tabHidden}`}`}
            >
              {content}
            </div>
          )
        })}
      </div>
    </div>
  )
}
