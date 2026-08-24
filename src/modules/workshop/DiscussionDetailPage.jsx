import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Badge, makeStyles, tokens,
} from '@fluentui/react-components'
import {
  Heart24Regular, Heart24Filled, Delete24Regular, ArrowLeft24Regular, Edit24Regular,
} from '@fluentui/react-icons'
import {
  likeDiscussion, unlikeDiscussion, boostDiscussion, unboostDiscussion, deleteDiscussion, getDiscussionDetail,
  addDiscussionComment, getDiscussionComments, getDiscussionReplies, editDiscussionComment, deleteDiscussionComment,
  locateDiscussionComment,
} from '../../services/workshopApi'
import { useAuth } from '../../contexts/useAuth'
import { RichTextContent, MarkdownContent } from '../../components/common/RichTextEditor'
import { Lightbox } from '../../components/common/Lightbox'
import { BackButton, FloatingActions, UserLink } from '../../components'
import CommentSection from './CommentSection'
import PollBlock from './PollBlock'
import BoostPanel from './BoostPanel'
import { CreateDiscussionPage } from './CreateDiscussionPage'

const POLL_TYPE_LABELS = {
  single: 'discussion.pollSingle',
  multiple: 'discussion.pollMultiple',
  number: 'discussion.pollNumber',
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    flexShrink: 0,
  },
  scrollArea: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '0 16px 16px',
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: 600,
    wordBreak: 'break-word',
  },
  authorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    marginTop: '8px',
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
  },
  body: {
    marginTop: '12px',
    lineHeight: '1.6',
    wordBreak: 'break-word',
  },
  stats: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '12px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
  },
})

/**
 * 讨论详情页：标题/作者/正文/投票/boost/评论；
 * 复用 CommentSection（注入 discussion 评论 API）与 PollBlock / BoostPanel。
 */
export function DiscussionDetailPage({ discussion, onBack, scrollToCommentId, onUpdated, onDeleted }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const { user, isLoggedIn } = useAuth()
  const [detail, setDetail] = useState(discussion)
  const [likeBusy, setLikeBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false)
  // 灯箱预览：点击正文图片查看大图（与 CommentSection 同模式）
  const [lightboxSrc, setLightboxSrc] = useState(null)

  useEffect(() => { setDetail(discussion) }, [discussion])

  // 评论 API 适配器：讨论区评论 → CommentSection 统一签名；
  // useMemo 保持引用稳定，避免 CommentSection 的 fetchComments useCallback 每次渲染重建
  const discussionCommentApi = useMemo(() => ({
    list: (args) => getDiscussionComments({ discussion_id: args.targetId, page: args.page, page_size: args.page_size, sort_order: args.sort_order, reply_order: args.reply_order }),
    add: (args) => addDiscussionComment({ discussion_id: args.targetId, author_id: args.author_id, content: args.content, parent_id: args.parent_id, reply_to_id: args.reply_to_id }),
    replies: (args) => getDiscussionReplies({ comment_id: args.comment_id, page: args.page, page_size: args.page_size, sort_order: args.sort_order }),
    locate: (args) => locateDiscussionComment({ comment_id: args.comment_id, top_sort_order: args.top_sort_order, reply_sort_order: args.reply_order }),
    edit: (args) => editDiscussionComment({ comment_id: args.comment_id, author_id: args.author_id, content: args.content }),
    del: (args) => deleteDiscussionComment({ comment_id: args.comment_id, author_id: args.author_id }),
  }), [])

  const canEdit = !!user && Number(detail.author_id) === Number(user.user_id)

  // 互动后从后端重拉详情（保证 boosts 列表/投票结果等一致），并回传父级刷新列表计数
  const refreshDetail = useCallback(async () => {
    try {
      const res = await getDiscussionDetail(detail.id, user?.user_id)
      if (res.data) {
        setDetail(res.data)
        onUpdated?.(res.data)
      }
    } catch { /* silent */ }
  }, [detail.id, user, onUpdated])

  const handleLikeToggle = async () => {
    if (!isLoggedIn) { alert(t('discussion.loginRequired')); return }
    if (likeBusy) return
    setLikeBusy(true)
    try {
      if (detail.is_liked) {
        await unlikeDiscussion({ discussion_id: detail.id, user_id: user.user_id })
      } else {
        await likeDiscussion({ discussion_id: detail.id, user_id: user.user_id })
      }
      await refreshDetail()
    } catch (e) {
      alert(t('discussion.likeFailed') + (e?.message || e))
    } finally {
      setLikeBusy(false)
    }
  }

  const handleBoost = async (content) => {
    if (!isLoggedIn) { alert(t('discussion.loginRequired')); return }
    await boostDiscussion({ discussion_id: detail.id, user_id: user.user_id, content })
    await refreshDetail()
  }

  const handleUnboost = async () => {
    if (!isLoggedIn) return
    await unboostDiscussion({ discussion_id: detail.id, user_id: user.user_id })
    await refreshDetail()
  }

  const handleDelete = async () => {
    if (!canEdit || deleting) return
    setDeleting(true)
    try {
      await deleteDiscussion({ author_id: user.user_id, discussion_id: detail.id })
      onDeleted?.()
    } catch (e) {
      alert(t('discussion.deleteFailed') + (e?.message || e))
    } finally {
      setDeleting(false)
    }
  }

  const poll = detail.poll || null

  // 编辑模式：复用 CreateDiscussionPage（initial 预填标题/正文），保存后刷新详情
  if (editing) {
    return (
      <CreateDiscussionPage
        authorId={user?.user_id}
        initial={detail}
        onClose={() => setEditing(false)}
        onCreated={() => {
          setEditing(false)
          refreshDetail()
        }}
      />
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbarRow}>
        <BackButton onClick={onBack} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text className={styles.title} block>{detail.title}</Text>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {detail.type === 'poll' && poll && (
            <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
              {t(POLL_TYPE_LABELS[poll.poll_type] || 'discussion.pollSingle')}
            </Badge>
          )}
          {detail.status !== 'active' && (
            <Badge appearance="filled" size="small">{t('discussion.postDeleted')}</Badge>
          )}
        </div>
      </div>

      <div className={styles.scrollArea}>
        <div className={styles.authorRow}>
          <UserLink
            userId={detail.author_id}
            username={detail.author_name}
            avatar={detail.author_avatar}
            size={24}
            nameSize={200}
          />
          <Text size="small" className={styles.meta}>
            {detail.updated_at && detail.updated_at !== detail.created_at
              ? `${t('workshop.updatedAt')}: ${detail.updated_at}`
              : `${t('workshop.createdAt')}: ${detail.created_at}`}
          </Text>
        </div>

        {detail.content && (
          <div className={styles.body}>
            {detail.content_format === 'richtext'
              ? <RichTextContent html={detail.content} />
              : <MarkdownContent markdown={detail.content} onImageClick={setLightboxSrc} />}
          </div>
        )}

        {poll && (
          <PollBlock
            poll={poll}
            discussionId={detail.id}
            userId={user?.user_id}
            isLoggedIn={isLoggedIn}
            onVoted={refreshDetail}
          />
        )}

        <BoostPanel
          boosts={detail.boosts || []}
          myBoost={detail.my_boost}
          discussionId={detail.id}
          userId={user?.user_id}
          isLoggedIn={isLoggedIn}
          onBoost={handleBoost}
          onUnboost={handleUnboost}
        />

        <div className={styles.stats}>
          <Text size="small">{t('discussion.likeCount', { count: detail.like_count || 0 })}</Text>
        </div>

        <CommentSection
          api={discussionCommentApi}
          targetId={detail.id}
          folderPrefix="sfmmm/discourse"
          ownerId={detail.author_id}
          scrollToCommentId={scrollToCommentId}
        />
      </div>

      <FloatingActions items={[
        { key: 'back', icon: <ArrowLeft24Regular />, onClick: onBack },
        {
          key: 'like',
          icon: detail.is_liked ? <Heart24Filled /> : <Heart24Regular />,
          appearance: detail.is_liked ? 'primary' : 'outline',
          onClick: handleLikeToggle,
          disabled: likeBusy,
          label: String(detail.like_count || 0),
        },
        ...(canEdit ? [
          { key: 'edit', icon: <Edit24Regular />, appearance: 'outline', onClick: () => setEditing(true), label: t('discussion.edit') },
          { key: 'delete', icon: <Delete24Regular />, appearance: 'outline', disabled: deleting, label: t('discussion.delete'),
            menu: {
              confirmLabel: t('workshop.confirmDelete'),
              cancelLabel: t('workshop.cancel'),
              onConfirm: handleDelete,
            } },
        ] : []),
      ]} />

      {/* 图片灯箱预览（与 CommentSection 同模式） */}
      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
    </div>
  )
}

export default DiscussionDetailPage
