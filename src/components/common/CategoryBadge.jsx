import { Badge } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { CATEGORY_ICONS } from './categoryMeta'

/**
 * 模组分类徽章：图标 + 本地化分类名；未知/未分类时不带图标。
 */
export function CategoryBadge({ category, style, ...rest }) {
  const { t } = useTranslation()
  const Icon = CATEGORY_ICONS[category]

  return (
    <Badge
      appearance="outline"
      size="small"
      icon={Icon ? <Icon /> : undefined}
      style={{ paddingLeft: '8px', paddingRight: '8px', ...style }}
      {...rest}
    >
      {category ? t(`workshop.category_${category}`, category) : t('workshop.uncategorized')}
    </Badge>
  )
}

export default CategoryBadge
