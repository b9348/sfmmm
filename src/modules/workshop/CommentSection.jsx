import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Text, Button, Spinner,
  makeStyles, tokens, Avatar,
} from '@fluentui/react-components'
import {
  Send24Regular, Delete24Regular, Edit24Regular,
} from '@fluentui/react-icons'
import { addComment, getComments, getCommentReplies, deleteComment, editComment } from '../../services/workshopApi'
import { resolvePendingImagesInMarkdown, stripPendingUrls, deleteImageFromImgbed, extractImgbedUrls } from '../../services/imageApi'
import { useAuth } from '../../contexts/useAuth'
import { MarkdownContent, MarkdownEditor } from '../../components/common/RichTextEditor'

const MAX_COMMENT_LENGTH = 3000
const MAX_REPLY_LENGTH = 3000

// 解析评论内容中的 pending 图片并上传
async function resolveCommentImages(content, modId, commentId) {
  const result = await resolvePendingImagesInMarkdown(content, {
    getFolder: () => `sfm/${modId}/comments/${commentId}`,
  })
  return result.content
}

const useStyles = makeStyles({
  root: { marginTop: '16px', borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '12px' },
  title: { marginBottom: '12px' },
  commentFormCard: { padding: '12px', marginBottom: '16px' },
  formRow: { display: 'flex', gap: '8px', alignItems: 'flex-end' },
  textarea: { flex: 1 },
  commentItem: { padding: '10px 12px', marginBottom: '8px' },
  commentHeader: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' },
  commentTime: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeSmall },
  commentContent: { lineHeight: 1.5 },
  replyFormCard: { padding: '8px 12px', marginTop: '8px', marginBottom: '8px', marginLeft: '24px' },
  replyList: { marginLeft: '24px', borderLeft: `2px solid ${tokens.colorNeutralStroke2}`, paddingLeft: '12px', marginTop: '6px' },
  replyItem: { padding: '6px 8px', marginBottom: '4px' },
  emptyText: { color: tokens.colorNeutralForeground3, textAlign: 'center', padding: '24px' },
  loginPrompt: { textAlign: 'center', padding: '16px', color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', gap: '6px', marginTop: '4px' },
  loadMoreRow: { textAlign: 'center', marginTop: '8px', marginBottom: '12px' },
  pageRow: { display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '12px', flexWrap: 'wrap' },
})

export default function CommentSection({ modId, scrollToCommentId }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const { user, isLoggedIn } = useAuth()

  // 一楼分页
  const [comments, setComments] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  // 发表评论
  const [newComment, setNewComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 楼中楼 replyTo = { parentId, authorName } | null
  const [replyTo, setReplyTo] = useState(null)
  const [replyText, setReplyText] = useState('')

  // 编辑状态
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')

  // 每楼的回复加载状态
  const [replyState, setReplyState] = useState({})

  const initialFetch = useRef(false)

  const fetchComments = useCallback(async (p) => {
    setLoading(true)
    try {
      const data = await getComments({ mod_id: modId, page: p, page_size: 10 })
      setComments(data.comments)
      setTotal(data.total)
      setPage(data.page)
      setReplyState({})
      setReplyTo(null)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [modId])

  useEffect(() => {
    if (!initialFetch.current) {
      initialFetch.current = true
      fetchComments(1)
    }
  }, [fetchComments])

  // 滚动到指定评论/回复
  const scrollTimerRef = useRef(null)
  useEffect(() => {
    if (!scrollToCommentId || loading) return
    // 延迟等待 DOM 渲染完成
    const tryScroll = (retries = 8) => {
      const el = document.getElementById(`comment-${scrollToCommentId}`) || document.getElementById(`reply-${scrollToCommentId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.style.transition = 'background-color 1s ease'
        el.style.backgroundColor = tokens.colorBrandBackground2Hover
        setTimeout(() => { el.style.backgroundColor = '' }, 2000)
      } else if (retries > 0) {
        scrollTimerRef.current = setTimeout(() => tryScroll(retries - 1), 300)
      }
    }
    tryScroll()
    return () => { if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current) }
  }, [scrollToCommentId, loading])

  const handleSubmitComment = async () => {
    const content = newComment.trim()
    if (!content || !user) return
    if (content.length > MAX_COMMENT_LENGTH) {
      alert(t('workshop.commentTooLong', { max: MAX_COMMENT_LENGTH }))
      return
    }
    setSubmitting(true)
    try {
      // 1. 先创建评论，pending 图片先用占位文本替代，避免上传失败时残留坏链接
      const safeContent = stripPendingUrls(content)
      const res = await addComment({ mod_id: modId, author_id: user.user_id, content: safeContent })
      const commentId = res.data.comment_id

      // 2. 上传图片并替换占位符
      const resolvedContent = await resolveCommentImages(content, modId, commentId)

      // 3. 更新评论内容为真实 URL
      if (resolvedContent !== safeContent) {
        await editComment({ comment_id: commentId, author_id: user.user_id, content: resolvedContent })
      }

      // 本地追加，不刷新全页
      setComments(prev => [{
        id: commentId,
        content: resolvedContent,
        author_name: user.username,
        created_at: t('workshop.justNow'),
        replies: [],
        reply_count: 0,
        has_more: false,
      }, ...prev])
      setTotal(prev => prev + 1)
      setNewComment('')
    } catch (e) {
      alert(t('workshop.commentFailed') + e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmitReply = async () => {
    const content = replyText.trim()
    if (!content || !user || !replyTo) return

    // 找到所属一楼 ID（所有回复统一挂在一楼下面，而不是挂在回复下面）
    let topId = replyTo.parentId
    const parentComment = comments.find(c => c.id === replyTo.parentId)
    if (!parentComment) {
      // parentId 是某条回复的 ID，找到它所属的一楼
      const top = comments.find(c => c.replies?.some(r => r.id === replyTo.parentId))
      if (top) topId = top.id
    }

    // 在内容前加上 @用户名 标识
    const prefixedContent = replyTo.authorName
      ? `@${replyTo.authorName} ${content}`
      : content

    if (prefixedContent.length > MAX_REPLY_LENGTH) {
      alert(t('workshop.replyTooLong', { max: MAX_REPLY_LENGTH }))
      return
    }

    setSubmitting(true)
    try {
      // 1. 先创建回复，pending 图片先用占位文本替代
      const safeContent = stripPendingUrls(prefixedContent)
      const res = await addComment({ mod_id: modId, author_id: user.user_id, content: safeContent, parent_id: topId })
      const replyId = res.data.comment_id

      // 2. 上传图片并替换占位符
      const resolvedContent = await resolveCommentImages(prefixedContent, modId, replyId)

      // 3. 更新回复内容为真实 URL
      if (resolvedContent !== safeContent) {
        await editComment({ comment_id: replyId, author_id: user.user_id, content: resolvedContent })
      }

      const newReply = {
        id: replyId,
        content: resolvedContent,
        author_name: user.username,
        created_at: t('workshop.justNow'),
      }
      // 找到所属一楼，只更新它的楼中楼
      setComments(prev => prev.map(c => {
        if (c.id === topId) {
          return {
            ...c,
            replies: [...(c.replies || []), newReply],
            reply_count: (c.reply_count || 0) + 1,
            has_more: (c.reply_count || 0) + 1 > 2,
          }
        }
        return c
      }))
      setReplyText('')
      setReplyTo(null)
    } catch (e) {
      alert(t('workshop.replyFailed') + e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (commentId) => {
    if (!user) return
    try {
      // 找到被删除评论的内容，提取图床图片 URL
      const topComment = comments.find(c => c.id === commentId)
      let content = topComment?.content
      if (!content) {
        for (const c of comments) {
          const reply = c.replies?.find(r => r.id === commentId)
          if (reply) {
            content = reply.content
            break
          }
        }
      }
      if (!content) {
        for (const rs of Object.values(replyState)) {
          const reply = rs.replies?.find(r => r.id === commentId)
          if (reply) {
            content = reply.content
            break
          }
        }
      }

      await deleteComment({ comment_id: commentId, author_id: user.user_id })

      // 异步清理图床图片（不阻塞 UI，失败仅 warn）
      // 删除一楼时要同时清理其所有楼中楼的图片
      const contentsToClean = content ? [content] : []
      if (topComment) {
        for (const r of topComment.replies || []) {
          contentsToClean.push(r.content)
        }
        const loadedReplies = replyState[commentId]?.replies || []
        for (const r of loadedReplies) {
          if (!topComment.replies?.some(cr => cr.id === r.id)) {
            contentsToClean.push(r.content)
          }
        }
      }
      const imageUrls = [...new Set(contentsToClean.flatMap(c => extractImgbedUrls(c)))]
      for (const url of imageUrls) {
        deleteImageFromImgbed(url).catch(e => console.warn('删除评论图片失败:', e))
      }

      // 判断是一楼还是楼中楼
      if (comments.some(c => c.id === commentId)) {
        setComments(prev => prev.filter(c => c.id !== commentId))
        setTotal(prev => Math.max(0, prev - 1))
        setReplyState(prev => {
          const next = { ...prev }
          delete next[commentId]
          return next
        })
      } else {
        // 从一楼 replies 中移除
        setComments(prev => prev.map(c => {
          if (c.replies?.some(r => r.id === commentId)) {
            return {
              ...c,
              replies: c.replies.filter(r => r.id !== commentId),
              reply_count: Math.max(0, (c.reply_count || 0) - 1),
              has_more: (c.reply_count || 0) - 1 > 2,
            }
          }
          return c
        }))
        // 同时清理 replyState 中已加载的
        setReplyState(prev => {
          const next = { ...prev }
          for (const key of Object.keys(next)) {
            if (next[key].replies?.some(r => r.id === commentId)) {
              next[key] = { ...next[key], replies: next[key].replies.filter(r => r.id !== commentId) }
            }
          }
          return next
        })
      }
    } catch (e) {
      alert(t('workshop.deleteFailed') + e.message)
    }
  }

  const handleEdit = async (commentId) => {
    const content = editText.trim()
    if (!content || !user) return
    const isTopComment = comments.some(c => c.id === commentId)
    const maxLength = isTopComment ? MAX_COMMENT_LENGTH : MAX_REPLY_LENGTH
    if (content.length > maxLength) {
      alert(t('workshop.editTooLong', { max: maxLength }))
      return
    }
    try {
      // 找到原内容，用于后续清理被删除的图片
      let oldContent = ''
      const topComment = comments.find(c => c.id === commentId)
      if (topComment) {
        oldContent = topComment.content
      } else {
        for (const c of comments) {
          const reply = c.replies?.find(r => r.id === commentId)
          if (reply) {
            oldContent = reply.content
            break
          }
        }
      }
      if (!oldContent) {
        for (const rs of Object.values(replyState)) {
          const reply = rs.replies?.find(r => r.id === commentId)
          if (reply) {
            oldContent = reply.content
            break
          }
        }
      }

      // 编辑时已知 comment_id，先上传新增的图片再保存
      const resolvedContent = await resolveCommentImages(content, modId, commentId)
      await editComment({ comment_id: commentId, author_id: user.user_id, content: resolvedContent })

      // 清理被删除的图片（编辑成功后异步处理，不阻塞 UI）
      const oldUrls = extractImgbedUrls(oldContent)
      const newUrls = extractImgbedUrls(resolvedContent)
      const removedUrls = oldUrls.filter(url => !newUrls.includes(url))
      for (const url of removedUrls) {
        deleteImageFromImgbed(url).catch(e => console.warn('删除评论图片失败:', e))
      }

      // 更新一楼
      setComments(prev => prev.map(c => {
        if (c.id === commentId) {
          return { ...c, content: resolvedContent }
        }
        // 更新楼中楼
        if (c.replies?.some(r => r.id === commentId)) {
          return {
            ...c,
            replies: c.replies.map(r => r.id === commentId ? { ...r, content: resolvedContent } : r),
          }
        }
        return c
      }))
      // 更新 replyState 中已加载的
      setReplyState(prev => {
        const next = { ...prev }
        for (const key of Object.keys(next)) {
          if (next[key].replies?.some(r => r.id === commentId)) {
            next[key] = {
              ...next[key],
              replies: next[key].replies.map(r => r.id === commentId ? { ...r, content: resolvedContent } : r),
            }
          }
        }
        return next
      })
      setEditingId(null)
      setEditText('')
    } catch (e) {
      alert(t('workshop.editFailed') + e.message)
    }
  }

  const handleLoadReplies = async (commentId) => {
    const rs = replyState[commentId] || { page: 0, replies: [], hasMore: true }
    const nextPage = rs.page + 1
    setReplyState(prev => ({ ...prev, [commentId]: { ...rs, expanded: true, loading: true } }))
    try {
      const data = await getCommentReplies({ comment_id: commentId, page: nextPage, page_size: 10 })
      setReplyState(prev => ({
        ...prev,
        [commentId]: {
          replies: [...(prev[commentId]?.replies || []), ...data.replies],
          page: nextPage,
          hasMore: data.replies.length >= 10,
          loading: false,
        },
      }))
    } catch {
      setReplyState(prev => ({ ...prev, [commentId]: { ...prev[commentId], loading: false } }))
    }
  }

  const totalPages = Math.ceil(total / 10)

  return (
    <div className={styles.root}>
      <Text weight="semibold" size={400} className={styles.title}>
        {t('workshop.comment', { count: total })}
      </Text>

      {/* ── 发表评论表单 ── */}
      {isLoggedIn ? (
        <Card className={styles.commentFormCard}>
          <div className={styles.formRow} style={{ alignItems: 'stretch' }}>
            <div className={styles.textarea}>
              <MarkdownEditor
                value={newComment}
                onChange={setNewComment}
                placeholder={t('workshop.commentPlaceholder')}
                maxLength={MAX_COMMENT_LENGTH}
              />
            </div>
            <Button
              appearance="primary" icon={<Send24Regular />}
              disabled={!newComment.trim() || submitting}
              onClick={handleSubmitComment}
            >
              {submitting ? t('workshop.sending') : t('workshop.send')}
            </Button>
          </div>
        </Card>
      ) : (
        <div className={styles.loginPrompt}>
          <Text>{t('workshop.loginToComment')}</Text>
        </div>
      )}

      {loading ? (
        <Spinner size="small" label={t('workshop.loadingComments')} />
      ) : comments.length === 0 ? (
        <div className={styles.emptyText}>
          <Text>{t('workshop.noComments')}</Text>
        </div>
      ) : (
        <>
          {comments.map(c => {
            const rs = replyState[c.id] || { replies: [], hasMore: c.has_more, page: 0, loading: false, expanded: c.reply_count <= 2 }
            const allReplies = [...(c.replies || []), ...rs.replies]
            const isReplyingHere = replyTo && (replyTo.parentId === c.id || allReplies.some(r => r.id === replyTo.parentId))
            const isExpanded = rs.expanded

            return (
              <Card key={c.id} id={`comment-${c.id}`} className={styles.commentItem}>
                {/* ── 一楼头部 ── */}
                <div className={styles.commentHeader}>
                  <Avatar name={c.author_name} size={20} />
                  <Text weight="semibold" size={200}>{c.author_name}</Text>
                  <Text className={styles.commentTime}>{c.created_at}</Text>
                </div>

                {/* 一楼内容（Markdown） */}
                <div className={styles.commentContent}>
                  {editingId === c.id ? (
                    <div className={styles.textarea}>
                      <MarkdownEditor
                        value={editText}
                        onChange={setEditText}
                        maxLength={MAX_COMMENT_LENGTH}
                      />
                    </div>
                  ) : (
                    <MarkdownContent markdown={c.content} />
                  )}
                </div>

                {/* 一楼操作 */}
                <div className={styles.actions}>
                  {isLoggedIn && editingId !== c.id && (
                    <Button size="small" appearance="subtle" onClick={() =>
                      setReplyTo(replyTo?.parentId === c.id ? null : { parentId: c.id, authorName: c.author_name })
                    }>
                      {replyTo?.parentId === c.id ? t('workshop.cancelReply') : t('workshop.reply')}
                    </Button>
                  )}
                  {user?.user_id && c.author_name === user.username && editingId !== c.id && (
                    <Button size="small" appearance="subtle" icon={<Edit24Regular />} onClick={() => {
                      setEditingId(c.id)
                      setEditText(c.content)
                    }} />
                  )}
                  {user?.user_id && c.author_name === user.username && (
                    <Button size="small" appearance="subtle" icon={<Delete24Regular />} onClick={() => handleDelete(c.id)} />
                  )}
                  {editingId === c.id && (
                    <>
                      <Button size="small" appearance="primary" disabled={!editText.trim()} onClick={() => handleEdit(c.id)}>
                        {t('workshop.save')}
                      </Button>
                      <Button size="small" appearance="subtle" onClick={() => { setEditingId(null); setEditText('') }}>
                        {t('workshop.cancel')}
                      </Button>
                    </>
                  )}
                </div>

                {/* ── 楼中楼列表 ── */}
                {isExpanded && allReplies.length > 0 && (
                  <div className={styles.replyList}>
                    {allReplies.map(r => (
                      <Card key={r.id} id={`reply-${r.id}`} className={styles.replyItem}>
                        <div className={styles.commentHeader}>
                          <Avatar name={r.author_name} size={16} />
                          <Text weight="semibold" size={200}>{r.author_name}</Text>
                          <Text className={styles.commentTime}>{r.created_at}</Text>
                        </div>
                        <div className={styles.commentContent}>
                          {editingId === r.id ? (
                            <div className={styles.textarea}>
                              <MarkdownEditor
                                value={editText}
                                onChange={setEditText}
                                maxLength={MAX_REPLY_LENGTH}
                              />
                            </div>
                          ) : (
                            <MarkdownContent markdown={r.content} />
                          )}
                        </div>
                        <div className={styles.actions}>
                          {isLoggedIn && editingId !== r.id && (
                            <Button size="small" appearance="subtle" onClick={() =>
                              setReplyTo(replyTo?.parentId === r.id ? null : { parentId: r.id, authorName: r.author_name })
                            }>
                              {t('workshop.replyToUser', { name: r.author_name })}
                            </Button>
                          )}
                          {user?.user_id && r.author_name === user.username && editingId !== r.id && (
                            <Button size="small" appearance="subtle" icon={<Edit24Regular />} onClick={() => {
                              setEditingId(r.id)
                              setEditText(r.content)
                            }} />
                          )}
                          {user?.user_id && r.author_name === user.username && (
                            <Button size="small" appearance="subtle" icon={<Delete24Regular />} onClick={() => handleDelete(r.id)} />
                          )}
                          {editingId === r.id && (
                            <>
                              <Button size="small" appearance="primary" disabled={!editText.trim()} onClick={() => handleEdit(r.id)}>
                                {t('workshop.save')}
                              </Button>
                              <Button size="small" appearance="subtle" onClick={() => { setEditingId(null); setEditText('') }}>
                                {t('workshop.cancel')}
                              </Button>
                            </>
                          )}
                        </div>
                      </Card>
                    ))}

                    {/* 加载更多回复 */}
                    {rs.hasMore && (
                      <div className={styles.loadMoreRow}>
                        <Button size="small" appearance="subtle" disabled={rs.loading} onClick={() => handleLoadReplies(c.id)}>
                          {rs.loading ? t('workshop.loading') : t('workshop.loadMoreReplies', { count: c.reply_count })}
                        </Button>
                      </div>
                    )}

                    {/* 折叠回复 */}
                    <div className={styles.loadMoreRow}>
                      <Button size="small" appearance="subtle" onClick={() =>
                        setReplyState(prev => ({ ...prev, [c.id]: { ...prev[c.id], expanded: false } }))
                      }>
                        {t('workshop.foldReplies')}
                      </Button>
                    </div>
                  </div>
                )}
                {!isExpanded && c.reply_count > 0 && (
                  <div className={styles.replyList} style={{ borderLeft: 'none', paddingLeft: 0 }}>
                    <div className={styles.loadMoreRow}>
                      <Button size="small" appearance="subtle" disabled={rs.loading} onClick={() => {
                        setReplyState(prev => ({ ...prev, [c.id]: { ...prev[c.id], expanded: true } }))
                        if (allReplies.length === 0) handleLoadReplies(c.id)
                      }}>
                        {rs.loading ? t('workshop.loading') : t('workshop.viewReplies', { count: c.reply_count })}
                      </Button>
                    </div>
                  </div>
                )}

                {/* ── 楼中楼回复表单 ── */}
                {isReplyingHere && (
                  <Card className={styles.replyFormCard}>
                    <div className={styles.formRow} style={{ alignItems: 'stretch' }}>
                      <div className={styles.textarea}>
                        <MarkdownEditor
                          value={replyText}
                          onChange={setReplyText}
                          placeholder={t('workshop.replyToUserPlaceholder', { name: replyTo.authorName })}
                          maxLength={Math.max(0, MAX_REPLY_LENGTH - (replyTo.authorName ? `@${replyTo.authorName} `.length : 0))}
                        />
                      </div>
                      <Button
                        appearance="primary" size="small" icon={<Send24Regular />}
                        disabled={!replyText.trim() || submitting}
                        onClick={handleSubmitReply}
                      >
                        {t('workshop.reply')}
                      </Button>
                    </div>
                  </Card>
                )}
              </Card>
            )
          })}

          {/* ── 页码 ── */}
          {totalPages > 1 && (
            <div className={styles.pageRow}>
              <Button size="small" appearance="subtle" disabled={page <= 1} onClick={() => fetchComments(page - 1)}>
                {t('workshop.prevPage')}
              </Button>
              <Text size="small" style={{ padding: '0 8px', lineHeight: '28px' }}>
                {page} / {totalPages}
              </Text>
              <Button size="small" appearance="subtle" disabled={page >= totalPages} onClick={() => fetchComments(page + 1)}>
                {t('workshop.nextPage')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
