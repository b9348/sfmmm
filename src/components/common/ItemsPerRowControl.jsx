import { useTranslation } from 'react-i18next'
import { Button, Text } from '@fluentui/react-components'
import { Subtract20Regular, Add20Regular } from '@fluentui/react-icons'

const MIN = 1
const MAX = 10

/**
 * 「每行 X 个」排列控件（- 数值 +，范围 1-10）。
 * 提取自创意工坊（BrowseMods/Discussion）的每行展示数量交互，供创意工坊、
 * 本地模组（MissionFolder）、点赞记录等列表页复用。
 * 持久化（config 键）由调用方负责，各页可共用或使用独立配置键。
 */
export function ItemsPerRowControl({ value, onChange, disabled = false }) {
  const { t } = useTranslation()
  const handleChange = (delta) => {
    if (disabled) return
    const next = Math.min(MAX, Math.max(MIN, value + delta))
    if (next !== value) onChange(next)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <Text size="small">{t('workshop.itemsPerRow')}</Text>
      <Button
        size="small"
        icon={<Subtract20Regular />}
        appearance="subtle"
        onClick={() => handleChange(-1)}
        disabled={disabled || value <= MIN}
      />
      <Text size="small" style={{ minWidth: '20px', textAlign: 'center' }}>{value}</Text>
      <Button
        size="small"
        icon={<Add20Regular />}
        appearance="subtle"
        onClick={() => handleChange(1)}
        disabled={disabled || value >= MAX}
      />
    </div>
  )
}

export default ItemsPerRowControl
