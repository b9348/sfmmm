import { useEffect, useCallback, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { makeStyles, tokens, Button, Tooltip } from '@fluentui/react-components'
import { Dismiss24Regular, ArrowMaximize24Regular, ZoomIn24Regular, ZoomOut24Regular, ArrowCounterclockwise24Regular } from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'

const MIN_SCALE = 0.1
const MAX_SCALE = 10
const WHEEL_STEP = 1.15

const useStyles = makeStyles({
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    overflow: 'hidden',
  },
  stage: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'default',
  },
  // 关闭按钮固定在右上角，不受缩放/平移影响；
  // 偏移量叠加安全区域，避免被状态栏/手势条遮挡
  closeBtn: {
    position: 'fixed',
    top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
    right: 'calc(env(safe-area-inset-right, 0px) + 12px)',
    zIndex: 10001,
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: 'rgba(255,255,255,0.15)',
    '&:hover': {
      backgroundColor: 'rgba(255,255,255,0.3)',
    },
  },
  controls: {
    position: 'fixed',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 10001,
    display: 'flex',
    gap: '6px',
    padding: '6px',
    borderRadius: '8px',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  controlBtn: {
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: 'transparent',
    '&:hover': {
      backgroundColor: 'rgba(255,255,255,0.2)',
    },
  },
  zoomLabel: {
    color: tokens.colorNeutralForegroundOnBrand,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '32px',
    minWidth: '44px',
    textAlign: 'center',
    userSelect: 'none',
  },
  image: {
    maxWidth: '92vw',
    maxHeight: '92vh',
    objectFit: 'contain',
    borderRadius: '4px',
    boxShadow: tokens.shadow8,
    cursor: 'grab',
    transition: 'transform 0.08s ease-out',
    willChange: 'transform',
  },
})

export function Lightbox({ src, alt = '', onClose }) {
  const styles = useStyles()
  const { t } = useTranslation()

  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  // 多指追踪：单指平移，双指捏合缩放（移动端核心手势）
  const pointers = useRef(new Map())
  const pinch = useRef(null)
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 })
  // 回调内读取实时值，保持事件处理器引用稳定（window 级监听才能正确解绑）
  const live = useRef({ scale: 1, offset: { x: 0, y: 0 } })
  live.current = { scale, offset }

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  // 滚轮缩放：缩放中心跟随鼠标位置
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const delta = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP
    // 在事件回调内先读取布局信息（React 事件回调结束后 currentTarget 会被置空）
    const el = e.currentTarget
    const rect = el ? el.getBoundingClientRect() : null
    const center = rect ? { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 } : null
    setScale(prev => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * delta))
      if (!center) return next
      // 以鼠标所在位置为缩放中心，调整偏移，使该点在缩放后仍位于鼠标下
      const ratio = next / prev
      setOffset(o => ({
        x: center.x - (center.x - o.x) * ratio,
        y: center.y - (center.y - o.y) * ratio,
      }))
      return next
    })
  }, [])

  const distBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  const handlePointerMove = useCallback((e) => {
    const pts = pointers.current
    if (!pts.has(e.pointerId)) return
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.size >= 2) {
      // 双指捏合：以两指中心为缩放中心，按距离比例缩放
      const [a, b] = [...pts.values()]
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const dist = distBetween(a, b)
      const start = pinch.current
      if (!start) return
      const ratio = start.dist > 0 ? dist / start.dist : 1
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, start.scale * ratio))
      setScale(next)
      // 保持捏合起始时两指中心下的图像点不动
      setOffset({
        x: start.centerRel.x * (1 - next / start.scale) + start.offset.x,
        y: start.centerRel.y * (1 - next / start.scale) + start.offset.y,
      })
    } else {
      // 单指平移
      const s = dragStart.current
      setOffset({ x: s.ox + (e.clientX - s.x), y: s.oy + (e.clientY - s.y) })
    }
  }, [])

  const handlePointerUp = useCallback((e) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    } else if (pointers.current.size === 1) {
      // 从捏合回落到单指：以剩余指位为新的平移起点
      const [p] = [...pointers.current.values()]
      dragStart.current = { x: p.x, y: p.y, ox: live.current.offset.x, oy: live.current.offset.y }
    }
  }, [handlePointerMove])

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const el = e.currentTarget
      const rect = el ? el.getBoundingClientRect() : null
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      pinch.current = {
        dist: distBetween(a, b),
        scale: live.current.scale,
        offset: live.current.offset,
        centerRel: rect ? { x: cx - rect.left - rect.width / 2, y: cy - rect.top - rect.height / 2 } : { x: 0, y: 0 },
      }
    } else if (pointers.current.size === 1) {
      dragStart.current = { x: e.clientX, y: e.clientY, ox: live.current.offset.x, oy: live.current.offset.y }
    }
    // 用 window 级监听拖拽，避免依赖元素级指针捕获在重渲染时丢失
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [handlePointerMove, handlePointerUp])

  // 关闭：点击背景（stage 空白区）或 Esc 或关闭按钮；拖拽/捏合中不触发
  const handleBackdropClick = useCallback((e) => {
    if (pointers.current.size > 0) return
    onClose?.()
  }, [onClose])

  const handleKey = useCallback((e) => {
    if (e.key === 'Escape') {
      onClose?.()
    } else if (e.key === '+' || e.key === '=') {
      setScale(prev => Math.min(MAX_SCALE, prev * WHEEL_STEP))
    } else if (e.key === '-') {
      setScale(prev => Math.max(MIN_SCALE, prev / WHEEL_STEP))
    } else if (e.key === '0') {
      reset()
    }
  }, [onClose, reset])

  useEffect(() => {
    if (!src) return
    reset()
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      pointers.current.clear()
      pinch.current = null
    }
  }, [src, handleKey, reset])

  if (!src) return null

  const transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`
  const percent = Math.round(scale * 100)

  // 通过 Portal 挂到 body：避免被 .winnv-content / .winnv-shell 的
  // isolation: isolate 层叠上下文困住，导致左下角底部菜单盖住灯箱
  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      onClick={handleBackdropClick}
    >
      <div
        className={styles.stage}
        onWheel={handleWheel}
        onClick={(e) => {
          // 仅点击图片外的空白区域关闭（stage 铺满全屏，img 自身不冒泡关闭）
          if (e.target === e.currentTarget) handleBackdropClick(e)
        }}
      >
        <img
          className={styles.image}
          src={src}
          alt={alt || 'preview'}
          style={{ transform }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        />
      </div>

      <Tooltip content={t('workshop.close')} relationship="label">
        <Button className={styles.closeBtn} appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} />
      </Tooltip>

      <div className={styles.controls} onClick={(e) => e.stopPropagation()}>
        <Tooltip content={t('workshop.zoomOut')} relationship="label">
          <Button className={styles.controlBtn} appearance="subtle" icon={<ZoomOut24Regular />} onClick={() => setScale(prev => Math.max(MIN_SCALE, prev / WHEEL_STEP))} />
        </Tooltip>
        <span className={styles.zoomLabel}>{percent}%</span>
        <Tooltip content={t('workshop.zoomIn')} relationship="label">
          <Button className={styles.controlBtn} appearance="subtle" icon={<ZoomIn24Regular />} onClick={() => setScale(prev => Math.min(MAX_SCALE, prev * WHEEL_STEP))} />
        </Tooltip>
        <Tooltip content={t('workshop.resetZoom')} relationship="label">
          <Button className={styles.controlBtn} appearance="subtle" icon={<ArrowCounterclockwise24Regular />} onClick={reset} />
        </Tooltip>
        <Tooltip content={t('workshop.openInBrowser')} relationship="label">
          <Button className={styles.controlBtn} appearance="subtle" icon={<ArrowMaximize24Regular />} onClick={(e) => { e.stopPropagation(); window.open(src, '_blank') }} />
        </Tooltip>
      </div>
    </div>,
    document.body,
  )
}
