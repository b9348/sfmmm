import { useTranslation } from 'react-i18next'
import {
  Card, CardHeader, Text, Avatar,
  makeStyles, tokens, Badge,
} from '@fluentui/react-components'
import {
  HeartRegular,
  HeartFilled,
  CommentRegular,
} from '@fluentui/react-icons'
import { FileRow } from '../../components'
import { RatingStarsDisplay } from '../../components/common/RatingStars'
import { getAvatarUrl } from '../../utils/avatars'

const CATEGORIES = [
  { value: 'v1', label: 'v1' },
  { value: 'v2', label: 'v2' },
  { value: 'dll', label: 'dll' },
  { value: 'composite', label: 'composite' },
]

const useStyles = makeStyles({
  card: {
    padding: '12px',
    cursor: 'pointer',
    height: '100%',
    minHeight: '220px',
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
})

export function ModCard({ mod, onClick, onMouseEnter, onMouseLeave, onMouseDown }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const cat = CATEGORIES.find(c => c.value === mod.category)

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
        header={
          <Text size="small" className={styles.meta} truncate>{mod.mod_key}</Text>
        }
        description={
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
              {getAvatarUrl(mod.author_avatar) ? (
                <img
                  src={getAvatarUrl(mod.author_avatar)}
                  alt={mod.author_name || ''}
                  style={{ width: 16, height: 16, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0 }}
                />
              ) : (
                <Avatar name={mod.author_name || '?'} size={20} color="brand" />
              )}
              <Text size={100} className={styles.meta} truncate>{mod.author_name}</Text>
            </div>
            <Text size="small" className={styles.meta}>
              {mod.updated_at && mod.updated_at > mod.created_at
                ? `${t('workshop.updatedAt')}: ${mod.updated_at}`
                : mod.created_at}
            </Text>
          </div>
        }
        action={
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                <CommentRegular style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />
                <Text size="small">{mod.comment_count || 0}</Text>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }} title={mod.is_liked ? t('workshop.likedHint') : t('workshop.unlikedHint')}>
                {mod.is_liked ? (
                  <HeartFilled style={{ color: tokens.colorPaletteRedForeground1, fontSize: '16px' }} />
                ) : (
                  <HeartRegular style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />
                )}
                <Text size="small">{mod.like_count || 0}</Text>
              </div>
              <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
                {cat ? t(`workshop.category_${cat.value}`) : (mod.category ? t(`workshop.category_${mod.category}`, mod.category) : t('workshop.uncategorized'))}
              </Badge>
            </div>
            {mod.rating_count > 0 && (
              <RatingStarsDisplay value={mod.rating_avg} count={mod.rating_count} size="small" compact />
            )}
          </div>
        }
      />
      <div className={styles.cardBody}>
        {mod.description && (
          <Text size="small" className={styles.description}>{mod.description}</Text>
        )}
        {mod.files && mod.files.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {mod.files.map(f => {
              const langName = mod.translations?.[f.lang_code]?.name || mod.display_name
              return (
                <FileRow key={f.lang_code} langCode={f.lang_code} name={langName} version={f.version} fileSize={f.file_size} />
              )
            })}
          </div>
        )}
      </div>
    </Card>
  )
}

export default ModCard
