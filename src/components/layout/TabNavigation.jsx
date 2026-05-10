import { Tab, TabList, Button } from '@fluentui/react-components'
import { Settings24Regular } from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  tabListContainer: {
    display: 'flex',
    alignItems: 'center',
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tabList: {
    flex: 1,
  },
})

export function TabNavigation({ value, onChange }) {
  const styles = useStyles()

  return (
    <div className={styles.tabListContainer}>
      <TabList
        selectedValue={value}
        onTabSelect={(_, d) => onChange(d.value)}
        className={styles.tabList}
      >
        <Tab value="mods">模组</Tab>
        <Tab value="saves">存档</Tab>
        <Tab value="import-export">导入 / 导出</Tab>
        <Tab value="settings">游戏设置</Tab>
      </TabList>
      <Button size="small" icon={<Settings24Regular />} appearance="subtle" style={{ marginRight: '8px' }} />
    </div>
  )
}