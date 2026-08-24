import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Text, Button, Spinner, Select,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  Send24Regular, Delete24Regular, Edit24Regular,
} from '@fluentui/react-icons'
import { resolvePendingImagesInMarkdown, stripPendingUrls, deleteImageFromImgbed, extractImgbedUrls } from '../../services/imageApi'
import { getConfig, setConfig } from '../../services/dbHelper'
import { useAuth } from '../../contexts/useAuth'
import { MarkdownContent, MarkdownEditor } from '../../components/common/RichTextEditor'
import { Lightbox } from '../../components/common/Lightbox'
import { Pagination, UserLink } from '../../components'

const MAX_COMMENT_LENGTH = 3000
const MAX_REPLY_LENGTH = 3000

// 判断评论/回复是否属于当前登录用户：优先用稳定的 author_id，缺失时回退用户名比对
function isOwnItem(item, user) {
  if (!user?.user_id) return false
  if (item?.author_id != null) return Number(item.author_id) === Number(user.user_id)
  return item?.author_name === user.username
}

// 判断当前用户是否有权删除评论/回复：
// - 本人（作者）永远可删；
// - ownerId（帖子楼主）可删自己帖下的所有一楼与楼中楼；
// - 楼中楼场景下，一楼作者（层主）可删自己一楼收到的回复
function canDeleteItem(item, user, ownerId, topComment) {
  if (!user?.user_id) return false
  if (isOwnItem(item, user)) return true
  const uid = Number(user.user_id)
  if (ownerId != null && Number(ownerId) === uid) return true
  if (topComment && Number(topComment.author_id) === uid) return true
  return false
}

// 解析评论内容中的 pending 图片并上传；
// folderPrefix 区分不同实体（mod 用 'sfm'，讨论区用 'sfmmm/discourse'）
async function resolveCommentImages(content, folderPrefix, targetId, commentId) {
  const result = await resolvePendingImagesInMarkdown(content, {
    getFolder: () => `${folderPrefix}/${targetId}/comments/${commentId}`,
  })
  return result.content
}

const useStyles = makeStyles({
  root: { marginTop: '16px', borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '12px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' },
  sortBox: { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap' },
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
  loadMoreRow: { display: 'flex', justifyContent: 'center', marginTop: '8px', marginBottom: '12px', width: '100%' },
  loadMoreBtn: { width: '200px', display: 'block', minWidth: '200px' },
  replyActionBtn: {
    width: '100%', height: '60px',
    '&:hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  quoteBlock: {
    background: tokens.colorNeutralBackground1,
    borderLeft: `3px solid ${tokens.colorNeutralStrokeAccessible}`,
    padding: '8px 12px',
    marginBottom: '8px',
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: 1.4,
    maxHeight: '240px',
    overflowY: 'auto',
  },
})

/**
 * 通用评论组件（mod 评论 / 讨论区评论 两用）。
 * @param {Object} api 评论 API 注入（统一签名，由调用方适配）：
 *   api.list({ targetId, page, page_size })   → { comments, total, totalIncludingReplies, page, page_size }
 *   api.add({ targetId, author_id, content, parent_id }) → { data: { comment_id } }
 *   api.replies({ comment_id, page, page_size }) → { replies, total }
 *   api.edit({ comment_id, author_id, content })
 *   api.del({ comment_id, author_id })
 * @param {number|string} targetId 评论挂载的实体 ID（mod_id / discussion_id）
 * @param {string} [folderPrefix='sfm'] 图床目录前缀（mod='sfm'，讨论区='sfmmm/discourse'）
 * @param {number|string} [ownerId] 内容楼主 ID（讨论区为帖子作者）：楼主可删除帖下所有一楼与楼中楼；同时楼中楼的层主（一楼作者）可删除自己一楼收到的回复
 */
export default function CommentSection({ api, targetId, folderPrefix = 'sfm', scrollToCommentId, ownerId }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const { user, isLoggedIn } = useAuth()

  // 一楼分页
  const [comments, setComments] = useState([])
  const [total, setTotal] = useState(0)
  // 评论总数（含楼中楼），列表页 comment_count 同口径，用于标题展示
  const [commentTotal, setCommentTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  // 灯箱预览：当前查看大图的图片地址
  const [lightboxSrc, setLightboxSrc] = useState(null)

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

  // 个性化浏览习惯：一楼排序方向（desc 新→旧 | asc 旧→新，默认 desc）
  // 与楼中楼排序方向（asc 旧→新 | desc 新→旧，默认 asc），持久化到 sqlite config 表
  const [sortOrder, setSortOrder] = useState('desc')
  const [replyOrder, setReplyOrder] = useState('asc')
  // 偏好是否已从 sqlite 恢复完成（通知定位需等恢复后按最终口径发起，避免口径漂移）
  const [ordersLoaded, setOrdersLoaded] = useState(false)

  const initialFetch = useRef(false)
  // 供 mount 期的 loadOrders 调用（彼时 fetchComments 引用可能过期，ref 转发取最新）
  const fetchCommentsRef = useRef(null)

  // 从 sqlite 恢复浏览习惯（详情页打开即生效，无需登录）
  useEffect(() => {
    const loadOrders = async () => {
      let s = null
      let r = null
      try {
        ;[s, r] = await Promise.all([
          getConfig('comment_sort_order'),
          getConfig('comment_reply_order'),
        ])
        if (s !== 'asc' && s !== 'desc') s = null
        if (r !== 'asc' && r !== 'desc') r = null
      } catch (e) {
        console.warn('[CommentSection] 读取浏览习惯失败:', e)
      }
      // 恢复方向非默认时立即按该方向重拉（与 Discussion 同模式）：
      // 否则首屏仍是默认口径的数据，而排序控件/通知定位已是恢复口径，两者脱节
      const top = s || 'desc'
      const reply = r || 'asc'
      if (s) setSortOrder(s)
      if (r) setReplyOrder(r)
      if (top !== 'desc' || reply !== 'asc') fetchCommentsRef.current(1, top, reply)
      setOrdersLoaded(true)
    }
    loadOrders()
  }, [])

  const saveSortOrder = useCallback(async (v) => {
    try { await setConfig('comment_sort_order', v) } catch (e) { console.warn('[CommentSection] 保存一楼排序失败:', e) }
  }, [])
  const saveReplyOrder = useCallback(async (v) => {
    try { await setConfig('comment_reply_order', v) } catch (e) { console.warn('[CommentSection] 保存回复排序失败:', e) }
  }, [])

  // 接受显式排序参数：切换排序时调用方传入新值，避免 setState 未提交时的陈旧闭包
  // 请求序号防竞态：通知定位可能紧随 initialFetch 发起二次翻页请求，旧响应后到时丢弃
  const fetchSeqRef = useRef(0)
  const fetchComments = useCallback(async (p, sort = sortOrder, reply = replyOrder) => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const data = await api.list({ targetId, page: p, page_size: 10, sort_order: sort, reply_order: reply })
      if (seq !== fetchSeqRef.current) return
      setComments(data.comments)
      setTotal(data.total)
      // 优先使用后端返回的全量计数（含楼中楼）；兜底用 一楼 + 各楼楼中楼之和
      const fallback = data.total + (data.comments || []).reduce((s, c) => s + (c.reply_count || 0), 0)
      setCommentTotal(data.totalIncludingReplies || fallback)
      setPage(data.page)
      setReplyState({})
      setReplyTo(null)
    } catch {
      // silent
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [targetId, api, sortOrder, replyOrder])

  // 供 mount 期的 loadOrders 调用（彼时 fetchComments 尚未定义/引用会过期，ref 转发取最新）
  useEffect(() => { fetchCommentsRef.current = fetchComments }, [fetchComments])

  useEffect(() => {
    if (!initialFetch.current) {
      initialFetch.current = true
      fetchComments(1)
    }
  }, [fetchComments])

  // ── 通知跳转定位（api.locate 可选注入；未注入时退化为纯 DOM 滚动，行为同旧版）──
  // locate 反查目标评论所属一楼/页码/楼中楼排名，解决"目标回复不在 DOM（折叠/跨页）时静默定位失败"
  const [locateInfo, setLocateInfo] = useState(null)
  const locateTriedRef = useRef(false)
  // 目标元素出现过一次即视为定位完成：之后用户手动切排序/翻页不再被推进逻辑拉回
  const locatedRef = useRef(false)
  // 放弃推进（用户改口径 / 定位页确认无目标楼）：不再干预列表
  const locateGaveUpRef = useRef(false)
  useEffect(() => {
    if (!scrollToCommentId || !api.locate || !ordersLoaded || locateTriedRef.current) return
    locateTriedRef.current = true
    // 偏好恢复完成后按最终口径发起，保证定位页码与首屏列表一致；
    // 口径随 locateInfo 携带，后续推进/续传均锁定该口径
    api.locate({ comment_id: scrollToCommentId, top_sort_order: sortOrder, reply_order: replyOrder })
      .then((res) => {
        if (res?.data) setLocateInfo({ ...res.data, top_sort_order: sortOrder, reply_order: replyOrder })
      })
      .catch(() => { /* 定位失败（评论已删等）：退化为原有 DOM 滚动 */ })
  }, [scrollToCommentId, api, ordersLoaded, sortOrder, replyOrder])

  // 定位推进：确保目标评论所在一楼在当前页、楼中楼已展开且分页已覆盖到目标回复；
  // 元素进入 DOM 后由下方滚动 effect 完成滚动与高亮
  useEffect(() => {
    if (!scrollToCommentId || !locateInfo || loading || locatedRef.current || locateGaveUpRef.current) return
    // 用户已手动切换排序口径：放弃推进，避免把列表拉回 locate 时的旧口径
    if (sortOrder !== locateInfo.top_sort_order || replyOrder !== locateInfo.reply_order) {
      locateGaveUpRef.current = true
      return
    }
    const topId = Number(locateInfo.parent_id ?? scrollToCommentId)
    const top = comments.find((c) => Number(c.id) === topId)
    if (!top) {
      if (page !== locateInfo.top_page) {
        // 所属一楼不在当前页：切到定位页码
        // eslint-disable-next-line react-hooks/set-state-in-effect -- effect 内发起请求同步置 loading，与挂载拉取同模式
        fetchComments(locateInfo.top_page, locateInfo.top_sort_order, locateInfo.reply_order)
      } else {
        // 已在定位页仍找不到目标楼（locate 后被新评论挤出该页/已删除）：彻底放弃，不再劫持用户翻页
        locateGaveUpRef.current = true
      }
      return
    }
    if (!locateInfo.parent_id) return // 目标是一楼：交给滚动 effect
    const rs = replyState[topId] || {}
    const visibleIds = new Set([
      ...(top.replies || []).map((r) => Number(r.id)),
      ...(rs.replies || []).map((r) => Number(r.id)),
    ])
    if (visibleIds.has(Number(scrollToCommentId))) {
      // 目标已可见（预览前 2 条或已加载分页内）：折叠态下展开即可
      if (!rs.expanded) {
        setReplyState((prev) => {
          const cur = prev[topId] || { replies: [], page: 0, hasMore: top.has_more, loading: false }
          return { ...prev, [topId]: { ...cur, expanded: true } }
        })
      }
      return
    }
    // 目标在未加载的分页区间：展开并加载覆盖到目标排名的回复
    let cancelled = false
    const needCount = Math.max(0, (locateInfo.reply_index || 1) - 2) // 前 2 条已由预览渲染
    ;(async () => {
      let merged = [...(rs.replies || [])]
      let hasMore = rs.hasMore ?? true
      while (!cancelled && merged.length < needCount && hasMore) {
        const remaining = needCount - merged.length
        // 页大小按 10 对齐（上限 50）：一次请求尽量覆盖，且与后端 offset = 2 + (page-1)*page_size 口径无缝续传
        const pageSize = Math.min(50, Math.max(10, Math.ceil(remaining / 10) * 10))
        const replyPage = Math.floor(merged.length / pageSize) + 1
        try {
          // 排序口径锁定为 locate 时口径，与 reply_index 排名计算一致
          const data = await api.replies({ comment_id: topId, page: replyPage, page_size: pageSize, sort_order: locateInfo.reply_order })
          if (cancelled) return
          const existing = new Set(merged.map((r) => Number(r.id)))
          const got = (data.replies || []).filter((r) => !existing.has(Number(r.id)))
          merged = [...merged, ...got]
          const total = data.total ?? 0
          hasMore = got.length > 0 && 2 + merged.length < total
          setReplyState((prev) => {
            const cur = prev[topId]
            const curIds = new Set((cur?.replies || []).map((r) => Number(r.id)))
            const nextReplies = [...(cur?.replies || []), ...merged.filter((r) => !curIds.has(Number(r.id)))]
            return {
              ...prev,
              [topId]: {
                ...(cur || {}),
                replies: nextReplies,
                // 等效 10 条/页口径的进度：后续"加载更多"从 rs.page+1 续传，不重复不遗漏
                page: Math.floor(nextReplies.length / 10),
                hasMore: 2 + nextReplies.length < total,
                expanded: true,
                loading: false,
              },
            }
          })
        } catch {
          hasMore = false
        }
      }
    })()
    return () => { cancelled = true }
  }, [scrollToCommentId, locateInfo, comments, replyState, loading, page, fetchComments, api, sortOrder, replyOrder])

  // 滚动到指定评论/回复
  const scrollTimerRef = useRef(null)
  useEffect(() => {
    if (!scrollToCommentId || loading) return
    // 延迟等待 DOM 渲染完成
    const tryScroll = (retries = 8) => {
      const el = document.getElementById(`comment-${scrollToCommentId}`) || document.getElementById(`reply-${scrollToCommentId}`)
      if (el) {
        locatedRef.current = true
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
  }, [scrollToCommentId, loading, comments, replyState])

  // 点击回复时平滑滚动到 textarea 区域
  useEffect(() => {
    if (!replyTo) return
    const timer = setTimeout(() => {
      // 找到对应的 reply form 所在的 comment card
      let targetId = replyTo.parentId
      const topComment = comments.find(c => c.id === replyTo.parentId)
      if (!topComment) {
        const found = comments.find(c =>
          c.replies?.some(r => r.id === replyTo.parentId) ||
          replyState[c.id]?.replies?.some(r => r.id === replyTo.parentId)
        )
        if (found) targetId = found.id
      }
      const el = document.getElementById(`reply-form-${targetId}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
    return () => clearTimeout(timer)
  }, [replyTo, comments, replyState])

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
      const res = await api.add({ targetId, author_id: user.user_id, content: safeContent })
      const commentId = res.data.comment_id

      // 2. 上传图片并替换占位符
      const resolvedContent = await resolveCommentImages(content, folderPrefix, targetId, commentId)

      // 3. 更新评论内容为真实 URL
      if (resolvedContent !== safeContent) {
        await api.edit({ comment_id: commentId, author_id: user.user_id, content: resolvedContent })
      }

      // 本地追加，不刷新全页
      setComments(prev => [{
        id: commentId,
        content: resolvedContent,
        author_name: user.username,
        author_avatar: user.avatar,
        author_id: user.user_id,
        created_at: t('workshop.justNow'),
        replies: [],
        reply_count: 0,
        has_more: false,
      }, ...prev])
      setTotal(prev => prev + 1)
      setCommentTotal(prev => prev + 1)
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
      // 同时检查 c.replies（前 2 条预览）和 replyState 中已加载的分页回复
      const top = comments.find(c =>
        c.replies?.some(r => r.id === replyTo.parentId) ||
        replyState[c.id]?.replies?.some(r => r.id === replyTo.parentId)
      )
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
      //    parent_id：所属一楼（扁平楼中楼模型）；reply_to_id：被回复的那条消息（供通知定位被回复人）
      const safeContent = stripPendingUrls(prefixedContent)
      const res = await api.add({ targetId, author_id: user.user_id, content: safeContent, parent_id: topId, reply_to_id: replyTo.parentId })
      const replyId = res.data.comment_id

      // 2. 上传图片并替换占位符
      const resolvedContent = await resolveCommentImages(prefixedContent, folderPrefix, targetId, replyId)

      // 3. 更新回复内容为真实 URL
      if (resolvedContent !== safeContent) {
        await api.edit({ comment_id: replyId, author_id: user.user_id, content: resolvedContent })
      }

      const newReply = {
        id: replyId,
        content: resolvedContent,
        author_name: user.username,
        author_avatar: user.avatar,
        author_id: user.user_id,
        created_at: t('workshop.justNow'),
      }
      // 找到所属一楼，更新计数并把新回复追加到 rs.replies 末尾（保持正确顺序）
      setComments(prev => prev.map(c => {
        if (c.id === topId) {
          return {
            ...c,
            reply_count: (c.reply_count || 0) + 1,
            has_more: (c.reply_count || 0) + 1 > 2,
          }
        }
        return c
      }))
      setCommentTotal(prev => prev + 1)
      setReplyState(prev => ({
        ...prev,
        [topId]: {
          ...(prev[topId] || { replies: [], page: 0, hasMore: true, loading: false }),
          replies: [...(prev[topId]?.replies || []), newReply],
          hasMore: (prev[topId]?.replies?.length || 0) + 1 >= 10,
          expanded: prev[topId]?.expanded ?? true,
          loading: false,
        },
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

      await api.del({ comment_id: commentId, author_id: user.user_id })

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
        // 删除一楼需同时减去其下所有楼中楼
        setCommentTotal(prev => Math.max(0, prev - 1 - (topComment?.reply_count || 0)))
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
      setCommentTotal(prev => Math.max(0, prev - 1))
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
      const resolvedContent = await resolveCommentImages(content, folderPrefix, targetId, commentId)
      await api.edit({ comment_id: commentId, author_id: user.user_id, content: resolvedContent })

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
      const data = await api.replies({ comment_id: commentId, page: nextPage, page_size: 10, sort_order: replyOrder })
      setReplyState(prev => {
        const cur = prev[commentId]
        // 去重追加：通知定位可能已按非 10 倍数进度预加载，续传时跳过已加载的回复
        const curIds = new Set((cur?.replies || []).map(r => Number(r.id)))
        const add = (data.replies || []).filter(r => !curIds.has(Number(r.id)))
        const nextReplies = [...(cur?.replies || []), ...add]
        return {
          ...prev,
          [commentId]: {
            ...cur,
            replies: nextReplies,
            page: Math.floor(nextReplies.length / 10),
            hasMore: add.length > 0 && 2 + nextReplies.length < (data.total || 0),
            loading: false,
          },
        }
      })
    } catch {
      setReplyState(prev => ({ ...prev, [commentId]: { ...prev[commentId], loading: false } }))
    }
  }

  const totalPages = Math.ceil(total / 10)

  return (
    <div className={styles.root}>
      <div className={styles.titleRow}>
        <Text weight="semibold" size={400} className={styles.title}>
          {t('workshop.comment', { count: commentTotal })}
        </Text>
        <div className={styles.sortBox}>
          <Text size="small">{t('workshop.commentSortLabel')}</Text>
          <Select
            size="small"
            value={sortOrder}
            onChange={(_, d) => {
              const v = d.value
              setSortOrder(v)
              saveSortOrder(v)
              // 显式传新值拉取，避免陈旧闭包导致仍按旧方向请求
              fetchComments(1, v, replyOrder)
            }}
          >
            <option value="desc">{t('workshop.sortNewestFirst')}</option>
            <option value="asc">{t('workshop.sortOldestFirst')}</option>
          </Select>
          <Text size="small">{t('workshop.replySortLabel')}</Text>
          <Select
            size="small"
            value={replyOrder}
            onChange={(_, d) => {
              const v = d.value
              setReplyOrder(v)
              saveReplyOrder(v)
              // 显式传新值拉取，避免陈旧闭包导致仍按旧方向请求
              fetchComments(1, sortOrder, v)
            }}
          >
            <option value="asc">{t('workshop.sortOldestFirst')}</option>
            <option value="desc">{t('workshop.sortNewestFirst')}</option>
          </Select>
        </div>
      </div>

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
            const allReplies = [...(c.replies || []), ...(rs.replies || [])]
            const isReplyingHere = replyTo && (replyTo.parentId === c.id || allReplies.some(r => r.id === replyTo.parentId))
            const isExpanded = rs.expanded

            return (
              <Card key={c.id} id={`comment-${c.id}`} className={styles.commentItem}>
                {/* ── 一楼头部 ── */}
                <div className={styles.commentHeader}>
                  <UserLink
                    userId={c.author_id}
                    username={c.author_name}
                    avatar={c.author_avatar}
                    size={20}
                    nameSize={200}
                    nameBold
                  />
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
                    <MarkdownContent markdown={c.content} onImageClick={setLightboxSrc} />
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
                  {isOwnItem(c, user) && editingId !== c.id && (
                    <Button size="small" appearance="subtle" icon={<Edit24Regular />} onClick={() => {
                      setEditingId(c.id)
                      setEditText(c.content)
                    }} />
                  )}
                  {canDeleteItem(c, user, ownerId, null) && (
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button size="small" appearance="subtle" icon={<Delete24Regular />} />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem onClick={() => handleDelete(c.id)}>
                            {t('workshop.confirmDelete')}
                          </MenuItem>
                          <MenuItem>
                            {t('workshop.cancel')}
                          </MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
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
                          <UserLink
                            userId={r.author_id}
                            username={r.author_name}
                            avatar={r.author_avatar}
                            size={16}
                            nameSize={200}
                            nameBold
                          />
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
                            <MarkdownContent markdown={r.content} onImageClick={setLightboxSrc} />
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
                          {isOwnItem(r, user) && editingId !== r.id && (
                            <Button size="small" appearance="subtle" icon={<Edit24Regular />} onClick={() => {
                              setEditingId(r.id)
                              setEditText(r.content)
                            }} />
                          )}
                          {canDeleteItem(r, user, ownerId, c) && (
                            <Menu>
                              <MenuTrigger disableButtonEnhancement>
                                <Button size="small" appearance="subtle" icon={<Delete24Regular />} />
                              </MenuTrigger>
                              <MenuPopover>
                                <MenuList>
                                  <MenuItem onClick={() => handleDelete(r.id)}>
                                    {t('workshop.confirmDelete')}
                                  </MenuItem>
                                  <MenuItem>
                                    {t('workshop.cancel')}
                                  </MenuItem>
                                </MenuList>
                              </MenuPopover>
                            </Menu>
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
                        <Button size="small" appearance="subtle" disabled={rs.loading} className={styles.loadMoreBtn} onClick={() => handleLoadReplies(c.id)}>
                          {rs.loading ? t('workshop.loading') : t('workshop.loadMoreReplies', { count: c.reply_count })}
                        </Button>
                      </div>
                    )}

                    {/* 折叠回复 - 仅在回复数 > 2 时显示 */}
                    {(c.reply_count || 0) > 2 && (
                      <div className={styles.loadMoreRow}>
                        <Button size="small" appearance="outline" className={styles.replyActionBtn} onClick={() =>
                          setReplyState(prev => ({ ...prev, [c.id]: { ...prev[c.id], expanded: false } }))
                        }>
                          {t('workshop.foldReplies')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {!isExpanded && c.reply_count > 0 && (
                  <div className={styles.replyList} style={{ borderLeft: 'none', paddingLeft: 0 }}>
                    {c.replies?.map(r => (
                      <Card key={r.id} id={`reply-${r.id}`} className={styles.replyItem}>
                        <div className={styles.commentHeader}>
                          <UserLink
                            userId={r.author_id}
                            username={r.author_name}
                            avatar={r.author_avatar}
                            size={16}
                            nameSize={200}
                            nameBold
                          />
                          <Text className={styles.commentTime}>{r.created_at}</Text>
                        </div>
                        <div className={styles.commentContent}>
                          <MarkdownContent markdown={r.content} onImageClick={setLightboxSrc} />
                        </div>
                      </Card>
                    ))}
                    <div style={{ textAlign: 'center', marginTop: '8px', marginBottom: '12px' }}>
                      <Button size="small" appearance="outline" disabled={rs.loading} className={styles.replyActionBtn} onClick={() => {
                        setReplyState(prev => ({ ...prev, [c.id]: { ...prev[c.id], expanded: true } }))
                        if (rs.page === 0) handleLoadReplies(c.id)
                      }}>
                        {rs.loading ? t('workshop.loading') : t('workshop.viewReplies', { count: c.reply_count })}
                      </Button>
                    </div>
                  </div>
                )}

                {/* ── 楼中楼回复表单 ── */}
                {isReplyingHere && (
                  <Card className={styles.replyFormCard} id={`reply-form-${c.id}`}>
                    {(() => {
                      // 找到被回复的内容
                      let quotedContent = ''
                      if (replyTo.parentId === c.id) {
                        quotedContent = c.content
                      } else {
                        const found = allReplies.find(r => r.id === replyTo.parentId)
                        if (found) quotedContent = found.content
                      }
                      return quotedContent ? (
                        <div className={styles.quoteBlock}>
                          <Text weight="semibold" size={200}>{replyTo.authorName}</Text>
                          <MarkdownContent markdown={quotedContent} onImageClick={setLightboxSrc} />
                        </div>
                      ) : null
                    })()}
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
                        style={{ width: '200px' }}
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
          <Pagination page={page} totalPages={totalPages} onChange={(p) => fetchComments(p)} />
        </>
      )}

      {/* 图片灯箱预览 */}
      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </div>
  )
}
