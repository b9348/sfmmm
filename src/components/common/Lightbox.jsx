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
  // 关闭按钮固定在右上角，不受缩放/平移影响
  closeBtn: {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: 10001,
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundColor: 'rgba(255,255,255,0.15)',
    '&:hover': {
      backgroundColor: 'rgba(255,255,255,0.3)',
    },
  },
  controls: {
    position: 'fixed',
    bottom: '12px',
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
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 })

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

  const handlePointerMove = useCallback((e) => {
    if (!dragging.current) return
    setOffset({
      x: dragStart.current.ox + (e.clientX - dragStart.current.x),
      y: dragStart.current.oy + (e.clientY - dragStart.current.y),
    })
  }, [])

  const handlePointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerUp)
  }, [handlePointerMove])

  const handlePointerDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    // 用 window 级监听拖拽，避免依赖元素级指针捕获在重渲染时丢失
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [offset, handlePointerMove, handlePointerUp])

  // 关闭：点击背景（未拖拽时）或 Esc 或关闭按钮
  const handleBackdropClick = useCallback((e) => {
    if (dragging.current) return
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
      dragging.current = false
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
        onClick={(e) => e.stopPropagation()}
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
