import { useState } from 'react'
import {
  Card,
  CardHeader,
  Text,
  Title2,
  Button,
  Input,
  Switch,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  Play24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'
import { open } from '@tauri-apps/plugin-dialog'
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
  const gamePath = config?.game_path || ''
  const modsPath = config?.mods_path || ''
  const exePath = config?.exe_path || ''
  const launchArgs = config?.launch_args || ''
  const workDir = config?.work_dir || ''
  const [verifyFiles, setVerifyFiles] = useState(config?.verify_files === 'true' || false)
  const [autoEnableMods, setAutoEnableMods] = useState(config?.auto_enable_mods === 'true' || false)
  const [backupBeforeApply, setBackupBeforeApply] = useState(config?.backup_before_apply !== 'false' || true)

  const browseGameFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择游戏目录',
    })
    if (selected) {
      await saveConfig({ game_path: selected })
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
      await db.close()
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
                placeholder="C:\Games\MyGame"
                style={{ flex: 1 }}
              />
              <Button size="small" icon={<Folder24Regular />} onClick={browseGameFolder}>浏览</Button>
            </div>
            <Text className={styles.formLabel}>模组目录</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input
                size="small"
                value={modsPath}
                placeholder="C:\Games\MyGame\mods"
                style={{ flex: 1 }}
              />
              <Button size="small" icon={<Folder24Regular />}>浏览</Button>
            </div>
          </div>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>启动选项</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>可执行文件</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input
                size="small"
                value={exePath}
                placeholder="game.exe"
                style={{ flex: 1 }}
              />
              <Button size="small" icon={<Folder24Regular />}>浏览</Button>
            </div>
            <Text className={styles.formLabel}>启动参数</Text>
            <Input
              size="small"
              value={launchArgs}
              placeholder="-windowed -skipintro"
              style={{ flex: 1 }}
            />
            <Text className={styles.formLabel}>工作目录</Text>
            <Input
              size="small"
              value={workDir}
              placeholder="C:\Games\MyGame"
              style={{ flex: 1 }}
            />
          </div>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>高级选项</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Switch
              size="small"
              checked={verifyFiles}
              onChange={(e, data) => {
                setVerifyFiles(data.checked)
                saveConfig({ verify_files: String(data.checked) })
              }}
            />
            <Text size="small">启动时验证游戏文件</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Switch
              size="small"
              checked={autoEnableMods}
              onChange={(e, data) => {
                setAutoEnableMods(data.checked)
                saveConfig({ auto_enable_mods: String(data.checked) })
              }}
            />
            <Text size="small">自动启用新安装的模组</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Switch
              size="small"
              checked={backupBeforeApply}
              onChange={(e, data) => {
                setBackupBeforeApply(data.checked)
                saveConfig({ backup_before_apply: String(data.checked) })
              }}
            />
            <Text size="small">应用模组前创建备份</Text>
          </div>
        </div>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
        <Button size="small" appearance="secondary">恢复默认</Button>
        <Button size="small" icon={<Play24Regular />}>启动游戏</Button>
      </div>
    </div>
  )
}