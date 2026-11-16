import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles, tokens } from '@fluentui/react-components'
import {
  Heart24Regular,
  Star24Regular,
  PersonAccounts24Regular,
  Comment24Regular,
  Mail24Regular,
} from '@fluentui/react-icons'
import { LikeRecords } from '../likes/LikeRecords'
import ApplicationsPage from '../workshop/ApplicationsPage'
import MessageInbox from './MessageInbox'
import { useTabPrefetch } from '../../hooks/useTabPrefetch'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { NarrowMenuButton } from '../../components/common/NarrowMenuButton'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    gap: '8px',
  },
  // 窄屏的汉堡按钮和五个页签并排放在这一行里
  tabsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    minWidth: 0,
  },
  tabs: {
    flex: '1 1 auto',
    minWidth: 0,
    // 窄窗口（≈移动端宽度）适配：五个页签不换行也不收缩，放不下会把整页撑出横向滚动。
    // 改成页签条自己横向滑动 + 细滚动条，任何宽度都能切到全部页签。
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
    '&::-webkit-scrollbar': {
      height: '4px',
    },
    '&::-webkit-scrollbar-thumb': {
      backgroundColor: tokens.colorNeutralStroke1,
      borderRadius: '2px',
    },
    '&::-webkit-scrollbar-track': {
      backgroundColor: 'transparent',
    },
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    position: 'relative',
  },
})

const TABS = ['replies', 'apps', 'likes', 'rates', 'inbox']

/**
 * 通知页：内部 TabList 收纳 [回复, 申请, 点赞, 评分, 站内信] 五个 tab，
 * 与创意工坊/本地模组同构（hash 路由 #/notify/<tab>，侧边栏分组子菜单联动）。
 * 默认仍是回复；站内信复用 MessageInbox，申请/回复复用 ApplicationsPage（panel 单 section）。
 * 通过 useTabPrefetch 预加载下一个 tab（回复→申请→点赞→评分→站内信），切换即时展示。
 */
export function NotifyPage({ onNavigate }) {
  const { t } = useTranslation()
  const styles = useStyles()
  // 窄屏（≈移动端宽度）：五个页签去掉图标并用 small 尺寸，375px 下能排满一行，
  // 不再依赖横向滑动去翻“看不见”的页签（滑动仍保留为兜底）
  const isNarrow = useMediaQuery('(max-width: 768px)')

  // 从 URL hash 恢复 tab（Ctrl+R 刷新后保持）
  const getInitialTab = () => {
    const m = window.location.hash.match(/^#\/notify\/(\w+)/)
    return m && TABS.includes(m[1]) ? m[1] : 'replies'
  }
  const [subTab, setSubTab] = useState(getInitialTab)
  // 预加载链：当前 tab 激活时预挂载下一个 tab（回复→申请→点赞→评分→站内信），切换即时展示
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

  // 页签条窄窗口下靠横向滑动展示全部页签：切页后把当前页签滚回可视区
  const tabsRef = useRef(null)
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [subTab])

  return (
    <div className={styles.root}>
      <div className={styles.tabsRow}>
        <NarrowMenuButton />
        <TabList
          ref={tabsRef}
          className={styles.tabs}
          size={isNarrow ? 'small' : 'medium'}
          selectedValue={subTab}
          onTabSelect={handleTabSelect}
        >
          <Tab value="replies" icon={isNarrow ? undefined : <Comment24Regular />}>{t('nav.replies')}</Tab>
          <Tab value="apps" icon={isNarrow ? undefined : <PersonAccounts24Regular />}>{t('nav.apps')}</Tab>
          <Tab value="likes" icon={isNarrow ? undefined : <Heart24Regular />}>{t('nav.likes')}</Tab>
          <Tab value="rates" icon={isNarrow ? undefined : <Star24Regular />}>{t('nav.rates')}</Tab>
          <Tab value="inbox" icon={isNarrow ? undefined : <Mail24Regular />}>{t('nav.inbox')}</Tab>
        </TabList>
      </div>

      <div className={styles.content}>
        {TABS.map((tab) => {
          // 未挂载（含未预加载）的 tab 不渲染；已挂载的保持挂载，仅切换显隐
          if (!mounted.has(tab)) return null
          let content
          const visible = tab === subTab
          if (tab === 'likes') content = <LikeRecords panel="liked" visible={visible} />
          else if (tab === 'rates') content = <LikeRecords panel="rated" visible={visible} />
          else if (tab === 'inbox') content = <MessageInbox visible={visible} />
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
