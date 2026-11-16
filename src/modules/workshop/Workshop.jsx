import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles, tokens } from '@fluentui/react-components'
import { Cloud24Regular, Person24Regular, ArrowSync24Regular, Comment24Regular } from '@fluentui/react-icons'
import { BrowseMods } from './BrowseMods'
import { MyMods } from './MyMods'
import { Discussion } from './Discussion'
import SubscriptionRecords from '../subscribe/SubscriptionRecords'
import { useTabPrefetch } from '../../hooks/useTabPrefetch'
import { AnnouncementBanner } from '../../components/announcement/AnnouncementBanner'

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
  tabLabel: {
    display: 'inline-flex',
    alignItems: 'center',
  },
  // 蓝点固定占位：出现/消失都不改变 tab 宽度，不挤动其余页签
  unreadSlot: {
    width: '10px',
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: tokens.colorBrandBackground,
  },
})

// tab 顺序即预加载链：当前 tab 激活时预挂载下一个（云→讨论→我的→订阅）
const TABS = ['browse', 'discuss', 'my', 'records']

// 「讨论区有新帖」标记：只有打开过一次讨论区才清除。
// 放模块级变量而非组件 state —— 离开创意工坊时 Workshop 会卸载，
// 用 state 的话回来蓝点就没了；应用重启后重置（重启后缓存已是最新，会重新比对）。
let discussUnread = false

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
  // 讨论区新帖蓝点：与模块级标记同步，跨页面切换保留。
  // 直接落在讨论区（hash 就是讨论区/详情）时不算未读，顺手清掉标记。
  const [discussUnreadState, setDiscussUnreadState] = useState(() => {
    if (getInitialTab() === 'discuss') {
      discussUnread = false
      return false
    }
    return discussUnread
  })
  const markDiscussRead = useCallback(() => {
    discussUnread = false
    setDiscussUnreadState(false)
  }, [])
  const markDiscussUnread = useCallback(() => {
    // 用户已经切到讨论区（hash 已过去）就不再提示，避免点开后才到达的
    // 后台刷新结果又把蓝点点回去
    if (getInitialTab() !== 'discuss') {
      discussUnread = true
      setDiscussUnreadState(true)
    }
  }, [])
  // 预加载链：当前 tab 激活时预挂载下一个 tab（云→讨论→我的→订阅），切换即时展示
  const { mounted } = useTabPrefetch(subTab, TABS)

  const handleTabSelect = (_, d) => {
    // 打开过一次讨论区即清除新帖蓝点
    if (d.value === 'discuss') markDiscussRead()
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
      // 侧栏子菜单 / 通知跳转直接落到讨论区，同样算「打开过讨论区」
      if (tab === 'discuss') markDiscussRead()
      setSubTab((prev) => (tab !== prev ? tab : prev))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [markDiscussRead])

  return (
    <div className={styles.root}>
      <AnnouncementBanner />
      <TabList
        className={styles.tabs}
        selectedValue={subTab}
        onTabSelect={handleTabSelect}
      >
        <Tab value="browse" icon={<Cloud24Regular />}>{t('workshop.cloud')}</Tab>
        <Tab value="discuss" icon={<Comment24Regular />}>
          <span className={styles.tabLabel}>
            {t('nav.discuss')}
            {/* 蓝点：仅「缓存比对出有新帖且尚未打开过讨论区」时出现 */}
            <span className={styles.unreadSlot} aria-hidden="true">
              {discussUnreadState && <span className={styles.unreadDot} />}
            </span>
          </span>
        </Tab>
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
          else if (tab === 'discuss') content = <Discussion active={visible} onNewContent={markDiscussUnread} />
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
