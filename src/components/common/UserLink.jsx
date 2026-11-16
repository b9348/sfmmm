import { makeStyles, tokens, Text } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { useUserNav } from '../../contexts/useUserNav'
import { useGameMaster } from '../../contexts/useGameMaster'
import { UserAvatar } from './UserAvatar'

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 6px',
    margin: '-2px -6px',
    border: 'none',
    backgroundColor: 'transparent',
    // 深色模式下兜底：UA 给 <button> 的 color: buttontext（系统亮色时为纯黑）
    // 会压过主题继承，必须在根上显式给主题色，避免子元素颜色规则失效时透出黑字
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    maxWidth: '100%',
    minWidth: 0,
    fontFamily: 'inherit',
    transition: 'background-color 0.15s ease',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    '&:hover .userlink-name': {
      color: tokens.colorBrandForeground1,
      textDecorationLine: 'underline',
    },
  },
  disabled: {
    cursor: 'default',
    '&:hover': {
      backgroundColor: 'transparent',
    },
    '&:hover .userlink-name': {
      color: 'inherit',
      textDecorationLine: 'none',
    },
  },
  nameCol: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    minWidth: 0,
    overflow: 'hidden',
  },
  nameRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '6px',
    minWidth: 0,
    maxWidth: '100%',
  },
  name: {
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '100%',
    minWidth: 0,
    transition: 'color 0.15s ease',
  },
  masterTag: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  secondary: {
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '100%',
  },
})

/**
 * 可点击的用户信息区域（头像 + 用户名），点击打开该用户的个人资料弹窗。
 *
 * @param {number|string|null} userId    - 用户唯一标识（无则不可点击，仅展示）
 * @param {string} username              - 用户名
 * @param {string|null} avatar           - 头像文件名（数据库存储值）
 * @param {number} size                  - 头像尺寸（px），默认 24
 * @param {boolean} showName             - 是否显示用户名，默认 true
 * @param {boolean} hideAvatar           - 是否隐藏头像（仅显示用户名），默认 false
 * @param {string|null} secondary        - 用户名下方的次要文本（如邮箱/时间）
 * @param {string} nameSize              - 用户名字号：Fluent Text size（100~500），默认 200
 * @param {boolean} nameBold             - 用户名是否加粗
 * @param {boolean} showMasterTag        - 是「游戏领域大神」时在用户名后显示小字标签
 * @param {string} className             - 额外样式类
 */
export function UserLink({
  userId,
  username,
  avatar,
  size = 24,
  showName = true,
  hideAvatar = false,
  secondary = null,
  nameSize = 200,
  nameBold = false,
  showMasterTag = false,
  className = '',
}) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { openUser } = useUserNav()
  const { isMaster } = useGameMaster()

  const displayName = username || t('workshop.deletedUser')
  const clickable = userId != null && userId !== 0 && !!username
  const showBadge = showMasterTag && isMaster(userId)

  const handleClick = (e) => {
    // 卡片/列表项自身往往可点击，避免冒泡触发外层跳转
    e.stopPropagation()
    if (!clickable) return
    openUser({ userId, username, avatar })
  }

  return (
    <button
      type="button"
      className={`${styles.root} ${clickable ? '' : styles.disabled} ${className}`}
      onClick={handleClick}
      title={clickable ? username : undefined}
      aria-label={displayName}
    >
      {!hideAvatar && <UserAvatar avatar={avatar} name={displayName} size={size} userId={userId} />}
      {showName && (
        <span className={styles.nameCol}>
          <span className={styles.nameRow}>
            <Text
              size={nameSize}
              weight={nameBold ? 'semibold' : 'regular'}
              className={`${styles.name} userlink-name`}
            >
              {displayName}
            </Text>
            {showBadge && (
              <Text size={100} className={styles.masterTag}>{t('workshop.gameMaster')}</Text>
            )}
          </span>
          {secondary && (
            <Text size={100} className={styles.secondary}>{secondary}</Text>
          )}
        </span>
      )}
    </button>
  )
}
