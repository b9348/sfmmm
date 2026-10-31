import { useTranslation } from 'react-i18next'
import {
  Card, Text,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components'
import {
  HeartRegular,
  HeartFilled,
  CommentRegular,
} from '@fluentui/react-icons'
import { CategoryBadge, FileRow, UserAvatar } from '../../components'
import { RatingStarsDisplay } from '../../components/common/RatingStars'

// 语言文件行数上限：多语言版本多的 mod 不把卡片撑高，破坏同排网格节奏
const MAX_FILE_ROWS = 3

// 用户信息上下结构（头像在上、名字在下）：22 + 间隔(2) + 名字行高(14) = 38，
// 与左侧 mod_key(20) + 间隔(2) + 时间(16) 两行等高，头部行高保持不变
const HEADER_AVATAR_SIZE = 22

// 时间与 mod_key 同列：时间压到分钟（同年省略年份），避免长串把 key 挤省略
function formatCardTime(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw || '')
  if (!m) return raw
  const [, year, month, day, hour, minute] = m
  return Number(year) === new Date().getFullYear()
    ? `${month}-${day} ${hour}:${minute}`
    : `${year}-${month}-${day}`
}

const useStyles = makeStyles({
  card: {
    padding: '12px',
    cursor: 'pointer',
    height: '100%',
    minHeight: '220px',
    display: 'flex',
    flexDirection: 'column',
    transition: 'box-shadow 0.2s ease, background-color 0.2s ease',
    '&:hover': {
      boxShadow: tokens.shadow4,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  cardOriginal: {
    // 两处坑（都踩过）：
    // 1) 不能用 '::after' 覆盖 Fluent 的边框：本项目的 makeStyles 是「运行时」模式
    //    （未安装 griffel 编译插件），运行时解析器对伪元素 key 静默不产出任何规则
    //    （实测 resolveStyleRules({ '::after': {...} }) 返回空 map）。Fluent 能写
    //    ::after 是因为它走 AOT，CSS 文本在编译期固化。
    // 2) 应用时两个 slot 必须经 mergeClasses 合并（见下方 Card 的 className）：
    //    griffel 的序列类（___xxx）一个字符串只能含一个，用模板字符串拼接会静默丢弃后者。
    // 故用 CSS outline 画品牌色描边：独立于 Fluent 的 ::after 边框、不占文档流（零布局
    // 位移）；outlineOffset:-2px 让描边内缩与 Fluent 1px 边框重合，视觉上覆盖它。
    // 此手法与 Fluent 自身给 Card 画 focus 样式的方式一致。
    outline: `2px solid ${tokens.colorCompoundBrandStroke}`,
    outlineOffset: '-2px',
  },
  headerBlock: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  // 卡片主标题：显示名用一级色；mod_key 在首行左侧、降为二/三级灰
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase400,
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
    marginTop: '6px',
  },
  headerTop: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
  },
  identityLeft: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '2px',
    flex: 1,
    minWidth: 0,
  },
  identityRight: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 1,
    minWidth: 0,
  },
  // 名字是头像下方的注释：常规字重、三级灰；12px 字号保证高分屏可辨识，
  // 行高收紧到 14px 不撑高头部行
  author: {
    maxWidth: '100%',
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    fontWeight: tokens.fontWeightRegular,
    lineHeight: '14px',
  },
  // mod_key 在上（大字号）、时间在下（小字号、三级灰）
  keyText: {
    width: '100%',
    minWidth: 0,
    textAlign: 'left',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
  },
  time: {
    width: '100%',
    textAlign: 'left',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    whiteSpace: 'nowrap',
  },
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginTop: 0,
    flex: 1,
    minHeight: 0,
  },
  // 恒占两行高度：无简介的卡片也保持同样的描述区，底栏才能和同排卡片对齐
  description: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    minHeight: 'calc(1.4em * 2)',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
  },
  files: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  moreFiles: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
  },
  // 底部 meta 栏：评分居左、计数居右
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '8px',
    paddingTop: '8px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    minHeight: '24px',
  },
  counters: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  counter: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
  },
  counterText: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export function ModCard({ mod, onClick, onMouseEnter, onMouseLeave, onMouseDown }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const files = mod.files || []
  const title = mod.display_name || mod.mod_key
  const timeText = mod.updated_at && mod.updated_at > mod.created_at
    ? `${t('workshop.updatedAt')}: ${formatCardTime(mod.updated_at)}`
    : formatCardTime(mod.created_at)

  return (
    <Card
      className={mergeClasses(styles.card, mod.is_original && styles.cardOriginal)}
      appearance="outline"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
    >
      <div className={styles.headerBlock}>
        <div className={styles.headerTop}>
          <div className={styles.identityLeft}>
            <Text className={styles.keyText} truncate>{mod.mod_key}</Text>
            <Text className={styles.time}>{timeText}</Text>
          </div>
          <div className={styles.identityRight}>
            <UserAvatar avatar={mod.author_avatar} name={mod.author_name} size={HEADER_AVATAR_SIZE} />
            <Text className={styles.author} truncate>{mod.author_name}</Text>
          </div>
        </div>
        <div className={styles.titleRow}>
          <CategoryBadge category={mod.category} style={{ flexShrink: 0 }} />
          <Text className={styles.title} truncate>{title}</Text>
        </div>
      </div>
      <div className={styles.cardBody}>
        <Text size="small" className={styles.description}>{mod.description || '\u00A0'}</Text>
        {files.length > 0 && (
          <div className={styles.files}>
            {files.slice(0, MAX_FILE_ROWS).map(f => {
              const langName = mod.translations?.[f.lang_code]?.name || mod.display_name
              return (
                <FileRow key={f.lang_code} langCode={f.lang_code} name={langName} version={f.version} fileSize={f.file_size} />
              )
            })}
            {files.length > MAX_FILE_ROWS && (
              <Text size="small" className={styles.moreFiles}>+{files.length - MAX_FILE_ROWS}</Text>
            )}
          </div>
        )}
      </div>
      <div className={styles.footer}>
        {mod.rating_count > 0 && (
          <RatingStarsDisplay value={mod.rating_avg} count={mod.rating_count} size="small" compact showCount={false} />
        )}
        <div className={styles.counters}>
          <span className={styles.counter}>
            <CommentRegular aria-hidden="true" style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />
            <Text size="small" className={styles.counterText}>{mod.comment_count || 0}</Text>
          </span>
          <span className={styles.counter} title={mod.is_liked ? t('workshop.likedHint') : t('workshop.unlikedHint')}>
            {mod.is_liked ? (
              <HeartFilled aria-hidden="true" style={{ color: tokens.colorPaletteRedForeground1, fontSize: '16px' }} />
            ) : (
              <HeartRegular aria-hidden="true" style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />
            )}
            <Text size="small" className={styles.counterText}>{mod.like_count || 0}</Text>
          </span>
        </div>
      </div>
    </Card>
  )
}

export default ModCard
