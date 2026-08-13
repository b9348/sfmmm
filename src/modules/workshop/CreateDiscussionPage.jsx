import { useState } from 'react'
import {
  Card, Text, Input, Button, Select, RadioGroup, Radio,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular, Add24Regular, Delete24Regular,
} from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { createDiscussion, updateDiscussion } from '../../services/workshopApi'
import { resolvePendingImagesInMarkdown } from '../../services/imageApi'
import { MarkdownEditor } from '../../components/common/RichTextEditor'
import { BackButton } from '../../components'

const MAX_TITLE_LEN = 200

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    gap: '8px',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '0 12px 16px',
  },
  section: {
    marginTop: '12px',
  },
  label: {
    marginBottom: '6px',
  },
  titleInput: {
    width: '100%',
  },
  pollBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
    padding: '12px',
  },
  pollRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  optionInput: {
    flex: 1,
  },
  numRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  numField: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  numInput: {
    width: '72px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '16px',
  },
})

/**
 * 发帖页（简化版）：标题 + 正文 + 可选投票配置（PollEditor 内联）。
 * 无文件上传 / 分类 / 多语言，调用 db_create_discussion。
 */
/**
 * 发帖/编辑页：标题 + 正文 + 可选投票配置（PollEditor 内联）。
 * 传 initial（已有 discussion）时为编辑模式：预填标题/正文，提交走 updateDiscussion；
 * 投票配置创建后不可改（后端 update_discussion 仅支持标题/正文），编辑模式隐藏投票区。
 * 无文件上传 / 分类 / 多语言，调用 db_create_discussion / db_update_discussion。
 */
export function CreateDiscussionPage({ authorId, initial = null, onClose, onCreated }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const isEdit = !!initial

  const [title, setTitle] = useState(initial?.title || '')
  const [content, setContent] = useState(initial?.content || '')
  const [dType, setDType] = useState(initial?.type === 'poll' ? 'poll' : 'regular') // 'regular' | 'poll'
  const [pollType, setPollType] = useState(initial?.poll?.poll_type || 'single')   // 'single' | 'multiple' | 'number'
  const [options, setOptions] = useState(initial?.poll?.options?.length
    ? initial.poll.options.map(o => o.label)
    : ['', ''])
  const [minSel, setMinSel] = useState(initial?.poll?.min || 1)
  const [maxSel, setMaxSel] = useState(initial?.poll?.max || 2)
  const [numMin, setNumMin] = useState(initial?.poll?.min || 1)
  const [numMax, setNumMax] = useState(initial?.poll?.max || 5)
  const [numStep, setNumStep] = useState(initial?.poll?.step || 1)
  const [visibility, setVisibility] = useState(initial?.poll?.results_visibility === 'on_vote' ? 'on_vote' : 'always') // 'always' | 'on_vote'
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleOptionChange = (idx, value) => {
    setOptions(prev => prev.map((o, i) => i === idx ? value : o))
  }

  const addOption = () => setOptions(prev => [...prev, ''])
  const removeOption = (idx) => setOptions(prev => prev.filter((_, i) => i !== idx))

  const buildPollConfig = () => {
    if (dType !== 'poll') return null
    const cfg = { poll_type: pollType, results_visibility: visibility }
    if (pollType === 'multiple') {
      cfg.min = minSel
      cfg.max = maxSel
    }
    if (pollType === 'number') {
      cfg.min = numMin
      cfg.max = numMax
      cfg.step = numStep
    }
    if (pollType !== 'number') {
      cfg.options = options.map(o => o.trim()).filter(Boolean)
    }
    return cfg
  }

  const validate = () => {
    if (!title.trim()) return t('discussion.titleEmpty')
    if (!content.trim()) return t('discussion.contentPlaceholder')
    // 编辑模式不改投票配置，跳过投票校验
    if (!isEdit && dType === 'poll') {
      const cfg = buildPollConfig()
      if (pollType !== 'number' && (cfg.options?.length || 0) < 2) {
        return t('discussion.pollOptions') + ' ≥ 2'
      }
      if (pollType === 'number' && numMin >= numMax) {
        return t('discussion.pollNumberMin') + ' < ' + t('discussion.pollNumberMax')
      }
    }
    return ''
  }

  const handleSubmit = async () => {
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const rawContent = content.trim()
      if (isEdit) {
        // 编辑模式：只更新标题/正文（后端 update_discussion 不支持改投票配置）
        const discussionId = initial.id
        await updateDiscussion({
          author_id: authorId,
          discussion_id: discussionId,
          title: title.trim(),
          content: rawContent,
          content_format: 'markdown',
        })
        // 上传正文中的新增 pending 图片并替换占位符，再回填正文
        try {
          const resolved = await resolvePendingImagesInMarkdown(rawContent, {
            getFolder: () => `sfmmm/discourse/${discussionId}/images`,
          })
          if (resolved.content !== rawContent) {
            await updateDiscussion({ author_id: authorId, discussion_id: discussionId, content: resolved.content })
          }
        } catch (imgErr) {
          // 图片上传失败不阻塞保存（正文已更新，占位符可下次编辑补图）
          console.warn('[CreateDiscussionPage] 编辑图片上传失败:', imgErr)
        }
        onCreated?.()
        return
      }
      const poll = buildPollConfig()
      // 1. 先建帖拿到 discussion_id（图床 folder 依赖帖子 id，与云 CreateModPage 同模式）
      const res = await createDiscussion({
        author_id: authorId,
        title: title.trim(),
        content: rawContent,
        content_format: 'markdown',
        d_type: dType,
        poll,
      })
      const discussionId = res.data?.discussion_id
      if (discussionId) {
        // 2. 上传正文中的 pending 图片并替换占位符，再回填正文
        try {
          const resolved = await resolvePendingImagesInMarkdown(rawContent, {
            getFolder: () => `sfmmm/discourse/${discussionId}/images`,
          })
          if (resolved.content !== rawContent) {
            await updateDiscussion({ author_id: authorId, discussion_id: discussionId, content: resolved.content })
          }
        } catch (imgErr) {
          // 图片上传失败不阻塞发帖（帖子已创建，占位符保留可后续编辑补图）
          console.warn('[CreateDiscussionPage] 正文图片上传失败:', imgErr)
        }
      }
      onCreated?.()
    } catch (e) {
      setError((t('discussion.createFailed')) + (e?.message || e))
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbarRow}>
        <BackButton onClick={onClose} />
        <Text weight="semibold">{t('discussion.publishDiscussion')}</Text>
      </div>

      <div className={styles.content}>
        <div className={styles.section}>
          <Text size="small" weight="semibold" block className={styles.label}>{t('discussion.title')}</Text>
          <Input
            className={styles.titleInput}
            size="small"
            placeholder={t('discussion.titlePlaceholder')}
            maxLength={MAX_TITLE_LEN}
            value={title}
            onChange={(_, d) => setTitle(d.value)}
          />
        </div>

        <div className={styles.section}>
          <Text size="small" weight="semibold" block className={styles.label}>{t('discussion.publish')}</Text>
          <MarkdownEditor
            value={content}
            onChange={setContent}
            placeholder={t('discussion.contentPlaceholder')}
            maxLength={8000}
          />
        </div>

        {!isEdit && (
          <>
            <div className={styles.section}>
              <Text size="small" weight="semibold" block className={styles.label}>{t('discussion.pollType')}</Text>
              <RadioGroup value={dType} onChange={(_, d) => setDType(d.value)}>
                <Radio value="regular" label={t('discussion.typeRegular')} />
                <Radio value="poll" label={t('discussion.typePoll')} />
              </RadioGroup>
            </div>

            {dType === 'poll' && (
              <div className={`${styles.section} ${styles.pollBox}`}>
                <Text size="small" weight="semibold">{t('discussion.pollType')}</Text>
                <RadioGroup value={pollType} onChange={(_, d) => setPollType(d.value)}>
                  <Radio value="single" label={t('discussion.pollSingle')} />
                  <Radio value="multiple" label={t('discussion.pollMultiple')} />
                  <Radio value="number" label={t('discussion.pollNumber')} />
                </RadioGroup>

                {pollType === 'single' || pollType === 'multiple' ? (
                  <>
                    {options.map((opt, idx) => (
                      <div key={idx} className={styles.pollRow}>
                        <Input
                          className={styles.optionInput}
                          size="small"
                          placeholder={t('discussion.pollOptionPlaceholder', { n: idx + 1 })}
                          value={opt}
                          onChange={(_, d) => handleOptionChange(idx, d.value)}
                        />
                        <Button size="small" appearance="subtle" icon={<Delete24Regular />} disabled={options.length <= 2} onClick={() => removeOption(idx)} />
                      </div>
                    ))}
                    <Button size="small" appearance="subtle" icon={<Add24Regular />} onClick={addOption}>
                      {t('discussion.pollAddOption')}
                    </Button>
                    {pollType === 'multiple' && (
                      <div className={styles.numRow}>
                        <div className={styles.numField}>
                          <Text size="small">{t('discussion.pollMin')}</Text>
                          <Input type="number" size="small" className={styles.numInput} value={String(minSel)} onChange={(_, d) => setMinSel(Math.max(1, Number(d.value) || 1))} />
                        </div>
                        <div className={styles.numField}>
                          <Text size="small">{t('discussion.pollMax')}</Text>
                          <Input type="number" size="small" className={styles.numInput} value={String(maxSel)} onChange={(_, d) => setMaxSel(Math.max(minSel, Number(d.value) || minSel))} />
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className={styles.numRow}>
                    <div className={styles.numField}>
                      <Text size="small">{t('discussion.pollNumberMin')}</Text>
                      <Input type="number" size="small" className={styles.numInput} value={String(numMin)} onChange={(_, d) => setNumMin(Number(d.value) || 0)} />
                    </div>
                    <div className={styles.numField}>
                      <Text size="small">{t('discussion.pollNumberMax')}</Text>
                      <Input type="number" size="small" className={styles.numInput} value={String(numMax)} onChange={(_, d) => setNumMax(Number(d.value) || 0)} />
                    </div>
                    <div className={styles.numField}>
                      <Text size="small">{t('discussion.pollStep')}</Text>
                      <Input type="number" size="small" className={styles.numInput} value={String(numStep)} onChange={(_, d) => setNumStep(Math.max(1, Number(d.value) || 1))} />
                    </div>
                  </div>
                )}

                <div className={styles.numRow}>
                  <Text size="small">{t('discussion.pollResultsVisibility')}</Text>
                  <Select size="small" value={visibility} onChange={(_, d) => setVisibility(d.value)}>
                    <option value="always">{t('discussion.pollResultsAlways')}</option>
                    <option value="on_vote">{t('discussion.pollResultsOnVote')}</option>
                  </Select>
                </div>
              </div>
            )}
          </>
        )}

        {error && (
          <Text size="small" style={{ color: tokens.colorPaletteRedForeground1, marginTop: '8px', display: 'block' }}>
            {error}
          </Text>
        )}

        <div className={styles.actions}>
          <Button size="small" appearance="subtle" onClick={onClose}>{t('discussion.cancel')}</Button>
          <Button size="small" appearance="primary" icon={<ArrowLeft24Regular style={{ transform: 'rotate(180deg)' }} />} disabled={submitting} onClick={handleSubmit}>
            {submitting ? t('workshop.processing') : t('discussion.publish')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default CreateDiscussionPage
