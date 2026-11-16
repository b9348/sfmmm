import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles, tokens } from '@fluentui/react-components'
import {
  BoxMultiple24Regular,
  Folder24Regular,
  DocumentFolder24Regular,
  Save24Regular,
} from '@fluentui/react-icons'
import { MissionFolder } from '../missions'
import { SaveManagement } from '../saves'
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
  // 窄屏的汉堡按钮和四个页签并排放在这一行里
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
    // 窄窗口（≈移动端宽度）适配：页签不换行也不收缩，放不下会把整页撑出横向滚动，
    // 改成页签条自己横向滑动 + 细滚动条兜底
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

// 子 tab → MissionFolder 的游戏目录子文件夹映射
const SUBFOLDER_BY_TAB = {
  mods: 'BepInEx/plugins',
  v1: 'CustomMissions',
  v2: 'CustomMissions2',
}

/**
 * 本地模组页：内部 TabList 收纳 [模组, v1, v2] 三个 tab，
 * 与创意工坊页同构（hash 路由 #/localmods/<tab>，侧边栏分组子菜单联动）。
 * 仅挂载当前 tab 对应的 MissionFolder（切 tab 用 key 隔离状态）。
 */
export function LocalMods({ config, onUninstall, refreshKey }) {
  const { t } = useTranslation()
  const styles = useStyles()
  // 窄屏（≈移动端宽度）：页签去掉图标并用 small 尺寸，四个页签在 375px 下能排满一行
  const isNarrow = useMediaQuery('(max-width: 768px)')

  // 从 URL hash 恢复 tab（Ctrl+R 刷新后保持）
  const getInitialTab = () => {
    const m = window.location.hash.match(/^#\/localmods\/(\w+)/)
    return m && ['mods', 'v1', 'v2', 'saves'].includes(m[1]) ? m[1] : 'mods'
  }
  // 从 URL hash 恢复待定位 mod_key（#/localmods/<tab>?mod=<key>，订阅记录跳转携带）
  const getFocusModKey = () => {
    const m = window.location.hash.match(/[?&]mod=([^&]+)/)
    return m ? decodeURIComponent(m[1]) : null
  }
  const [subTab, setSubTab] = useState(getInitialTab)
  const [focusModKey, setFocusModKey] = useState(getFocusModKey)

  const handleTabSelect = (_, d) => {
    setSubTab(d.value)
    window.location.hash = `#/localmods/${d.value}`
  }

  // 初始化时同步一次 hash（可能被其他组件覆盖）
  useEffect(() => {
    const tab = getInitialTab()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab !== subTab) setSubTab(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 侧边栏「本地模组」子菜单点击会设置 hash（#/localmods/<tab>），
  // 监听 hashchange 同步内部 tab 与待定位 mod_key（外部跳转可携带 ?mod=<key>）。
  useEffect(() => {
    const onHashChange = () => {
      const tab = getInitialTab()
      setSubTab((prev) => (tab !== prev ? tab : prev))
      setFocusModKey(getFocusModKey())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // 页签条窄窗口下靠横向滑动展示全部页签：切页后把当前页签滚回可视区
  // （与创意工坊/提醒页同一套兜底，避免激活项停在屏幕外）
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
          <Tab value="mods" icon={isNarrow ? undefined : <BoxMultiple24Regular />}>{t('nav.mods')}</Tab>
          <Tab value="v1" icon={isNarrow ? undefined : <Folder24Regular />}>{t('nav.v1')}</Tab>
          <Tab value="v2" icon={isNarrow ? undefined : <DocumentFolder24Regular />}>{t('nav.v2')}</Tab>
          <Tab value="saves" icon={isNarrow ? undefined : <Save24Regular />}>{t('nav.saves')}</Tab>
        </TabList>
      </div>

      <div className={styles.content}>
        {subTab === 'saves' ? (
          <SaveManagement />
        ) : (
          <MissionFolder
            key={`localmods-${subTab}-${config?.game_path || ''}-${refreshKey || 0}`}
            config={config}
            subfolder={SUBFOLDER_BY_TAB[subTab]}
            onUninstall={onUninstall}
            focusModKey={focusModKey}
          />
        )}
      </div>
    </div>
  )
}

export default LocalMods
