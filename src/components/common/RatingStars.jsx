import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Rating,
  RatingDisplay,
  Text,
  makeStyles,
  tokens,
  mergeClasses,
} from '@fluentui/react-components'

/**
 * 模组评分组件（组件化封装）
 *
 * - RatingStars        —— 可交互评分（0~5 星、支持半星 step=0.5，点击后带 pop 动画）
 * - RatingStarsDisplay —— 只读展示（均分 + 人数），用于卡片/详情
 * - roundHalf          —— 评分取整到 0.5 档位（供外部同步均分显示用）
 *
 * 视觉约定：未亮星为灰色（Fluent neutral 默认），已亮星为亮色（marigold 金）。
 */

const useStyles = makeStyles({
  interactive: {
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'pointer',
    transition: 'transform 0.15s ease',
    ':hover': {
      transform: 'scale(1.04)',
    },
  },
  disabled: {
    cursor: 'default',
    ':hover': {
      transform: 'none',
    },
    opacity: 0.6,
  },
  pop: {
    animationName: {
      '0%': { transform: 'scale(1)' },
      '35%': { transform: 'scale(1.25)' },
      '100%': { transform: 'scale(1)' },
    },
    animationDuration: '0.35s',
    animationTimingFunction: 'ease-out',
  },
  readOnly: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: tokens.colorNeutralForeground2,
  },
  countText: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
  },
})

/** 将任意数值取整到 0.5 档位（0.5 ~ 5.0） */
export function roundHalf(v) {
  const n = Math.round(Number(v) * 2) / 2
  if (!Number.isFinite(n)) return 0
  return Math.min(5, Math.max(0, n))
}

/**
 * 可交互评分
 * @param {number} value        当前评分（0 表示未评）
 * @param {(v:number)=>void} onChange 用户点击后的回调（传入 0.5 档位值）
 * @param {'small'|'medium'|'large'} size
 * @param {boolean} disabled    禁用（未登录/提交中）
 * @param {'brand'|'marigold'|'neutral'} color 已亮星颜色
 */
export function RatingStars({
  value = 0,
  onChange,
  size = 'medium',
  disabled = false,
  color = 'marigold',
  className,
  ...rest
}) {
  const styles = useStyles()
  const [pulse, setPulse] = useState(false)
  const pulseTimer = useRef(null)

  const handleChange = (_, data) => {
    if (disabled) return
    const v = roundHalf(data.value)
    // 触发一次 pop 动画
    setPulse(true)
    if (pulseTimer.current) clearTimeout(pulseTimer.current)
    pulseTimer.current = setTimeout(() => setPulse(false), 400)
    onChange?.(v)
  }

  return (
    <span
      className={mergeClasses(
        styles.interactive,
        disabled && styles.disabled,
        pulse && styles.pop,
        className,
      )}
      title={value > 0 ? `${value} / 5` : undefined}
    >
      <Rating
        step={0.5}
        value={value}
        onChange={handleChange}
        size={size}
        color={color}
        readOnly={disabled}
        {...rest}
      />
    </span>
  )
}

/**
 * 只读评分展示（均分 + 人数）
 * @param {number} value   均分（0 ~ 5）
 * @param {number} count   评分人数
 * @param {'small'|'medium'|'large'} size
 * @param {boolean} compact 是否紧凑模式（卡片用，隐藏人数文字只留数字）
 */
export function RatingStarsDisplay({
  value = 0,
  count = 0,
  size = 'small',
  compact = false,
  color = 'marigold',
  className,
  ...rest
}) {
  const styles = useStyles()
  return (
    <span className={mergeClasses(styles.readOnly, className)} {...rest}>
      <RatingDisplay
        value={roundHalf(value)}
        count={count}
        size={size}
        color={color}
        compact={compact}
      />
      {!compact && count > 0 && (
        <span className={styles.countText}>
          ({count})
        </span>
      )}
    </span>
  )
}

/**
 * 详情页合并评分组件 —— 只用一组星，既展示均分又能交互打分。
 *
 * - 未登录：只读均分星 + 人数文字 + "登录后评分" 提示
 * - 登录未评分：可交互空星 + 旁边均分提示
 * - 登录已评分：显示用户自己打的分（可改/可清），旁边小字显示均分 (ratingAvg · count 人)
 *
 * @param {number} ratingAvg  均分
 * @param {number} ratingCount 评分人数
 * @param {number} myRating   当前用户评分（0 表示未评）
 * @param {boolean} canRate   是否允许交互（已登录）
 * @param {boolean} busy      提交中
 * @param {(v:number)=>void} onRate  打分回调
 * @param {'small'|'medium'|'large'} size
 */
export function RatingStarsInteractiveDisplay({
  ratingAvg = 0,
  ratingCount = 0,
  myRating = 0,
  canRate = false,
  busy = false,
  onRate,
  size = 'medium',
}) {
  const { t } = useTranslation()
  const styles = useStyles()
  const [pulse, setPulse] = useState(false)
  const pulseTimer = useRef(null)

  const handleChange = (_, data) => {
    if (!canRate || busy) return
    const v = roundHalf(data.value)
    setPulse(true)
    if (pulseTimer.current) clearTimeout(pulseTimer.current)
    pulseTimer.current = setTimeout(() => setPulse(false), 400)
    onRate?.(v)
  }

  // 已登录：一组可交互星（已评分显示自己的分，未评分显示空星）
  // 未登录：只读均分星
  const interactive = canRate
  const avgText = t('workshop.myRatingAvg', {
    avg: roundHalf(ratingAvg).toFixed(1),
    count: ratingCount,
  })

  return (
    <span className={styles.readOnly}>
      {!interactive && (
        <RatingDisplay
          value={roundHalf(ratingAvg)}
          count={ratingCount}
          size={size}
          color="marigold"
          compact
        />
      )}
      {interactive && (
        <span
          className={mergeClasses(
            styles.interactive,
            busy && styles.disabled,
            pulse && styles.pop,
          )}
          title={myRating > 0 ? `${myRating} / 5` : undefined}
        >
          <Rating
            step={0.5}
            value={myRating}
            onChange={handleChange}
            size={size}
            color="marigold"
            readOnly={busy}
          />
        </span>
      )}

      {/* 旁边的小字提示 */}
      {!interactive && ratingCount > 0 && (
        <span className={styles.countText}>({ratingCount})</span>
      )}
      {interactive && (
        <Text size={size === 'small' ? 200 : 300} className={styles.countText}>
          {myRating > 0
            ? avgText
            : ratingCount > 0
              ? `${roundHalf(ratingAvg).toFixed(1)} (${ratingCount})`
              : t('workshop.rateHint')}
        </Text>
      )}
    </span>
  )
}

export default RatingStars
