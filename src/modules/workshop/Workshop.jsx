import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles, tokens } from '@fluentui/react-components'
import { Cloud24Regular, Person24Regular, ArrowSync24Regular, Comment24Regular } from '@fluentui/react-icons'
import { BrowseMods } from './BrowseMods'
import { MyMods } from './MyMods'
import { Discussion } from './Discussion'
import SubscriptionRecords from '../subscribe/SubscriptionRecords'
import { useTabPrefetch } from '../../hooks/useTabPrefetch'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { NarrowMenuButton } from '../../components/common/NarrowMenuButton'
import { AnnouncementBanner } from '../../components/announcement/AnnouncementBanner'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    gap: '8px',
  },
  // 窄屏的汉堡按钮和页签并排放在这一行里（宽屏按钮不渲染，等价于只有页签）
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
    // 窄窗口（≈移动端宽度）适配：Tab 自身 flex-shrink:0、页签条更是不换行，
    // 放不下时会把整页撑出横向滚动。改成页签条自己横向滑动 + 细滚动条，
    // 任何宽度下都能切到全部页签，页面本身不横向溢出。
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
  // 窄屏（≈移动端宽度）：页签条去掉图标、碎化尺寸，四个页签在 375px 下能排满一行，
  // 不再依赖横向滑动去翻看不到的页签（滑动仍保留为兜底）
  const isNarrow = useMediaQuery('(max-width: 768px)')

  // 窄屏：mod/讨论详情以覆盖层打开时，顶部 tabs 行整行收起来（整屏给正文）。
  // 记下是哪个 tab 打开了详情：详情开着时切到「我的/订阅」，那两个页面仍要有 tabs 行。
  // 详情页自己不放汉堡按钮（按需求，窄屏详情靠顶部返回按钮出栈），
  // 所以详情展开期间侧栏抽屉是暂时唤不出来的。
  const [detailOpenIn, setDetailOpenIn] = useState(null)
  const handleBrowseDetail = useCallback((open) => {
    setDetailOpenIn((prev) => (open ? 'browse' : (prev === 'browse' ? null : prev)))
  }, [])
  const handleDiscussDetail = useCallback((open) => {
    setDetailOpenIn((prev) => (open ? 'discuss' : (prev === 'discuss' ? null : prev)))
  }, [])
  const handleMyDetail = useCallback((open) => {
    setDetailOpenIn((prev) => (open ? 'my' : (prev === 'my' ? null : prev)))
  }, [])

  // 从 URL hash 恢复 tab（Ctrl+R 刷新后保持）；
  // 讨论详情跳转使用 #/discuss/<id>?comment=<cid> 前缀，也归入 discuss tab
  const getInitialTab = () => {
    if (/^#\/discuss\//.test(window.location.hash)) return 'discuss'
    const m = window.location.hash.match(/^#\/workshop\/(\w+)/)
    return m && ['browse', 'my', 'records', 'discuss'].includes(m[1]) ? m[1] : 'browse'
  }
  const [subTab, setSubTab] = useState(getInitialTab)
  // 窄屏且当前 tab 上正开着详情 → 收起 tabs 行（含汉堡），整屏让给详情
  const hideTabsRow = isNarrow && detailOpenIn === subTab
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

  // 页签条在窄窗口下要靠横向滑动才能看到全部页签，因此切页后（含侧栏子菜单、
  // 通知跳转这类程序化切换）把当前页签滚回可视区，避免激活项停在屏幕外
  const tabsRef = useRef(null)
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [subTab])

  return (
    <div className={styles.root}>
      <AnnouncementBanner />
      {!hideTabsRow && (
      <div className={styles.tabsRow}>
        <NarrowMenuButton />
        <TabList
          ref={tabsRef}
          className={styles.tabs}
          size={isNarrow ? 'small' : 'medium'}
          selectedValue={subTab}
          onTabSelect={handleTabSelect}
        >
          <Tab value="browse" icon={isNarrow ? undefined : <Cloud24Regular />}>{t('workshop.cloud')}</Tab>
          <Tab value="discuss" icon={isNarrow ? undefined : <Comment24Regular />}>
            <span className={styles.tabLabel}>
              {t('nav.discuss')}
              {/* 蓝点：仅「缓存比对出有新帖且尚未打开过讨论区」时出现 */}
              <span className={styles.unreadSlot} aria-hidden="true">
                {discussUnreadState && <span className={styles.unreadDot} />}
              </span>
            </span>
          </Tab>
          <Tab value="my" icon={isNarrow ? undefined : <Person24Regular />}>{t('workshop.mine')}</Tab>
          <Tab value="records" icon={isNarrow ? undefined : <ArrowSync24Regular />}>{t('nav.subscriptions')}</Tab>
        </TabList>
      </div>
      )}

      <div className={styles.content}>
        {TABS.map((tab) => {
          // 未挂载（含未预加载）的 tab 不渲染；已挂载的保持挂载，仅切换显隐
          if (!mounted.has(tab)) return null
          const visible = tab === subTab
          let content
          if (tab === 'browse') content = <BrowseMods active={visible} initialModId={initialModId} initialCommentId={initialCommentId} onConsumeNavTarget={onConsumeNavTarget} onDetailOpenChange={handleBrowseDetail} />
          else if (tab === 'discuss') content = <Discussion active={visible} onNewContent={markDiscussUnread} onDetailOpenChange={handleDiscussDetail} />
          else if (tab === 'my') content = <MyMods active={visible} onDetailOpenChange={handleMyDetail} />
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
