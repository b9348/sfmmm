import {
  Card,
  Text,
  Avatar,
  Badge,
  Button,
  SearchBox,
  Switch,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  MenuDivider,
} from '@fluentui/react-components'
import {
  FolderAdd24Regular,
  ArrowDownload24Regular,
  ChevronDown24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'
import { useState } from 'react'

const useStyles = makeStyles({
  toolbarCard: {
    padding: '8px',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  modList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  modCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
  },
  modInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
})

const mockMods = [
  { id: 1, name: '画质增强包', author: 'ModAuthor1', version: '2.1.0', enabled: true, description: '增强视觉特效' },
  { id: 2, name: '音效扩展包', author: 'ModAuthor2', version: '1.5.2', enabled: true, description: '新增音频轨道' },
  { id: 3, name: '界面重制版', author: 'ModAuthor3', version: '3.0.0', enabled: false, description: '重新设计的界面' },
  { id: 4, name: '速度提升', author: 'ModAuthor4', version: '1.0.0', enabled: true, description: '加速游戏体验' },
]

export function ModList() {
  const styles = useStyles()
  const [search, setSearch] = useState('')
  const [mods, setMods] = useState(mockMods)

  const filteredMods = mods.filter(m =>
    m.name.toLowerCase().includes(search.toLowerCase())
  )

  const toggleMod = (id) => {
    setMods(prev => prev.map(m => m.id === id ? { ...m, enabled: !m.enabled } : m))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', minHeight: 0 }}>
      <Card className={styles.toolbarCard}>
        <div className={styles.toolbarRow}>
          <SearchBox
            placeholder="搜索模组..."
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            style={{ width: '160px' }}
          />
          <Button size="small" icon={<FolderAdd24Regular />}>添加</Button>
          <Button size="small" icon={<ArrowDownload24Regular />}>扫描</Button>
          <div style={{ flex: 1 }} />
          <Text size="small">共 {filteredMods.length} 个</Text>
        </div>
      </Card>

      <div className={styles.modList} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {filteredMods.map(mod => (
          <Card key={mod.id} appearance="outline">
            <div className={styles.modCard}>
              <Avatar
                size="extra-small"
                name={mod.name}
                color="brand"
                badge={{ status: mod.enabled ? 'available' : 'out-of-office' }}
              />
              <div className={styles.modInfo}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Text size="small" weight="semibold" truncate>{mod.name}</Text>
                  <Badge appearance="outline" size="small">v{mod.version}</Badge>
                </div>
                <Text size="small" style={{ color: tokens.colorNeutralForeground2 }} truncate>
                  {mod.author} — {mod.description}
                </Text>
              </div>
              <Switch
                size="small"
                checked={mod.enabled}
                onChange={() => toggleMod(mod.id)}
              />
              <Menu>
                <MenuTrigger>
                  <Button size="small" icon={<ChevronDown24Regular />} appearance="subtle" />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem>查看详情</MenuItem>
                    <MenuItem>编辑配置</MenuItem>
                    <MenuItem>检查更新</MenuItem>
                    <MenuDivider />
                    <MenuItem>移除</MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}