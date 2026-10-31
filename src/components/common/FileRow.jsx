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
    alignItems: 'center',
    gap: '6px',
    padding: '4px 6px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export function FileRow({ langCode, name, version, fileSize, children }) {
  const styles = useStyles()

  return (
    <div className={styles.root}>
      <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
        {LANG_LABELS[langCode] || langCode}
      </Badge>
      {name && <Text size="small" truncate style={{ flex: 1 }}>{name}</Text>}
      <Text size="small">v{version}</Text>
      <Text size="small" className={styles.meta}>{formatFileSize(fileSize)}</Text>
      {children}
    </div>
  )
}