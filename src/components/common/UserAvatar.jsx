import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import { getAvatarUrl } from '../../utils/avatars'

const useStyles = makeStyles({
  root: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: '50%',
    overflow: 'hidden',
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontWeight: '600',
    lineHeight: 1,
    userSelect: 'none',
  },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
})

/**
 * 用户头像：有图片时图片填满整圆、不画底色；无图片时显示首字占位。
 * 两种状态共用同一个根节点，尺寸只由 size 决定，不会随有无头像变化。
 */
export function UserAvatar({ avatar, name, size = 18, className }) {
  const styles = useStyles()
  const url = getAvatarUrl(avatar)
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'

  return (
    <span
      className={mergeClasses(styles.root, className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.55)),
        backgroundColor: url ? 'transparent' : undefined,
      }}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" className={styles.image} /> : initial}
    </span>
  )
}

export default UserAvatar
