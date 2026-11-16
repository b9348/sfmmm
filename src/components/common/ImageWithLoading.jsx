import { useLayoutEffect, useRef, useState } from 'react'
import { Spinner, makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import { ImageRegular, ImageOffRegular } from '@fluentui/react-icons'
import { useTranslation } from 'react-i18next'
import { cdnUrl } from '../../services/cdnApi'

const useStyles = makeStyles({
  root: {
    position: 'relative',
    display: 'inline-block',
    maxWidth: '100%',
    verticalAlign: 'top',
  },
  // 加载角标：只占右上角小块区域，图片照常渐进渲染，不被不透明层盖住。
  // 实心主题底色 + 中性描边保证在纯白/纯黑图片及明暗主题下都看得清。
  loadingBadge: {
    position: 'absolute',
    top: '6px',
    right: '6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    boxSizing: 'border-box',
    borderRadius: '50%',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    pointerEvents: 'none',
  },
  // 失败占位：加载已结束但图片不可用，保留占位尺寸并给出明确提示
  errorOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    padding: '8px',
    boxSizing: 'border-box',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: 'inherit',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    textAlign: 'center',
    pointerEvents: 'none',
  },
  // 缩略图变体：固定 33.33% 宽度，加载前后宽度一致，不再横向跳动
  thumbWrap: {
    width: '33.33%',
    maxWidth: '33.33%',
    flexShrink: 0,
    borderRadius: '6px',
  },
  // 仅用透明高度占位，不加可见底色；父容器背景直接透出
  thumbWrapLoading: {
    height: '100px',
  },
  thumb: {
    display: 'block',
    width: '100%',
    maxHeight: '140px',
    objectFit: 'cover',
    borderRadius: '6px',
  },

  // ── 正文占位（placeholder 模式）──
  // 宽度全程撑满可用宽度（外层 maxWidth 收口），加载前后都不变：
  // 图片变宽变窄都不影响，正文换行位置也就不会重排。小图靠左，视觉上与自然宽度一致。
  placeholderWrap: {
    width: '100%',
  },
  // 高度不写死：图片就在正常流里，浏览器一拿到尺寸占位框就跟着长高，
  // 两者永远严丝合缝。下面的 minHeight / aspect-ratio 只兜「一个字节都还没到」那段空白期。
  placeholderWrapLoading: {
    minHeight: '120px',
  },
  // 占位层：垫在图片后面，用 CSS 画出「这里将要出现一张图」的框。
  // 图片本身不隐藏、不脱离文档流，照常渐进渲染，所以它一有数据就会盖住占位；
  // 占位只负责在图片还是一片空白时先把版面尺寸占住（避免正文跳动）。
  placeholderLayer: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground4,
    pointerEvents: 'none',
  },
  placeholderGlyph: {
    fontSize: '24px',
  },
  // 图片压在占位层之上（两者都是定位元素，靠 DOM 顺序本也能压住；这里再显式抬一层更稳）。
  // 不给它加圆角：占位框在图片下面，尺寸完全一致，图片盖满后圆角是否一致看不出来。
  placeholderImg: {
    position: 'relative',
    zIndex: 1,
  },
})

/**
 * 图片 + 加载态。
 *
 * - 默认（缩略图 / 链接卡封面）：角标 Spinner，图片自身照常渐进渲染，不被遮挡。
 * - `placeholder`（正文大图）：后面垫一层 CSS 占位框，先把版面占住并提示「这里是图」；
 *   图片本体全程可见、渐进渲染，Spinner 一直显示到 `onLoad` 才撤掉。
 *
 * 展示地址经 `cdnUrl` 改写：镜像启用时换成加速域名（下载类 URL 由 Rust 端改写）。
 *
 * @param {object} props
 * @param {string} props.src 图片地址
 * @param {string} [props.alt]
 * @param {'thumb'} [props.variant] 缩略图变体（内置 33.33% 封顶、100px 占位与封面裁切）
 * @param {boolean} [props.placeholder] 正文占位模式（加载期背后垫 CSS 占位框）
 * @param {string} [props.placeholderRatio] 占位框比例（如 '1600 / 900'，由源码 img 的
 *   width/height 推导）；缺省按 16:9，加载完成后撤销
 * @param {string} [props.className] 外层容器类（控制布局与占位尺寸）
 * @param {object} [props.style] 外层容器样式
 * @param {string} [props.loadingClassName] 仅占位期间追加到外层容器的类（覆盖变体默认占位）
 * @param {string} [props.imgClassName] 图片自身类
 * @param {object} [props.imgStyle] 图片自身样式
 * @param {string} [props.spinnerSize] Fluent Spinner 尺寸
 */
export function ImageWithLoading({
  src,
  alt = '',
  variant,
  placeholder = false,
  placeholderRatio,
  className,
  style,
  loadingClassName,
  imgClassName,
  imgStyle,
  spinnerSize = 'tiny',
  onLoad,
  onError,
  ...imgProps
}) {
  const styles = useStyles()
  const { t } = useTranslation()
  const isThumb = variant === 'thumb'
  const usePlaceholder = placeholder && !isThumb
  // 状态与 src 绑定：切换图片时无需等待 effect，渲染阶段即可回到 loading，
  // 避免旧图已加载的 loaded 状态让新图短暂无遮罩
  const [state, setState] = useState({ src, status: src ? 'loading' : 'idle' })
  const imgRef = useRef(null)
  const status = state.src === src ? state.status : (src ? 'loading' : 'idle')
  const loading = status === 'loading'
  // 缩略图与占位模式都保留失败占位，链接卡片继续保持原有的失败即隐藏行为
  const showError = status === 'error' && (isThumb || usePlaceholder)
  const showPlaceholder = loading || showError

  // 缓存图可能在本组件挂载前就已完成：在 paint 前核对一次，避免占位/spinner 闪一帧。
  // 依赖 loading 而不仅是 src——万一 load 事件漏掉，后续任意一次渲染都能补上状态。
  useLayoutEffect(() => {
    const img = imgRef.current
    if (!src || !img || !img.complete) return
    setState({ src, status: img.naturalWidth > 0 ? 'loaded' : 'error' })
  }, [src, loading])

  if (!src) return null

  // 展示域名改写：镜像启用时把原始图床域名换成加速域名（下载类 URL 由 Rust 端改写）
  const displaySrc = cdnUrl(src)

  const handleLoad = (e) => {
    setState({ src, status: 'loaded' })
    onLoad?.(e)
  }

  const handleError = (e) => {
    setState({ src, status: 'error' })
    onError?.(e)
  }

  // 占位期用 aspect-ratio 预占高度（图片拿到真实尺寸后会被它自己撑开，占比只是下限）。
  // 已知真实比例时用它，加载完成后连一点高度变化都不会有。
  const wrapStyle = usePlaceholder && loading && placeholderRatio
    ? { ...style, aspectRatio: placeholderRatio }
    : style

  return (
    <span
      className={mergeClasses(
        styles.root,
        isThumb && styles.thumbWrap,
        usePlaceholder && styles.placeholderWrap,
        className,
        showPlaceholder && (
          loadingClassName
          || (isThumb && styles.thumbWrapLoading)
          || (usePlaceholder && styles.placeholderWrapLoading)
        ),
      )}
      style={wrapStyle}
    >
      {usePlaceholder && loading && (
        <span className={styles.placeholderLayer} aria-hidden="true">
          <ImageRegular className={styles.placeholderGlyph} />
        </span>
      )}
      <img
        ref={imgRef}
        src={displaySrc}
        alt={alt}
        className={mergeClasses(
          isThumb && styles.thumb,
          usePlaceholder && styles.placeholderImg,
          imgClassName,
        )}
        style={imgStyle}
        onLoad={handleLoad}
        onError={handleError}
        {...imgProps}
      />
      {loading && (
        <span
          className={styles.loadingBadge}
          role="status"
          aria-label={t('app.imageLoading')}
        >
          {/* Spinner 根节点默认是 <div>；正文图片被 marked 包在 <p> 里，
              div 落在 p 内是非法嵌套（React 会告警）。它的 root slot 本就支持
              'div' | 'span'，这里固定成 span，列表页与正文都安全。 */}
          <Spinner as="span" size={spinnerSize} />
        </span>
      )}
      {showError && (
        <span className={styles.errorOverlay}>
          <ImageOffRegular style={{ fontSize: '20px' }} />
          <span>{t('app.imageLoadFailed')}</span>
        </span>
      )}
    </span>
  )
}

export default ImageWithLoading