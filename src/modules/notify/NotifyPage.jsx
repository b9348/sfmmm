import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles } from '@fluentui/react-components'
import {
  Heart24Regular,
  Star24Regular,
  PersonAccounts24Regular,
  Comment24Regular,
} from '@fluentui/react-icons'
import { LikeRecords } from '../likes/LikeRecords'
import ApplicationsPage from '../workshop/ApplicationsPage'
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
})

const TABS = ['replies', 'apps', 'likes', 'rates']

/**
 * 通知页：内部 TabList 收纳 [回复, 申请, 点赞, 评分] 四个 tab，
 * 与创意工坊/本地模组同构（hash 路由 #/notify/<tab>，侧边栏分组子菜单联动）。
 * 点赞/评分复用 LikeRecords（panel 单栏），申请/回复复用 ApplicationsPage（panel 单 section）。
 * 通过 useTabPrefetch 预加载下一个 tab（回复→申请→点赞→评分），切换即时展示。
 */
export function NotifyPage({ onNavigate }) {
  const { t } = useTranslation()
  const styles = useStyles()

  // 从 URL hash 恢复 tab（Ctrl+R 刷新后保持）
  const getInitialTab = () => {
    const m = window.location.hash.match(/^#\/notify\/(\w+)/)
    return m && TABS.includes(m[1]) ? m[1] : 'replies'
  }
  const [subTab, setSubTab] = useState(getInitialTab)
  // 预加载链：当前 tab 激活时预挂载下一个 tab（回复→申请→点赞→评分），切换即时展示
  const { mounted } = useTabPrefetch(subTab, TABS)

  const handleTabSelect = (_, d) => {
    setSubTab(d.value)
    window.location.hash = `#/notify/${d.value}`
  }

  // 初始化时同步一次 hash（可能被其他组件覆盖）
  useEffect(() => {
    const tab = getInitialTab()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab !== subTab) setSubTab(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 侧边栏「通知」子菜单点击会设置 hash（#/notify/<tab>），
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
        <Tab value="replies" icon={<Comment24Regular />}>{t('nav.replies')}</Tab>
        <Tab value="apps" icon={<PersonAccounts24Regular />}>{t('nav.apps')}</Tab>
        <Tab value="likes" icon={<Heart24Regular />}>{t('nav.likes')}</Tab>
        <Tab value="rates" icon={<Star24Regular />}>{t('nav.rates')}</Tab>
      </TabList>

      <div className={styles.content}>
        {TABS.map((tab) => {
          // 未挂载（含未预加载）的 tab 不渲染；已挂载的保持挂载，仅切换显隐
          if (!mounted.has(tab)) return null
          let content
          const visible = tab === subTab
          if (tab === 'likes') content = <LikeRecords panel="liked" visible={visible} />
          else if (tab === 'rates') content = <LikeRecords panel="rated" visible={visible} />
          else if (tab === 'apps') content = <ApplicationsPage panel="apps" onNavigate={onNavigate} visible={visible} />
          else content = <ApplicationsPage panel="notifs" onNavigate={onNavigate} visible={visible} />
          return (
            <div
              key={tab}
              style={{ display: tab === subTab ? undefined : 'none', height: '100%' }}
            >
              {content}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default NotifyPage
