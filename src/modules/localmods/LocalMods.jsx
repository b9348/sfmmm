import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TabList, Tab, makeStyles } from '@fluentui/react-components'
import {
  BoxMultiple24Regular,
  Folder24Regular,
  DocumentFolder24Regular,
} from '@fluentui/react-icons'
import { MissionFolder } from '../missions'

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

  // 从 URL hash 恢复 tab（Ctrl+R 刷新后保持）
  const getInitialTab = () => {
    const m = window.location.hash.match(/^#\/localmods\/(\w+)/)
    return m && ['mods', 'v1', 'v2'].includes(m[1]) ? m[1] : 'mods'
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

  return (
    <div className={styles.root}>
      <TabList
        className={styles.tabs}
        selectedValue={subTab}
        onTabSelect={handleTabSelect}
      >
        <Tab value="mods" icon={<BoxMultiple24Regular />}>{t('nav.mods')}</Tab>
        <Tab value="v1" icon={<Folder24Regular />}>{t('nav.v1')}</Tab>
        <Tab value="v2" icon={<DocumentFolder24Regular />}>{t('nav.v2')}</Tab>
      </TabList>

      <div className={styles.content}>
        <MissionFolder
          key={`localmods-${subTab}-${config?.game_path || ''}-${refreshKey || 0}`}
          config={config}
          subfolder={SUBFOLDER_BY_TAB[subTab]}
          onUninstall={onUninstall}
          focusModKey={focusModKey}
        />
      </div>
    </div>
  )
}

export default LocalMods
