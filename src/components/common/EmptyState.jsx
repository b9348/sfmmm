import { Text, makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
    padding: '32px',
    textAlign: 'center',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export function EmptyState({ icon, title, description, children, className }) {
  const styles = useStyles()

  return (
    <div className={`${styles.root}${className ? ` ${className}` : ''}`}>
      {icon}
      {title && <Text weight="semibold">{title}</Text>}
      {description && (
        <Text size="small" className={styles.meta}>{description}</Text>
      )}
      {children}
    </div>
  )
}