import { makeStyles, mergeClasses, tokens, Tooltip } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'
import { getAvatarUrl } from '../../utils/avatars'
import { useGameMaster } from '../../contexts/useGameMaster'

const useStyles = makeStyles({
  wrapper: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    verticalAlign: 'middle',
  },
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
  // 游戏领域大神角标：红底白字「神」，右下角压在头像上
  masterBadge: {
    position: 'absolute',
    right: '-2px',
    bottom: '-2px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    backgroundColor: '#D32F2F',
    color: '#FFFFFF',
    // 隶书优先；Linux/macOS 无隶书时退回宋/黑体，保证字符仍可读
    fontFamily: '"LiSu", "STLiti", "SimLi", "隶书", "KaiTi", serif',
    fontWeight: '400',
    lineHeight: 1,
    userSelect: 'none',
  },
})

/**
 * 用户头像：有图片时图片填满整圆、不画底色；无图片时显示首字占位。
 * 两种状态共用同一个根节点，尺寸只由 size 决定，不会随有无头像变化。
 *
 * 传入 userId 且该用户是「游戏领域大神」时，右下角显示红底白字「神」角标。
 */
export function UserAvatar({ avatar, name, size = 18, className, userId = null }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { isMaster } = useGameMaster()
  const url = getAvatarUrl(avatar)
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
  const master = isMaster(userId)
  const badgeSize = Math.max(10, Math.round(size * 0.4))

  return (
    <span className={mergeClasses(styles.wrapper, className)} style={{ width: size, height: size }}>
      <span
        className={styles.root}
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
      {master && (
        <Tooltip content={t('workshop.gameMasterHint')} relationship="description" withArrow>
          <span
            className={styles.masterBadge}
            style={{
              width: badgeSize,
              height: badgeSize,
              fontSize: Math.round(badgeSize * 0.75),
            }}
            role="img"
            aria-label={t('workshop.gameMaster')}
          >
            神
          </span>
        </Tooltip>
      )}
    </span>
  )
}

export default UserAvatar
