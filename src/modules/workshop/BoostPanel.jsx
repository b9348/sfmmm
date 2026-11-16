import { useState } from 'react'
import {
  Button, Input, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components'
import { Rocket20Regular, Dismiss12Regular } from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { useUserNav } from '../../contexts/useUserNav'
import { UserAvatar } from '../../components'

const MAX_BOOST_LEN = 16

// 尺寸与间距对齐 Discourse discourse-boosts 插件：胶囊高 32px、头像 24px、
// 气泡内 gap 4px / padding 4px 8px 4px 4px、列表 gap 4px，容器只留 4px 竖向内边距、无分隔线。
const useStyles = makeStyles({
  root: {
    padding: '4px 0',
  },
  form: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    marginBottom: '4px',
  },
  input: {
    flex: 1,
  },
  // 入口按钮对齐 discourse-boosts 的火箭图标按钮：32px 见方、无文字、低对比
  submitBtn: {
    minWidth: '32px',
    width: '32px',
    height: '32px',
    padding: '0',
    flexShrink: 0,
    borderRadius: '4px',
  },
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px',
  },
  bubble: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    boxSizing: 'border-box',
    padding: '4px 8px 4px 4px',
    borderRadius: '999px',
    backgroundColor: tokens.colorNeutralBackground3,
    maxWidth: '100%',
  },
  // 自己的 boost：右侧多一枚删除按钮，padding 收窄到 4px，保持胶囊两侧留白一致
  bubbleMine: {
    paddingRight: '4px',
  },
  // 头像可点：点击打开该用户的个人主页弹窗（对齐 Discourse 气泡里的 data-user-card）
  avatarBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
    margin: '0',
    border: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    borderRadius: '50%',
    flexShrink: 0,
    cursor: 'pointer',
  },
  avatarBtnStatic: {
    cursor: 'default',
  },
  bubbleContent: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: '14.5px',
    color: tokens.colorNeutralForeground1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    minWidth: '16px',
    width: '16px',
    height: '16px',
    padding: '0',
    flexShrink: 0,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: '14.5px',
    padding: '4px 0',
  },
})

/**
 * Boost 面板（复刻 Discourse discourse-boosts 样式）：灰底胶囊气泡，左头像右内容；
 * 无用户名/时间/slogan，只有：boost 入口、boost 列表、删除自己的 boost。
 * 气泡内只渲染纯文本，不复刻自定义表情（Discourse 侧是 emoji 图片，本仓没有对应资源）。
 * 语义：每人对每帖 ≤1 条、≤16 字符、不提升排序。
 */
export function BoostPanel({
  boosts = [], boostCount = 0, partial = false, myBoost, userId, isLoggedIn, onBoost, onUnboost,
}) {
  const { t } = useTranslation()
  const { openUser } = useUserNav()
  const styles = useStyles()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async () => {
    const content = text.trim()
    if (!content || !isLoggedIn || busy) return
    if (content.length > MAX_BOOST_LEN) {
      alert(t('discussion.boostTooLong', { max: MAX_BOOST_LEN }))
      return
    }
    setBusy(true)
    try {
      await onBoost(content)
      setText('')
    } catch (e) {
      alert(t('discussion.boostFailed') + (e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const handleUnboost = async () => {
    if (!isLoggedIn || busy) return
    setBusy(true)
    try {
      await onUnboost()
    } catch (e) {
      alert(t('discussion.boostFailed') + (e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  // 渲染单个 boost 气泡：左头像右内容；自己的 boost 额外显示删除入口
  const renderBubble = (b, isMine) => {
    const clickable = b.author_id != null && Number(b.author_id) !== 0
    const handleAvatarClick = (e) => {
      // 气泡/外层列表可能自带点击行为，避免冒泡触发跳转
      e.stopPropagation()
      if (!clickable) return
      openUser({ userId: b.author_id, username: b.author_name, avatar: b.author_avatar })
    }

    return (
      <span
        key={b.author_id ?? `boost-${b.content}`}
        className={mergeClasses(styles.bubble, isMine && styles.bubbleMine)}
      >
        <button
          type="button"
          className={mergeClasses(styles.avatarBtn, !clickable && styles.avatarBtnStatic)}
          onClick={handleAvatarClick}
          title={clickable ? b.author_name : undefined}
          aria-label={clickable
            ? `${b.author_name || ''} ${t('userProfile.viewProfile')}`.trim()
            : b.author_name}
        >
          <UserAvatar avatar={b.author_avatar} name={b.author_name} size={24} userId={b.author_id} />
        </button>
        <span className={styles.bubbleContent}>{b.content}</span>
        {isMine && (
          <Button
            size="small"
            appearance="transparent"
            icon={<Dismiss12Regular />}
            className={styles.removeBtn}
            disabled={busy}
            title={t('discussion.unboost')}
            aria-label={t('discussion.unboost')}
            onClick={handleUnboost}
          />
        )}
      </span>
    )
  }

  return (
    <div className={styles.root}>
      {isLoggedIn && !myBoost && !partial && (
        <div className={styles.form}>
          <Input
            className={styles.input}
            size="small"
            placeholder={t('discussion.boostPlaceholder')}
            maxLength={MAX_BOOST_LEN}
            value={text}
            onChange={(_, d) => setText(d.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
          />
          <Button
            size="small"
            appearance="subtle"
            icon={<Rocket20Regular />}
            className={styles.submitBtn}
            disabled={!text.trim() || busy}
            title={t('discussion.boost')}
            aria-label={t('discussion.boost')}
            onClick={handleSubmit}
          />
        </div>
      )}
      {!isLoggedIn && (
        <span className={styles.empty}>{t('discussion.loginRequired')}</span>
      )}

      {boosts.length > 0 && (
        <div className={styles.list}>
          {boosts.map(b => renderBubble(b, Number(b.author_id) === Number(userId)))}
        </div>
      )}
      {partial && boosts.length === 0 && boostCount > 0 && (
        <span className={styles.empty}>
          {t('discussion.boostOfflinePlaceholder', { count: boostCount })}
        </span>
      )}
    </div>
  )
}

export default BoostPanel
