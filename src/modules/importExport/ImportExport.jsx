import {
  Card,
  CardHeader,
  Text,
  Title3,
  Button,
  Checkbox,
} from '@fluentui/react-components'
import {
  ArrowUpload24Regular,
  ArrowDownload24Regular,
  FolderAdd24Regular,
  Archive24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '8px',
  },
})

export function ImportExport() {
  const styles = useStyles()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div className={styles.grid}>
        <Card appearance="outline">
          <CardHeader header={<Title3>导出</Title3>} />
          <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>
              将当前的模组配置和设置打包导出为单个文件。
            </Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <Checkbox defaultChecked label="已启用模组" />
              <Checkbox defaultChecked label="配置文件" />
              <Checkbox label="存档文件" />
            </div>
            <Button size="small" icon={<ArrowUpload24Regular />}>导出打包文件</Button>
          </div>
        </Card>

        <Card appearance="outline">
          <CardHeader header={<Title3>导入</Title3>} />
          <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>
              导入之前导出的模组包或单个模组文件。
            </Text>
            <div style={{ display: 'flex', gap: '6px' }}>
              <Button size="small" icon={<ArrowDownload24Regular />}>导入包</Button>
              <Button size="small" icon={<FolderAdd24Regular />}>导入文件夹</Button>
            </div>
          </div>
        </Card>
      </div>

      <Card appearance="outline">
        <CardHeader header={<Title3>最近导出</Title3>} />
        <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 6px', backgroundColor: tokens.colorNeutralBackground3, borderRadius: '4px' }}>
            <Archive24Regular style={{ fontSize: '16px' }} />
            <Text size="small" style={{ flex: 1 }} truncate>my_mods_backup_2026-05-01.zip</Text>
            <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>2026-05-01</Text>
            <Button size="small" appearance="subtle" icon={<ArrowDownload24Regular />}>下载</Button>
          </div>
        </div>
      </Card>
    </div>
  )
}