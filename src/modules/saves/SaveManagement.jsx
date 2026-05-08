import {
  Card,
  CardHeader,
  Text,
  Button,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  Save24Regular,
  ClipboardPaste24Regular,
  Bookmark24Regular,
  ArrowSync24Regular,
  Delete24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'

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
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '8px',
  },
})

const mockSaves = [
  { id: 1, name: '存档位 1 - 新游戏', date: '2026-05-01', size: '2.3 GB' },
  { id: 2, name: '存档位 2 - 第5章', date: '2026-05-03', size: '2.5 GB' },
  { id: 3, name: '存档位 3 - Boss rush', date: '2026-05-05', size: '1.8 GB' },
]

export function SaveManagement() {
  const styles = useStyles()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Card className={styles.toolbarCard}>
        <div className={styles.toolbarRow}>
          <Button size="small" icon={<Folder24Regular />}>打开文件夹</Button>
          <Button size="small" icon={<Save24Regular />}>创建备份</Button>
          <Button size="small" icon={<ClipboardPaste24Regular />}>恢复备份</Button>
        </div>
      </Card>

      <div className={styles.grid}>
        {mockSaves.map(save => (
          <Card key={save.id} appearance="outline">
            <CardHeader
              header={
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Bookmark24Regular style={{ fontSize: '16px' }} />
                  <Text size="small" weight="semibold" truncate>{save.name}</Text>
                </div>
              }
            />
            <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>
                {save.date} · {save.size}
              </Text>
              <div style={{ display: 'flex', gap: '4px' }}>
                <Button size="small" icon={<ArrowSync24Regular />}>恢复</Button>
                <Button size="small" icon={<Delete24Regular />}>删除</Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}