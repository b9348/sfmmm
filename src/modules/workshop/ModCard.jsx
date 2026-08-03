import { useTranslation } from 'react-i18next'
import {
  Card, CardHeader, Text,
  makeStyles, tokens, Badge,
} from '@fluentui/react-components'
import {
  HeartRegular,
  HeartFilled,
  CommentRegular,
} from '@fluentui/react-icons'
import { FileRow, UserLink } from '../../components'

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

export function ModCard({ mod, onClick }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const cat = CATEGORIES.find(c => c.value === mod.category)

  return (
    <Card className={styles.card} appearance="outline" onClick={onClick}>
      <CardHeader
        header={
          <Text size="small" className={styles.meta} truncate>{mod.mod_key}</Text>
        }
        description={
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <UserLink
              userId={mod.author_id}
              username={mod.author_name}
              avatar={mod.author_avatar}
              size={16}
              nameSize={100}
            />
            <Text size="small" className={styles.meta}>
              {mod.updated_at && mod.updated_at !== mod.created_at ? mod.updated_at : mod.created_at}
            </Text>
          </div>
        }
        action={
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
