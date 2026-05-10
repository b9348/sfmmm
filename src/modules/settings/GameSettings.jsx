import { useState } from 'react'
import {
  Card,
  CardHeader,
  Text,
  Title2,
  Button,
  Input,
} from '@fluentui/react-components'
import {
  Folder24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import Database from '@tauri-apps/plugin-sql'

const useStyles = makeStyles({
  formGrid: {
    display: 'grid',
    gridTemplateColumns: '100px 1fr',
    gap: '6px 12px',
    alignItems: 'center',
  },
  formLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export function GameSettings({ config }) {
  const styles = useStyles()
  const [gamePath, setGamePath] = useState(config?.game_path || '')

  const browseGameFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: '选择游戏目录',
    })
    if (selected) {
      setGamePath(selected)
      await saveConfig({ game_path: selected })
    }
  }

  const openGameFolder = async () => {
    if (gamePath) {
      await invoke('open_folder', { path: gamePath })
    }
  }

  const saveConfig = async (updates) => {
    try {
      const db = await Database.load('sqlite:config.db')
      for (const [key, value] of Object.entries(updates)) {
        await db.execute(
          `INSERT OR REPLACE INTO config (id, ` + "`key`" + `, value) VALUES (
            (SELECT id FROM config WHERE ` + "`key`" + ` = $1),
            $1, $2
          )`,
          [key, String(value)]
        )
      }
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Card appearance="outline">
        <CardHeader header={<Title2>游戏路径</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>游戏目录</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input
                size="small"
                value={gamePath}
                placeholder="请选择游戏目录"
                style={{ flex: 1 }}
              />
              <Button size="small" icon={<Folder24Regular />} onClick={browseGameFolder}>更改</Button>
              <Button size="small" icon={<Folder24Regular />} onClick={openGameFolder}>打开游戏目录</Button>
            </div>
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            可自行变更游戏目录位置
          </Text>
        </div>
      </Card>
    </div>
  )
}