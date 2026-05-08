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

export function GameSettings() {
  const styles = useStyles()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Card appearance="outline">
        <CardHeader header={<Title2>游戏路径</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>游戏目录</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input size="small" placeholder="C:\Games\MyGame" style={{ flex: 1 }} />
              <Button size="small" icon={<Folder24Regular />}>浏览</Button>
            </div>
            <Text className={styles.formLabel}>模组目录</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input size="small" placeholder="C:\Games\MyGame\mods" style={{ flex: 1 }} />
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
              <Input size="small" placeholder="game.exe" style={{ flex: 1 }} />
              <Button size="small" icon={<Folder24Regular />}>浏览</Button>
            </div>
            <Text className={styles.formLabel}>启动参数</Text>
            <Input size="small" placeholder="-windowed -skipintro" style={{ flex: 1 }} />
            <Text className={styles.formLabel}>工作目录</Text>
            <Input size="small" placeholder="C:\Games\MyGame" style={{ flex: 1 }} />
          </div>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>高级选项</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Switch size="small" />
            <Text size="small">启动时验证游戏文件</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Switch size="small" />
            <Text size="small">自动启用新安装的模组</Text>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Switch size="small" />
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