import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent,
  ProgressBar, Text, makeStyles, tokens,
} from '@fluentui/react-components'

const useStyles = makeStyles({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minWidth: '320px',
    outline: 'none',
  },
  step: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
  },
})

export function ProgressModal({ open, title, percent, stepText }) {
  const styles = useStyles()
  return (
    <Dialog open={open} onOpenChange={() => {}} modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <div className={styles.content} tabIndex={-1}>
              <ProgressBar value={percent / 100} />
              <Text size="small" className={styles.step}>{stepText}</Text>
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
