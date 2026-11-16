import { makeStyles, tokens } from '@fluentui/react-components'

export const useMissionStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  toolbarCard: {
    padding: '8px',
    flexShrink: 0,
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  breadcrumbRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    flexWrap: 'wrap',
  },
  breadcrumbBtn: {
    minWidth: 'unset',
    padding: '2px 6px',
    height: '24px',
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
  },
  breadcrumbBtnActive: {
    color: tokens.colorNeutralForeground1,
    fontWeight: '600',
  },
  breadcrumbChevron: {
    fontSize: '10px',
    color: tokens.colorNeutralForeground3,
    display: 'inline-flex',
    alignItems: 'center',
  },
  grid: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    display: 'grid',
    gap: '8px',
    alignContent: 'flex-start',
  },
  card: {
    padding: '12px',
    cursor: 'pointer',
    transition: 'box-shadow 0.2s ease',
    minWidth: '0',
    // 卡片外观（原 Fluent Card 默认 overflow:hidden 会裁剪长文件名溢出内容，改普通 div 后内容可自由增高）
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    boxSizing: 'border-box',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  // 同一创意工坊订阅的分组容器：横贯整行，带淡绿描边（创意工坊徽章同色更淡，避免与单选高亮的品牌蓝撞色）
  groupCard: {
    padding: '12px 14px',
    gridColumn: '1 / -1',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `2px solid ${tokens.colorStatusSuccessBackground2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: `0 0 0 3px ${tokens.colorStatusSuccessBackground3}, ${tokens.shadow4}`,
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    minWidth: 0,
  },
  groupActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  },
  groupActionsPush: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    marginLeft: 'auto',
  },
  groupInnerGrid: {
    display: 'grid',
    gap: '8px',
  },
  // 组内成员的紧凑卡片
  innerCard: {
    padding: '8px 10px',
    cursor: 'pointer',
    transition: 'box-shadow 0.2s ease',
    minWidth: '0',
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    boxSizing: 'border-box',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  fileName: {
    overflow: 'hidden',
    overflowWrap: 'break-word',
    wordBreak: 'break-word',
    // flex 子项默认 min-width:auto，长名无法收缩折行、会横向溢出被 Card(overflow:hidden) 裁掉；
    // 归零后长名在卡片内正常折行，卡片随内容增高（配合上方 overflowWrap/wordBreak）
    minWidth: '0',
  },
  // 卡片头部：图标+文件名 与 描述（子项数等）上下排列
  cardHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: '0',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
    padding: '32px',
    textAlign: 'center',
    flex: 1,
  },
  pathText: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  folderCount: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
    marginTop: '2px',
  },
  // 创意工坊订阅卡片的信息区：显示名+mod_key 合并标题行 / 简介
  workshopInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: '0',
  },
  workshopKey: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeXSmall,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // 简介：最多两行，超出省略（与创意工坊 ModCard 的 ModCard description 同款）
  workshopDescription: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
  },
  buttonRow: {
    display: 'flex',
    gap: '4px',
    justifyContent: 'flex-end',
    marginTop: '4px',
  },
})
