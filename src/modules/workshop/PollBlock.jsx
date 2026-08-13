import { useState, useEffect, useCallback } from 'react'
import {
  Card, Text, Button, Checkbox, RadioGroup, Radio,
  makeStyles, tokens, ProgressBar,
} from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { votePoll, getPollResults } from '../../services/workshopApi'

const useStyles = makeStyles({
  root: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '8px',
    marginTop: '4px',
  },
  title: {
    marginBottom: '8px',
  },
  options: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    marginBottom: '8px',
  },
  optionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  bar: {
    flex: 1,
    minWidth: '120px',
  },
  percent: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    minWidth: '44px',
    textAlign: 'right',
  },
  count: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
  },
  numButtons: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
    marginBottom: '8px',
  },
  numBtn: {
    minWidth: '44px',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginTop: '4px',
  },
  hiddenHint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    padding: '12px',
    textAlign: 'center',
  },
})

/**
 * 投票块（渲染）：支持 single / multiple / number。
 * 投票后调 onVoted 刷新详情；结果条形图按 percent 展示。
 */
export function PollBlock({ poll, discussionId, userId, isLoggedIn, onVoted }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const [selected, setSelected] = useState([])     // option ids（single/multiple）
  const [numValue, setNumValue] = useState(null)    // number 评分
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState(poll?.results || null)
  const [hasVoted, setHasVoted] = useState(!!poll?.has_voted)
  const [myVote, setMyVote] = useState(poll?.my_vote || null)

  useEffect(() => {
    setResults(poll?.results || null)
    setHasVoted(!!poll?.has_voted)
    setMyVote(poll?.my_vote || null)
    // 投票后重新进入时清空选择
    setSelected([])
    setNumValue(null)
  }, [poll])

  // 刷新投票结果（改票后调用）
  const refreshResults = useCallback(async () => {
    try {
      const res = await getPollResults({ poll_id: poll.id, user_id: userId })
      if (res.data?.results) setResults(res.data.results)
      if (res.data?.has_voted !== undefined) setHasVoted(res.data.has_voted)
    } catch { /* silent */ }
  }, [poll, userId])

  if (!poll) return null

  const { poll_type: pollType, min, max, step, results_visibility: visibility, options = [] } = poll
  const canVote = isLoggedIn && !busy

  const handleVote = async () => {
    if (!canVote) return
    setBusy(true)
    try {
      const payload = {
        poll_id: poll.id,
        discussion_id: discussionId,
        user_id: userId,
        option_ids: [],
        value: null,
      }
      if (pollType === 'number') {
        if (numValue === null) return
        payload.value = numValue
      } else {
        if (selected.length === 0) return
        payload.option_ids = selected
      }
      await votePoll(payload)
      setHasVoted(true)
      await refreshResults()
      onVoted?.()
    } catch (e) {
      alert(t('discussion.voteFailed') + (e?.message || e))
    } finally {
      setBusy(false)
    }
  }

  const toggleOption = (id) => {
    if (pollType === 'single') {
      setSelected([id])
      return
    }
    const lo = min || 1
    const hi = max || options.length
    setSelected(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      if (prev.length >= hi) return prev // 超过上限忽略
      return [...prev, id]
    })
  }

  // 数字评分按钮序列：min, min+step, ... max
  const numButtons = []
  if (pollType === 'number' && min != null && max != null) {
    const st = step || 1
    for (let v = min; v <= max; v += st) numButtons.push(v)
  }

  const showResults = visibility === 'always' || hasVoted
  const selectedCount = pollType === 'number' ? (numValue !== null ? 1 : 0) : selected.length

  return (
    <div className={styles.root}>
      <Text size="small" weight="semibold" block className={styles.title}>
        {t('discussion.typePoll')}
        {pollType === 'number' && (results?.avg != null ? ` · ${t('discussion.avgScore', { avg: results.avg })}` : '')}
      </Text>

      {!hasVoted && (
        <>
          {pollType === 'number' ? (
            <div className={styles.numButtons}>
              {numButtons.map(v => (
                <Button
                  key={v}
                  size="small"
                  appearance={numValue === v ? 'primary' : 'outline'}
                  className={styles.numBtn}
                  disabled={!canVote}
                  onClick={() => setNumValue(v)}
                >
                  {v}
                </Button>
              ))}
            </div>
          ) : pollType === 'multiple' ? (
            <div className={styles.options}>
              {options.map(opt => (
                <Checkbox
                  key={opt.id}
                  label={opt.label}
                  checked={selected.includes(opt.id)}
                  onChange={() => toggleOption(opt.id)}
                  disabled={!canVote || (selected.includes(opt.id) ? false : selected.length >= (max || options.length))}
                />
              ))}
              {min > 1 && (
                <Text size="small" className={styles.count}>
                  {t('discussion.pollMin')}: {min} · {t('discussion.pollMax')}: {max}
                </Text>
              )}
            </div>
          ) : (
            <RadioGroup value={String(selected[0] || '')} onChange={(_, d) => setSelected([Number(d.value)])}>
              {options.map(opt => (
                <Radio
                  key={opt.id}
                  value={String(opt.id)}
                  label={opt.label}
                  disabled={!canVote}
                />
              ))}
            </RadioGroup>
          )}

          <div className={styles.footer}>
            <Button
              size="small"
              appearance="primary"
              disabled={!canVote || selectedCount === 0}
              onClick={handleVote}
            >
              {busy ? t('workshop.processing') : t('discussion.vote')}
            </Button>
            {hasVoted && (
              <Text size="small" className={styles.count}>{t('discussion.changeVote')}</Text>
            )}
          </div>
        </>
      )}

      {hasVoted && !showResults && (
        <div className={styles.hiddenHint}>
          <Text>{t('discussion.pollResultsHidden')}</Text>
        </div>
      )}

      {showResults && results && (
        <>
          {pollType === 'number' ? (
            <div className={styles.options}>
              {results.distribution?.map(d => (
                <div key={d.value} className={styles.optionRow}>
                  <Text size="small" className={styles.count}>{d.value}</Text>
                  <ProgressBar className={styles.bar} thickness="thin"
                    value={results.total_votes > 0 ? (d.count / results.total_votes) : 0} />
                  <Text size="small" className={styles.percent}>
                    {results.total_votes > 0 ? Math.round(d.count * 100 / results.total_votes) : 0}%
                  </Text>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.options}>
              {results.options?.map(r => (
                <div key={r.id} className={styles.optionRow}>
                  <Text size="small" style={{ minWidth: '140px' }} truncate>{r.label}</Text>
                  <ProgressBar className={styles.bar} thickness="thin" value={r.percent / 100} />
                  <Text size="small" className={styles.percent}>{r.percent}%</Text>
                </div>
              ))}
            </div>
          )}
          <div className={styles.footer}>
            <Text size="small" className={styles.count}>
              {t('discussion.totalVotes', { count: results.total_votes })}
            </Text>
            {hasVoted && (
              <Button size="small" appearance="subtle" disabled={!canVote} onClick={() => {
                setHasVoted(false)
                setSelected(myVote?.option_ids || [])
                if (myVote?.value != null) setNumValue(myVote.value)
              }}>
                {t('discussion.changeVote')}
              </Button>
            )}
          </div>
        </>
      )}

      {!isLoggedIn && !hasVoted && (
        <Text size="small" className={styles.count}>{t('discussion.loginRequired')}</Text>
      )}
    </div>
  )
}

export default PollBlock
