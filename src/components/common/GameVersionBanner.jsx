import { useTranslation } from 'react-i18next'
import { Text, Button, makeStyles, tokens } from '@fluentui/react-components'
import { Warning24Regular } from '@fluentui/react-icons'

const useStyles = makeStyles({
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorStatusWarningStroke2}`,
    backgroundColor: tokens.colorStatusWarningBackground2,
    color: tokens.colorStatusWarningForeground1,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
})

/**
 * 游戏版本过高的提示横幅：版本不达标时挂在 mod 列表/详情顶部。
 * 不阻断浏览，只提示并给出「去设置页」入口（游戏路径与更新都在设置页）。
 */
export function GameVersionBanner({ version, required, onGoSettings }) {
  const { t } = useTranslation()
  const styles = useStyles()
  return (
    <div className={styles.banner} role="alert">
      <Warning24Regular aria-hidden />
      <Text size="small" className={styles.text}>
        {t('workshop.gameGateBody', { version: version || '-', required: required || '-' })}
      </Text>
      {onGoSettings && (
        <Button size="small" appearance="subtle" onClick={onGoSettings}>
          {t('workshop.gameGateSettings')}
        </Button>
      )}
    </div>
  )
}
