import { Divider, Text, makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  row: {
    display: 'flex', alignItems: 'flex-start', gap: '24px', padding: '14px 4px',
    '@media (max-width: 768px)': { flexDirection: 'column', gap: '8px', padding: '12px 4px' },
  },
  label: {
    width: '240px', flexShrink: 0, fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground1,
    '@media (max-width: 768px)': { width: 'auto' },
  },
  controls: { flex: 1, width: '100%', minWidth: 0, maxWidth: '640px', overflowWrap: 'anywhere' },
})

export function F95SettingsRow({ title, children }) {
  const styles = useStyles()
  return (
    <>
      <Divider />
      <div className={styles.row}>
        <Text className={styles.label}>{title}</Text>
        <div className={styles.controls}>{children}</div>
      </div>
    </>
  )
}
