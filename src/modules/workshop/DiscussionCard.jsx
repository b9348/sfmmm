import { useTranslation } from 'react-i18next'
import {
  Card, CardHeader, Text, Avatar, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  HeartRegular,
  HeartFilled,
  CommentRegular,
} from '@fluentui/react-icons'
import { getAvatarUrl } from '../../utils/avatars'
import { extractFirstImage } from '../../utils/extractFirstImage'

const POLL_TYPE_LABELS = {
  single: 'discussion.pollSingle',
  multiple: 'discussion.pollMultiple',
  number: 'discussion.pollNumber',
}

const useStyles = makeStyles({
  card: {
    padding: '12px',
    cursor: 'pointer',
    height: '100%',
    minHeight: '160px',
    transition: 'box-shadow 0.2s ease',
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginTop: '8px',
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: 600,
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  description: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
  },
  thumb: {
    maxWidth: '33.33%',
    maxHeight: '140px',
    objectFit: 'cover',
    borderRadius: '6px',
    display: 'block',
    backgroundColor: tokens.colorNeutralBackground1Hover,
  },
})

export function DiscussionCard({ discussion, onClick, onMouseEnter, onMouseLeave, onMouseDown }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const { poll } = discussion
  const { image, text } = extractFirstImage(discussion.content)

  return (
    <Card
      className={styles.card}
      appearance="outline"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={onMouseDown}
    >
      <CardHeader
        header={<Text className={styles.title} truncate>{discussion.title}</Text>}
        description={
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
              {getAvatarUrl(discussion.author_avatar) ? (
                <img
                  src={getAvatarUrl(discussion.author_avatar)}
                  alt={discussion.author_name || ''}
                  style={{ width: 16, height: 16, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0 }}
                />
              ) : (
                <Avatar name={discussion.author_name || '?'} size={20} color="brand" />
              )}
              <Text size={100} className={styles.meta} truncate>{discussion.author_name}</Text>
            </div>
            <Text size="small" className={styles.meta}>
              {discussion.updated_at && discussion.updated_at > discussion.created_at
                ? `${t('workshop.updatedAt')}: ${discussion.updated_at}`
                : discussion.created_at}
            </Text>
          </div>
        }
        action={
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }} title={t('workshop.unlikedHint')}>
                {discussion.is_liked ? (
                  <HeartFilled style={{ color: tokens.colorPaletteRedForeground1, fontSize: '16px' }} />
                ) : (
                  <HeartRegular style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />
                )}
                <Text size="small">{discussion.like_count || 0}</Text>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <CommentRegular style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />
                <Text size="small">{discussion.comment_count || 0}</Text>
              </div>
              {discussion.type === 'poll' && (
                <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
                  {t(POLL_TYPE_LABELS[poll?.poll_type] || 'discussion.pollSingle')}
                </Badge>
              )}
            </div>
          </div>
        }
      />
      <div className={styles.cardBody}>
        {image && <img src={image} alt="" className={styles.thumb} loading="lazy" />}
        {text && (
          <Text size="small" className={styles.description}>{text}</Text>
        )}
      </div>
    </Card>
  )
}

export default DiscussionCard
