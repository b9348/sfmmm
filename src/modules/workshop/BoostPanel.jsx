import { useState } from 'react'
import {
  Button, Input, Avatar, makeStyles, tokens,
} from '@fluentui/react-components'
import { Rocket24Regular, Dismiss24Regular } from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { getAvatarUrl } from '../../utils/avatars'

const MAX_BOOST_LEN = 16

const useStyles = makeStyles({
  root: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '8px',
  },
  form: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    marginBottom: '8px',
  },
  input: {
    flex: 1,
  },
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '6px',
  },
  tag: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 8px 2px 3px',
    borderRadius: '999px',
    backgroundColor: tokens.colorNeutralBackground1Hover,
    maxWidth: '100%',
  },
  tagMine: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  tagContent: {
    fontSize: tokens.fontSizeSmall,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deleteBtn: {
    minWidth: '0',
    padding: '0',
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    padding: '4px 0',
  },
})

/**
 * Boost 面板（Discourse 风格）：圆角 tag 列表，左头像右内容；
 * 无用户名/时间/slogan，只有：boost 入口、boost 列表、删除自己的 boost。
 * 语义：每人对每帖 ≤1 条、≤16 字符、不提升排序。
 */
export function BoostPanel({ boosts = [], myBoost, discussionId, userId, isLoggedIn, onBoost, onUnboost }) {
  const { t } = useTranslation()
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

  // 渲染单个 boost tag：左头像右内容；自己的 boost 高亮并可删除
  const renderTag = (b, isMine) => (
    <span
      key={b.author_id ?? `boost-${b.content}`}
      className={`${styles.tag}${isMine ? ` ${styles.tagMine}` : ''}`}
    >
      {getAvatarUrl(b.author_avatar) ? (
        <img
          src={getAvatarUrl(b.author_avatar)}
          alt=""
          style={{ width: 18, height: 18, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0 }}
        />
      ) : (
        <Avatar name={b.author_name || '?'} size={18} color="brand" />
      )}
      <span className={styles.tagContent}>{b.content}</span>
      {isMine && (
        <Button
          size="small"
          appearance="subtle"
          icon={<Dismiss24Regular />}
          className={styles.deleteBtn}
          disabled={busy}
          onClick={handleUnboost}
        />
      )}
    </span>
  )

  return (
    <div className={styles.root}>
      {isLoggedIn && !myBoost && (
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
          <Button size="small" appearance="primary" icon={<Rocket24Regular />} disabled={!text.trim() || busy} onClick={handleSubmit}>
            {t('discussion.boost')}
          </Button>
        </div>
      )}
      {!isLoggedIn && (
        <span className={styles.empty}>{t('discussion.loginRequired')}</span>
      )}

      {boosts.length > 0 && (
        <div className={styles.list}>
          {boosts.map(b => renderTag(b, Number(b.author_id) === Number(userId)))}
        </div>
      )}
    </div>
  )
}

export default BoostPanel
