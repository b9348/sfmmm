import { Button } from '@fluentui/react-components'
import { Settings24Regular, Folder24Regular } from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    minHeight: '40px',
  },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeTitle3,
  },
  spacer: { flex: 1 },
})

export function Header() {
  const styles = useStyles()

  return (
    <header className={styles.header}>
      <Folder24Regular style={{ fontSize: '20px' }} />
      <span className={styles.title}>Mod 管理器</span>
      <div className={styles.spacer} />
      <Button size="small" icon={<Settings24Regular />} appearance="subtle" />
    </header>
  )
}