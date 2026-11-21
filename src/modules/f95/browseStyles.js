import { makeStyles, tokens } from '@fluentui/react-components'

export const useF95BrowseStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  grid: {
    display: 'grid',
    gap: '12px',
  },
})

export const useF95CardStyles = makeStyles({
  card: {
    padding: '12px',
    cursor: 'pointer',
    height: '100%',
    minHeight: '220px',
    display: 'flex',
    flexDirection: 'column',
    transition: 'box-shadow 0.2s ease, background-color 0.2s ease',
    '&:hover': {
      boxShadow: tokens.shadow4,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeBase400,
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
  },
  description: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    minHeight: 'calc(1.4em * 2)',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
  },
})
