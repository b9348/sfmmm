import { Card, Text, Button, SearchBox, makeStyles, Select } from '@fluentui/react-components'
import { ArrowClockwise24Regular, Search24Regular } from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { ItemsPerRowControl } from './ItemsPerRowControl'

const useStyles = makeStyles({
  toolbarCard: {
    padding: '8px',
    position: 'sticky',
    top: 0,
    zIndex: 100,
    flexShrink: 0,
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  search: {
    flex: '1 1 200px',
    minWidth: '140px',
  },
})

/**
 * 列表页通用工具栏（创意工坊「云」/「讨论区」共用）：
 * 搜索框 + 搜索/刷新按钮 + 额外筛选项插槽 + 排序方式/时间方向下拉 + 每行数量。
 *
 * @param {string} i18nPrefix       搜索/刷新文案的 i18n 前缀（'workshop' | 'discussion'），
 *                                  排序相关文案两页均复用 workshop.* 键
 * @param {string} search           搜索关键字（受控）
 * @param {(v: string) => void} onSearchChange        输入变化
 * @param {(v: string) => void} onSearchSubmit        提交搜索（回车或点搜索按钮），参数为关键字
 * @param {() => void} onRefresh    刷新
 * @param {boolean} disabled        加载中禁用全部控件
 * @param {Array<{value: string, label: string}>} sortOptions 排序方式选项
 * @param {React.ReactNode} children 额外筛选项插槽（云页放「类型」下拉，讨论区不传）
 */
export function ListToolbar({
  i18nPrefix = 'workshop',
  search,
  onSearchChange,
  onSearchSubmit,
  onRefresh,
  disabled = false,
  sortOptions,
  sortBy,
  onSortByChange,
  sortOrder,
  onSortOrderChange,
  itemsPerRow,
  onItemsPerRowChange,
  children,
}) {
  const { t } = useTranslation()
  const styles = useStyles()
  // 时间正/倒序仅对时间类排序有意义，指标排序（点赞/评分等）固定降序
  const timeSortEnabled = sortBy === 'created_at' || sortBy === 'published_at'

  return (
    <Card className={styles.toolbarCard}>
      <div className={styles.toolbarRow}>
        <SearchBox
          className={styles.search}
          size="small"
          placeholder={t(`${i18nPrefix}.searchPlaceholder`)}
          value={search}
          onChange={(_, d) => onSearchChange(d.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onSearchSubmit(e.target.value) }}
        />
        <Button size="small" icon={<Search24Regular />} onClick={() => onSearchSubmit(search)} disabled={disabled}>
          {t(`${i18nPrefix}.search`)}
        </Button>
        <Button size="small" icon={<ArrowClockwise24Regular />} onClick={onRefresh} disabled={disabled}>
          {t(`${i18nPrefix}.refresh`)}
        </Button>
        <div style={{ flex: 1 }} />
        {children}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Text size="small">{t('workshop.sortBy')}</Text>
          <Select
            data-tour="workshop-sort-select"
            size="small"
            value={sortBy}
            onChange={(_, d) => onSortByChange(d.value)}
            disabled={disabled}
          >
            {sortOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Text size="small">{t('workshop.sortTime')}</Text>
          <Select
            size="small"
            value={sortOrder}
            onChange={(_, d) => onSortOrderChange(d.value)}
            disabled={disabled || !timeSortEnabled}
          >
            <option value="desc">{t('workshop.sortNewestFirst')}</option>
            <option value="asc">{t('workshop.sortOldestFirst')}</option>
          </Select>
        </div>
        <ItemsPerRowControl value={itemsPerRow} onChange={onItemsPerRowChange} disabled={disabled} />
      </div>
    </Card>
  )
}
