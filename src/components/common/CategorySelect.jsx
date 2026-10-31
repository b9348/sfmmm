import { Dropdown, Option, makeStyles } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { CATEGORY_ICONS, CATEGORY_VALUES } from './categoryMeta'

const useStyles = makeStyles({
  // 触发器里的内容格：占满剩余宽度，长分类名省略
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
    overflow: 'hidden',
  },
  label: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  option: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
  },
})

/**
 * 分类下拉：选项与收起态都带分类图标。
 *
 * @param {string} value          - 当前分类；'' 表示「全部」（仅 includeAll 时有意义）
 * @param {(v:string)=>void} onChange - 选择回调
 * @param {boolean} includeAll    - 是否提供「全部分类」选项
 */
export function CategorySelect({
  value = '',
  onChange,
  includeAll = false,
  size = 'small',
  disabled = false,
  className,
  style,
  'aria-label': ariaLabel,
}) {
  const styles = useStyles()
  const { t } = useTranslation()

  const labelOf = (category) => (category
    ? t(`workshop.category_${category}`, category)
    : t('workshop.typeAll'))

  const renderContent = (category, className) => {
    const Icon = CATEGORY_ICONS[category]
    return (
      <span className={className}>
        {Icon && <Icon />}
        <span className={styles.label}>{labelOf(category)}</span>
      </span>
    )
  }

  return (
    <Dropdown
      className={className}
      size={size}
      disabled={disabled}
      value={labelOf(value)}
      selectedOptions={[value]}
      onOptionSelect={(_, d) => onChange?.(d.optionValue ?? '')}
      aria-label={ariaLabel}
      // 默认 250px 宽且撑满容器，这里收紧成随内容宽度
      style={{ width: 'auto', minWidth: 0, ...style }}
      button={{ children: renderContent(value, styles.trigger) }}
    >
      {includeAll && (
        <Option value="" text={labelOf('')}>{renderContent('', styles.option)}</Option>
      )}
      {CATEGORY_VALUES.map((category) => (
        <Option key={category} value={category} text={labelOf(category)}>
          {renderContent(category, styles.option)}
        </Option>
      ))}
    </Dropdown>
  )
}

export default CategorySelect
