import { makeStyles, Button, Tooltip, tokens } from '@fluentui/react-components'
import { Navigation24Regular } from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { useNarrowNav } from '../../contexts/NarrowNavContext'

const useStyles = makeStyles({
  // 和 TabList 的 small 尺寸（32px 高）对齐，跟页签同一行时不会把行撑高
  button: {
    flexShrink: 0,
    width: '32px',
    height: '32px',
    minWidth: '32px',
    padding: 0,
    color: tokens.colorNeutralForeground1,
  },
})

/**
 * 窄屏侧栏抽屉的汉堡按钮。
 *
 * 只在窄屏渲染（宽屏返回 null），由页面放在顶部那一行里 —— 通常是页签 tabs 的左侧，
 * 于是「[☰] 页签1 页签2 …」是一行，而不是汉堡单独占一行、tabs 再另起一行。
 * 不依赖窗口标题栏，便于后续 APK 形态移除自绘标题栏。
 */
export function NarrowMenuButton() {
  const styles = useStyles()
  const { t } = useTranslation()
  const { isNarrow, drawerOpen, openDrawer } = useNarrowNav()

  if (!isNarrow || !openDrawer) return null

  return (
    <Tooltip
      content={drawerOpen ? t('nav.collapse') : t('nav.expand')}
      relationship="label"
    >
      <Button
        className={styles.button}
        appearance="subtle"
        icon={<Navigation24Regular />}
        onClick={openDrawer}
        aria-label={drawerOpen ? t('nav.collapse') : t('nav.expand')}
      />
    </Tooltip>
  )
}
