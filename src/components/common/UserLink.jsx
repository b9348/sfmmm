import { makeStyles, tokens, Avatar, Text } from '@fluentui/react-components'
import { useUserNav } from '../../contexts/useUserNav'
import { getAvatarUrl } from '../../utils/avatars'

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 6px',
    margin: '-2px -6px',
    border: 'none',
    backgroundColor: 'transparent',
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
  avatarImg: {
    flexShrink: 0,
    display: 'block',
  },
  nameCol: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    minWidth: 0,
    overflow: 'hidden',
  },
  name: {
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '100%',
    transition: 'color 0.15s ease',
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
 * @param {string|null} secondary        - 用户名下方的次要文本（如邮箱/时间）
 * @param {string} nameSize              - 用户名字号：Fluent Text size（100~500），默认 200
 * @param {boolean} nameBold             - 用户名是否加粗
 * @param {string} className             - 额外样式类
 */
export function UserLink({
  userId,
  username,
  avatar,
  size = 24,
  showName = true,
  secondary = null,
  nameSize = 200,
  nameBold = false,
  className = '',
}) {
  const styles = useStyles()
  const { openUser } = useUserNav()

  const clickable = userId != null && userId !== 0
  const avatarUrl = getAvatarUrl(avatar)

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
      aria-label={username}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={username}
          className={styles.avatarImg}
          style={{ width: `${size}px`, height: `${size}px` }}
        />
      ) : (
        <Avatar name={username || '?'} size={size <= 20 ? 20 : size <= 24 ? 24 : size <= 28 ? 28 : size <= 32 ? 32 : size <= 36 ? 36 : size <= 40 ? 40 : 48} color="brand" />
      )}
      {showName && (
        <span className={styles.nameCol}>
          <Text
            size={nameSize}
            weight={nameBold ? 'semibold' : 'regular'}
            className={`${styles.name} userlink-name`}
          >
            {username}
          </Text>
          {secondary && (
            <Text size={100} className={styles.secondary}>{secondary}</Text>
          )}
        </span>
      )}
    </button>
  )
}
