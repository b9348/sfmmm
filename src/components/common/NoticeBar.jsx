import { makeStyles, tokens, mergeClasses } from '@fluentui/react-components'

const useStyles = makeStyles({
  root: {
    padding: '10px 12px',
    borderRadius: '6px',
  },
  success: {
    backgroundColor: tokens.colorPaletteGreenBackground1,
    color: tokens.colorPaletteGreenForeground1,
  },
  error: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
  },
})

export function NoticeBar({ tone = 'success', children }) {
  const styles = useStyles()
  return (
    <div className={mergeClasses(styles.root, tone === 'error' ? styles.error : styles.success)}>
      {children}
    </div>
  )
}
