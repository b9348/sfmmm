import { Text, Badge, makeStyles, tokens } from '@fluentui/react-components'
import { LANG_LABELS } from '../../i18n/languages'

function formatFileSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)}MB`
    : `${(bytes / 1024).toFixed(1)}KB`
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '2px',
    padding: '4px 6px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
  },
  line: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    // 允许换行：窄屏下操作按钮组（flexBasis 100%）能落到第二行，
    // 而不是把整行挤成横向滚动；宽屏内容放得下时不会触发换行
    flexWrap: 'wrap',
    rowGap: '4px',
    minWidth: 0,
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export function FileRow({ langCode, name, version, fileSize, footer, children }) {
  const styles = useStyles()

  return (
    <div className={styles.root}>
      <div className={styles.line}>
        <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
          {LANG_LABELS[langCode] || langCode}
        </Badge>
        {name && <Text size="small" truncate style={{ flex: 1 }}>{name}</Text>}
        <Text size="small">v{version}</Text>
        <Text size="small" className={styles.meta}>{formatFileSize(fileSize)}</Text>
        {children}
      </div>
      {footer}
    </div>
  )
}