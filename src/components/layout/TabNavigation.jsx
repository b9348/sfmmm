import { Tab, TabList } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  tabList: {
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
})

export function TabNavigation({ value, onChange }) {
  const styles = useStyles()

  return (
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
  )
}