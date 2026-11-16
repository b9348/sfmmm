import { useEffect, useLayoutEffect, useCallback, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { makeStyles, mergeClasses, tokens, Button, Tooltip, Spinner, useThemeClassName } from '@fluentui/react-components'
import { Dismiss24Regular, ArrowMaximize24Regular, ZoomIn24Regular, ZoomOut24Regular, ArrowCounterclockwise24Regular, CaretLeft24Regular, CaretRight24Regular, ImageOffRegular } from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { cdnUrl } from '../../services/cdnApi'

const MIN_SCALE = 0.1
const MAX_SCALE = 10
const WHEEL_STEP = 1.15
// 悬浮面板与 icon 配色：中灰半透明面板 + 浅灰 icon，避免纯黑/纯白的极端对比
const PANEL_BG = 'rgba(72, 72, 78, 0.92)'
const PANEL_BG_HOVER = 'rgba(94, 94, 100, 0.95)'
const ICON_COLOR = '#d4d4d8'

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
    color: ICON_COLOR,
    backgroundColor: PANEL_BG,
    '&:hover': {
      backgroundColor: PANEL_BG_HOVER,
    },
  },
  // 左右切换按钮固定在屏幕两侧垂直居中
  navBtn: {
    position: 'fixed',
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: 10001,
    color: ICON_COLOR,
    backgroundColor: PANEL_BG,
    '&:hover': {
      backgroundColor: PANEL_BG_HOVER,
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
    backgroundColor: PANEL_BG,
  },
  controlBtn: {
    color: ICON_COLOR,
    backgroundColor: 'transparent',
    // 提高优先级，覆盖 Fluent subtle 按钮的主题前景色，避免深色 icon 贴深色面板
    '&:hover': {
      color: ICON_COLOR,
      backgroundColor: PANEL_BG_HOVER,
    },
    '& .fui-Button__icon': {
      color: ICON_COLOR,
    },
  },
  zoomLabel: {
    color: ICON_COLOR,
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
  // 大图加载遮罩：居中的大号 Spinner，不拦截鼠标，缩放/拖拽照常生效
  imageLoading: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  // 失败占位：灯箱始终是深色底，用固定浅灰保证两种主题下都清晰
  imageError: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    color: ICON_COLOR,
    fontSize: tokens.fontSizeSmall,
    pointerEvents: 'none',
  },
})

export function Lightbox({ src, images, alt = '', onClose }) {
  const styles = useStyles()
  const { t } = useTranslation()
  // portal 挂在 body 上，不在 FluentProvider 的 DOM 子树内；
  // 补主题 class 才能让 Spinner/Button 等 Fluent 组件拿到主题 CSS 变量
  const themeClassName = useThemeClassName()

  const [activeSrc, setActiveSrc] = useState(src)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  // 悬浮面板显隐：鼠标在灯箱内时展示，离开大图区域后淡出
  const [uiVisible, setUiVisible] = useState(true)
  // 当前大图是否仍在加载：切换图片时重新进入加载态
  const [imageLoading, setImageLoading] = useState(true)
  // 当前大图是否加载失败：失败后显示明确占位而不是破图
  const [imageError, setImageError] = useState(false)
  const imgRef = useRef(null)
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 })

  // 灯箱打开/父级切换图片时同步当前图
  useEffect(() => {
    setActiveSrc(src)
  }, [src])

  // 每次打开时恢复面板展示
  useEffect(() => {
    if (src) setUiVisible(true)
  }, [src])

  const list = (images && images.length > 1) ? images : null
  const currentIndex = list ? Math.max(0, list.indexOf(activeSrc)) : 0

  // 预加载当前图的前后各一张，保证方向键切换时秒开
  useEffect(() => {
    if (!list || !activeSrc) return
    const i = list.indexOf(activeSrc)
    if (i < 0) return
    for (const j of [i - 1, i + 1]) {
      const url = list[(j + list.length) % list.length]
      if (url && url !== activeSrc) {
        const im = new Image()
        im.src = url
      }
    }
  }, [activeSrc, list])

  const go = useCallback((dir) => {
    if (!list) return
    setActiveSrc(prev => {
      const i = list.indexOf(prev)
      if (i < 0) return prev
      return list[(i + dir + list.length) % list.length]
    })
  }, [list])

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

  // 命名函数表达式：回调体内引用自身以解绑事件（避免引用尚未声明的外层 const）
  const handlePointerUp = useCallback(function handlePointerUp() {
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
  const handleBackdropClick = useCallback(() => {
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
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      go(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      go(1)
    }
  }, [onClose, reset, go])

  useEffect(() => {
    if (!src) return
    reset()
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      dragging.current = false
    }
  }, [activeSrc, src, handleKey, reset])

  // 打开/切图时在 paint 前定好加载/失败态，避免缓存图先闪一帧再补遮罩
  useLayoutEffect(() => {
    if (!src) return
    const img = imgRef.current
    const complete = !!(img && img.complete)
    const failed = complete && img.naturalWidth === 0
    setImageError(failed)
    setImageLoading(!complete || failed)
  }, [activeSrc, src])

  if (!src) return null

  const transform = `translate(${offset.x}px, ${offset.y}px) scale(${scale})`
  const percent = Math.round(scale * 100)

  // 通过 Portal 挂到 body：避免被 .winnv-content / .winnv-shell 的
  // isolation: isolate 层叠上下文困住，导致左下角底部菜单盖住灯箱
  // 悬浮面板（关闭/切换箭头/工具栏）：鼠标进入灯箱展示，离开后淡出
  const panelStyle = {
    opacity: uiVisible ? 1 : 0,
    pointerEvents: uiVisible ? 'auto' : 'none',
    transition: 'opacity 0.25s ease',
  }
  return createPortal(
    <div
      className={mergeClasses(themeClassName, styles.overlay)}
      role="dialog"
      aria-modal="true"
      onClick={handleBackdropClick}
      onMouseEnter={() => setUiVisible(true)}
      onMouseLeave={() => setUiVisible(false)}
    >
      <div
        className={styles.stage}
        onWheel={handleWheel}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          ref={imgRef}
          className={styles.image}
          src={cdnUrl(activeSrc)}
          alt={alt || 'preview'}
          style={{ transform, visibility: imageError ? 'hidden' : 'visible' }}
          onLoad={() => {
            setImageLoading(false)
            setImageError(false)
          }}
          onError={() => {
            setImageLoading(false)
            setImageError(true)
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        />
        {imageLoading && (
          <div
            className={styles.imageLoading}
            role="status"
            aria-label={t('app.imageLoading')}
          >
            <Spinner size="large" />
          </div>
        )}
        {imageError && (
          <div className={styles.imageError}>
            <ImageOffRegular style={{ fontSize: '32px' }} />
            <span>{t('app.imageLoadFailed')}</span>
          </div>
        )}
      </div>

      <Tooltip content={t('workshop.close')} relationship="label">
        <Button className={styles.closeBtn} style={panelStyle} appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} />
      </Tooltip>

      {list && (
        <>
          <Tooltip content={t('workshop.prevImage')} relationship="label">
            <Button className={styles.navBtn} style={{ left: '12px', ...panelStyle }} appearance="subtle" icon={<CaretLeft24Regular />} onClick={(e) => { e.stopPropagation(); go(-1) }} />
          </Tooltip>
          <Tooltip content={t('workshop.nextImage')} relationship="label">
            <Button className={styles.navBtn} style={{ right: '12px', ...panelStyle }} appearance="subtle" icon={<CaretRight24Regular />} onClick={(e) => { e.stopPropagation(); go(1) }} />
          </Tooltip>
        </>
      )}

      <div className={styles.controls} style={panelStyle} onClick={(e) => e.stopPropagation()}>
        {list && <span className={styles.zoomLabel}>{currentIndex + 1} / {list.length}</span>}
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
