import { Card, CardHeader, Title2, Text } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'

const useStyles = makeStyles({
  desc: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    marginBottom: '4px',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    fontSize: tokens.fontSizeBase,
    lineHeight: tokens.lineHeightBase,
  },
  bullet: {
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
    lineHeight: tokens.lineHeightBase,
  },
  name: {
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
})

/**
 * 将文本中 "`名字`" 包裹的部分渲染为加粗，用于突出致谢对象。
 */
function renderWithName(text, styles) {
  const parts = text.split(/`([^`]+)`/)
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className={styles.name}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  )
}

/**
 * 设置页 - 感谢名单模块
 * 名单数据由 i18n 提供（settings.acknowledgments.items），支持多语言。
 */
export function Acknowledgments() {
  const { t } = useTranslation()
  const styles = useStyles()
  const raw = t('settings.acknowledgments.items', { returnObjects: true })
  const items = Array.isArray(raw) ? raw : []

  return (
    <Card appearance="outline">
      <CardHeader header={<Title2>{t('settings.acknowledgments.title')}</Title2>} />
      <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <Text className={styles.desc}>{t('settings.acknowledgments.desc')}</Text>
        <div className={styles.list}>
          {items.map((item, idx) => (
            <div className={styles.item} key={idx}>
              <span className={styles.bullet}>•</span>
              <span>{renderWithName(item, styles)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}

export default Acknowledgments
