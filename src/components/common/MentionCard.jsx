import { useContext, useEffect, useMemo, useState } from 'react'
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import {
  Code16Regular,
  Comment16Regular,
  Heart16Regular,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { CategoryBadge, UserAvatar } from '../../components'
import UserNavContext from '../../contexts/UserNavContext'
import { rememberEntryPoint } from '../../utils/navReturn'
import {
  MENTION_DISCUSSION,
  getCachedDiscussion,
  getCachedMod,
  getMentionData,
  normalizeLang,
} from '../../services/modMentions'

/**
 * @提及 卡片（模组 / 讨论区主题帖共用）。
 *
 * 样式对标 Discourse 的 GitHub 仓库 onebox：顶部 header 左侧站点标记、右侧目标标识，
 * 站点标记里的「仓库」换成 SFMMM；正文沿用列表页卡片的身份行（作者头像 + 名称、
 * 分类/编号、标题、简介、互动计数）。
 */

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    border: '1px solid ' + tokens.colorNeutralStroke2,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      border: '1px solid ' + tokens.colorNeutralStroke1Hover,
    },
  },
  hoverCard: {
    width: '380px',
    boxShadow: tokens.shadow16,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderBottom: '1px solid ' + tokens.colorNeutralStroke2,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    minWidth: 0,
  },
  brand: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    fontWeight: tokens.fontWeightSemibold,
  },
  repo: {
    marginLeft: 'auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground3,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '10px 12px 12px',
    minWidth: 0,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  description: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.45',
    color: tokens.colorNeutralForeground2,
    wordBreak: 'break-word',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '2px',
    minWidth: 0,
  },
  author: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
  },
  stats: {
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '10px',
    flexShrink: 0,
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
  },
  stat: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  },
  loading: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
  },
})

function openTarget(nav, kind, refKey) {
  if (!refKey) return
  if (kind === MENTION_DISCUSSION) {
    window.location.hash = '#/discuss/' + encodeURIComponent(refKey)
    return
  }
  if (nav?.openMod) nav.openMod(refKey)
  else window.location.hash = '#/mod/' + encodeURIComponent(refKey)
}

export function MentionCard({ kind, refKey, label, variant = 'block', style }) {
  const styles = useStyles()
  const { i18n } = useTranslation()
  const nav = useContext(UserNavContext)
  const dataKey = kind + ':' + refKey
  const cachedFor = (k, ref) => (
    k === MENTION_DISCUSSION ? getCachedDiscussion(ref) : getCachedMod(ref)
  )
  // 记录数据所属目标：父级用索引 key，内容更新后会复用实例，避免串卡片
  const [state, setState] = useState(() => ({ key: dataKey, data: cachedFor(kind, refKey) }))
  const data = state.key === dataKey ? state.data : cachedFor(kind, refKey)
  const lang = normalizeLang(i18n.language)

  useEffect(() => {
    let cancelled = false
    if (!refKey) return undefined
    getMentionData(kind, refKey, lang).then((result) => {
      if (!cancelled && result) setState({ key: dataKey, data: result })
    })
    return () => { cancelled = true }
  }, [kind, refKey, lang, dataKey])

  const isDiscussion = kind === MENTION_DISCUSSION
  const title = data
    ? (isDiscussion ? data.title : (data.display_name || data.mod_key))
    : (label || refKey)

  const stats = useMemo(() => {
    if (!data) return null
    return (
      <span className={styles.stats}>
        <span className={styles.stat} title="likes">
          <Heart16Regular aria-hidden="true" />{data.like_count || 0}
        </span>
        <span className={styles.stat}>
          <Comment16Regular aria-hidden="true" />{data.comment_count || 0}
        </span>
      </span>
    )
  }, [data, styles])

  return (
    <div
      className={mergeClasses(styles.card, variant === 'hover' && styles.hoverCard)}
      style={style}
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        rememberEntryPoint(
          e.currentTarget,
          (kind === MENTION_DISCUSSION ? 'discuss:' : 'mod:') + refKey
        )
        openTarget(nav, kind, refKey)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          rememberEntryPoint(
            e.currentTarget,
            (kind === MENTION_DISCUSSION ? 'discuss:' : 'mod:') + refKey
          )
          openTarget(nav, kind, refKey)
        }
      }}
    >
      <div className={styles.header}>
        <span className={styles.brand}>
          <Code16Regular aria-hidden="true" />
          <span>SFMMM</span>
        </span>
        <span className={styles.repo}>{isDiscussion ? '#' + refKey : refKey}</span>
      </div>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          {!isDiscussion && data?.category && (
            <CategoryBadge category={data.category} style={{ flexShrink: 0 }} />
          )}
          <span className={styles.title}>{title}</span>
        </div>
        {data?.description || data?.content ? (
          <div className={styles.description}>{isDiscussion ? data.content : data.description}</div>
        ) : null}
        <div className={styles.footer}>
          {data ? (
            <>
              <UserAvatar
                avatar={data.author_avatar}
                name={data.author_name}
                size={20}
                userId={data.author_id}
              />
              <span className={styles.author}>{data.author_name}</span>
            </>
          ) : (
            <span className={styles.loading}>{refKey}</span>
          )}
          {stats}
        </div>
      </div>
    </div>
  )
}

export default MentionCard
