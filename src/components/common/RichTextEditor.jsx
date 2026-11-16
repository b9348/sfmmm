import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext, createElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditor, EditorContent } from '@tiptap/react'
import { nodeInputRule, nodePasteRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import CharacterCount from '@tiptap/extension-character-count'
import { makeStyles, mergeClasses, tokens, Button, Tooltip, Text } from '@fluentui/react-components'
// 统一走 services/markdown：它在 marked 上补了一条「行首行内标签不开 HTML block」
// 的规则，否则 </br> 独占一行时会把后面的图片语法原样输出（详见该文件注释）
import { renderMarkdown } from '../../services/markdown'
import {
  Image24Regular,
} from '@fluentui/react-icons'
import {
  selectImageFiles,
  createPendingImage,
  registerPendingImages,
  unregisterPendingImages,
  resolvePendingUrlForPreview,
  isPendingUrl,
  findMarkdownImageSpans,
  clampImageInsertPosition,
  imageSpanAt,
  expandRangeToImageSpans,
} from '../../services/imageApi'
import { LinkCard } from './LinkCard'
import { ImageWithLoading } from './ImageWithLoading'
import { MentionCard } from './MentionCard'
import { MentionAutocomplete } from './MentionAutocomplete'
import { splitMarkdownWithLinkCards, splitRichtextWithLinkCards } from '../../utils/linkCards'
import { parseMentionHref } from '../../services/modMentions'
import { rememberEntryPoint } from '../../utils/navReturn'
import UserNavContext from '../../contexts/UserNavContext'
import './RichTextEditor.css'

const useStyles = makeStyles({
  editor: {
    flex: 1,
    minHeight: '160px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '4px',
    padding: '8px',
    fontSize: tokens.fontSizeSmall,
    cursor: 'text',
    resize: 'vertical',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    '& .ProseMirror': {
      outline: 'none',
      minHeight: '80px',
      height: '100%',
      '& p.is-editor-empty:first-child::before': {
        content: 'attr(data-placeholder)',
        color: tokens.colorNeutralForeground4,
        float: 'left',
        height: 0,
        pointerEvents: 'none',
      },
    },
    '& ul, & ol': {
      paddingLeft: '20px',
    },
    '& h1, & h2, & h3': {
      marginTop: '8px',
      marginBottom: '4px',
    },
    '& blockquote': {
      borderLeft: `3px solid ${tokens.colorNeutralStroke2}`,
      paddingLeft: '8px',
      marginLeft: '0',
      color: tokens.colorNeutralForeground2,
    },
    '& code': {
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: '2px',
      padding: '1px 4px',
      fontSize: tokens.fontSizeSmall,
    },
    '& pre': {
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: '4px',
      padding: '8px',
      overflow: 'auto',
      '& code': {
        backgroundColor: 'transparent',
        padding: 0,
      },
    },
  },
  toolbar: {
    display: 'flex',
    gap: '4px',
    marginBottom: '4px',
    flexWrap: 'wrap',
  },
  mdContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flex: 1,
    minHeight: 0,
  },
  mdTextarea: {
    resize: 'vertical',
    // textarea 文字是透明的，选区若不透明就会盖住下面高亮层的字。
    // 半透明底色既能看到选区，也能看到被选中的文字。
    '&::selection': {
      backgroundColor: 'rgba(0, 120, 212, 0.28)',
    },
  },
  // 浮动标签容器：标签在空态时充当 placeholder，输入/聚焦后浮到 textarea 下边框
  mdTextareaWrap: {
    position: 'relative',
    display: 'flex',
    flex: 1,
    minWidth: 0,
    marginBottom: '14px',
  },
  // 语法高亮层：垫在 textarea 下方，把图片语法染成品牌蓝。
  // 外层只当「取景框」（尺寸/位置由 syncHighlight 从 textarea 实测后内联写入），
  // 真正的内容在内层，滚动位移通过内层的 transform 跟随。
  // 与 textarea 的字体/内边距/换行规则必须逐项一致（见 MD_BOX_STYLE），
  // 否则文字会错位。textarea 自身文字设为透明（caret 仍是正常颜色），
  // 用户看到的颜色全部来自这一层。
  mdHighlight: {
    position: 'absolute',
    left: 0,
    top: 0,
    margin: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground1,
    // textarea 背景改为透明后，输入框底色由这一层提供，否则会透出面板底色
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: '4px',
  },
  mdHighlightContent: {
    willChange: 'transform',
  },
  // 输入法组合期间（及其它需要看到原始文字的时刻）把高亮层藏掉，
  // textarea 自己显示文字。两层同时可见会出现重影。
  mdHighlightOff: {
    opacity: 0,
  },
  // 图片标记整体渲染：品牌蓝 + 浅色底 + 圆角，视觉上是一块「不可拆分」的单元。
  // 不能加 padding/margin：高亮层只负责「画」，字符位置必须与 textarea 逐字对齐，
  // 任何内边距都会让标记内的字和真实光标错开几像素。底色直接贴着字形即可。
  mdHighlightImg: {
    color: tokens.colorBrandForegroundLink,
    backgroundColor: tokens.colorBrandBackground2,
    borderRadius: '3px',
    // 标记跨行折行时，底色要跟着每一行都画（否则只有首行有底）
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  },
  mdLabel: {
    position: 'absolute',
    left: '9px',
    right: '9px',
    top: '8px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
    transitionProperty: 'top, bottom, color, font-size',
    transitionDuration: tokens.durationFaster,
  },
  mdLabelFloat: {
    top: 'auto',
    bottom: '-16px',
    right: 'auto',
    maxWidth: 'calc(100% - 18px)',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  mdSplit: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '8px',
    alignItems: 'stretch',
    minHeight: 0,
    // 窄屏改上下两栏：375 宽的窗口并排两栏每栏只剩 ~160px，
    // 一行放不下几个字，中文几乎一格一字，读和写都没法用
    '@media (max-width: 768px)': {
      gridTemplateColumns: '1fr',
    },
  },
  // 全屏输入态：编辑区与预览上下分配剩余高度（编辑区多给一些）
  mdSplitFill: {
    flex: 1,
    minHeight: 0,
    '@media (max-width: 768px)': {
      gridTemplateRows: 'minmax(0, 1.6fr) minmax(0, 1fr)',
    },
  },
  // 分栏里的预览面板：桌面端与编辑区等高、最多 384px；
  // 窄屏改成上下两栏后它整块压在编辑区下面，高度收紧到 240px，
  // 免得一个短回复下面挂着一大块预览把评论区撑得很长
  mdPreviewSplit: {
    width: '100%',
    maxHeight: '384px',
    boxSizing: 'border-box',
    '@media (max-width: 768px)': {
      maxHeight: '240px',
    },
  },
  mdPreviewFill: {
    width: '100%',
    maxHeight: 'none',
    height: '100%',
    minHeight: 0,
    boxSizing: 'border-box',
  },
  splitHint: {
    alignSelf: 'center',
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
  },
  editorContent: {
    flex: 1,
    overflow: 'auto',
  },
  charCount: {
    textAlign: 'right',
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground3,
    paddingTop: '4px',
  },
  mdPreview: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '4px',
    padding: '8px',
    fontSize: tokens.fontSizeSmall,
    maxHeight: '200px',
    overflow: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    '& table': {
      borderCollapse: 'collapse',
      marginTop: '8px',
      marginBottom: '8px',
      maxWidth: '100%',
    },
    '& th, & td': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: '4px 8px',
      textAlign: 'left',
    },
    '& th': {
      backgroundColor: tokens.colorNeutralBackground3,
      fontWeight: tokens.fontWeightSemibold,
    },
  },
})

// 自定义 Tiptap Image 扩展，支持 data-imgbed-pending 属性，并兼容 Markdown 图片语法
const MD_IMAGE_REGEX = /!\[(.*?)\]\(([^)]+)\)/
const MD_IMAGE_REGEX_GLOBAL = /!\[(.*?)\]\(([^)]+)\)/g

const CustomImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      dataImgbedPending: {
        default: null,
        parseHTML: element => element.getAttribute('data-imgbed-pending'),
        renderHTML: attributes => {
          if (!attributes.dataImgbedPending) {
            return {}
          }
          return {
            'data-imgbed-pending': attributes.dataImgbedPending,
          }
        },
      },
    }
  },
  addInputRules() {
    return [
      nodeInputRule({
        find: MD_IMAGE_REGEX,
        type: this.type,
        getAttributes: (match) => {
          const src = match[2]
          return {
            src,
            alt: match[1],
            dataImgbedPending: src.startsWith('imgbed://pending/') ? src : null,
          }
        },
      }),
    ]
  },
  addPasteRules() {
    return [
      nodePasteRule({
        find: MD_IMAGE_REGEX_GLOBAL,
        type: this.type,
        getAttributes: (match) => {
          const src = match[2]
          return {
            src,
            alt: match[1],
            dataImgbedPending: src.startsWith('imgbed://pending/') ? src : null,
          }
        },
      }),
    ]
  },
})

const useContentStyles = makeStyles({
  content: {
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.5',
    '& ul, & ol': {
      paddingLeft: '20px',
    },
    '& h1, & h2, & h3': {
      marginTop: '8px',
      marginBottom: '4px',
    },
    '& blockquote': {
      borderLeft: `3px solid ${tokens.colorNeutralStroke2}`,
      paddingLeft: '8px',
      marginLeft: '0',
      color: tokens.colorNeutralForeground2,
    },
    '& code': {
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: '2px',
      padding: '1px 4px',
      fontSize: tokens.fontSizeSmall,
    },
    '& pre': {
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: '4px',
      padding: '8px',
      overflow: 'auto',
      '& code': {
        backgroundColor: 'transparent',
        padding: 0,
      },
    },
    '& img': {
      maxWidth: '100%',
      height: 'auto',
      cursor: 'zoom-in',
    },
    '& a': {
      color: tokens.colorBrandForegroundLink,
      textDecorationLine: 'underline',
      textUnderlineOffset: '2px',
    },
    '& a:hover': {
      color: tokens.colorBrandForegroundLinkHover,
    },
    '& table': {
      borderCollapse: 'collapse',
      marginTop: '8px',
      marginBottom: '8px',
      maxWidth: '100%',
    },
    '& th, & td': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: '4px 8px',
      textAlign: 'left',
    },
    '& th': {
      backgroundColor: tokens.colorNeutralBackground3,
      fontWeight: tokens.fontWeightSemibold,
    },
  },
})

// 文章型内容（mod 详情页等长文）：参照 Discourse 的段落节奏，字号与行高更舒展
const useArticleContentStyles = makeStyles({
  content: {
    fontSize: '15px',
    lineHeight: '1.7',
    color: tokens.colorNeutralForeground1,
    wordBreak: 'break-word',
    '& > :first-child, & > :first-child > :first-child': {
      marginTop: 0,
    },
    '& > :last-child, & > :last-child > :last-child': {
      marginBottom: 0,
    },
    '& p': {
      margin: '0 0 1em',
    },
    '& h1, & h2, & h3, & h4, & h5, & h6': {
      margin: '1.6em 0 0.6em',
      lineHeight: 1.3,
      fontWeight: tokens.fontWeightSemibold,
    },
    '& h1': {
      fontSize: '1.6em',
    },
    '& h2': {
      fontSize: '1.4em',
    },
    '& h3': {
      fontSize: '1.2em',
    },
    '& h4': {
      fontSize: '1.05em',
    },
    '& h5, & h6': {
      fontSize: '1em',
    },
    '& ul, & ol': {
      margin: '0 0 1em',
      paddingLeft: '1.7em',
    },
    '& li': {
      margin: '0.3em 0',
    },
    '& li > ul, & li > ol': {
      margin: '0.3em 0',
    },
    '& blockquote': {
      margin: '0 0 1em',
      padding: '0.6em 1em',
      borderLeft: `4px solid ${tokens.colorBrandStroke1}`,
      borderRadius: '4px',
      backgroundColor: tokens.colorNeutralBackground3,
      color: tokens.colorNeutralForeground2,
    },
    '& blockquote > :last-child': {
      marginBottom: 0,
    },
    '& a': {
      color: tokens.colorBrandForegroundLink,
      textDecorationLine: 'underline',
      textUnderlineOffset: '2px',
    },
    '& a:hover': {
      color: tokens.colorBrandForegroundLinkHover,
    },
    '& hr': {
      border: 'none',
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      margin: '1.8em 0',
    },
    '& code': {
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: '4px',
      padding: '0.15em 0.4em',
      fontSize: '0.9em',
      fontFamily: 'Consolas, "Courier New", monospace',
    },
    '& pre': {
      margin: '0 0 1em',
      backgroundColor: tokens.colorNeutralBackground3,
      borderRadius: '8px',
      padding: '12px 16px',
      overflow: 'auto',
      lineHeight: '1.5',
      '& code': {
        backgroundColor: 'transparent',
        padding: 0,
        fontSize: tokens.fontSizeBase300,
      },
    },
    '& img': {
      maxWidth: '100%',
      height: 'auto',
      cursor: 'zoom-in',
    },
    '& table': {
      borderCollapse: 'collapse',
      margin: '0 0 1em',
      maxWidth: '100%',
      fontSize: tokens.fontSizeBase300,
    },
    '& th, & td': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: '8px 12px',
      textAlign: 'left',
    },
    '& th': {
      backgroundColor: tokens.colorNeutralBackground3,
      fontWeight: tokens.fontWeightSemibold,
    },
  },
})

/**
 * 把 Markdown 源码切成「普通文本 / 图片语法」若干段，供语法高亮层渲染。
 * 只染色不改内容：所有字符原样输出，因此镜像层与 textarea 的排版完全一致。
 */
function buildHighlightNodes(text, imgClassName) {
  if (!text) return null
  // 末尾是换行时补一个零宽字符：textarea 会给这个空行留出行高，镜像层若没有
  // 对应内容就会少一行，导致整体错位半行。
  const tail = text.endsWith('\n') ? '​' : ''
  const spans = findMarkdownImageSpans(text)
  if (spans.length === 0) return text + tail
  const nodes = []
  let last = 0
  spans.forEach((span, i) => {
    if (span.start > last) nodes.push(text.slice(last, span.start))
    nodes.push(
      <span key={i} className={imgClassName}>
        {text.slice(span.start, span.end)}
      </span>,
    )
    last = span.end
  })
  if (last < text.length) nodes.push(text.slice(last))
  if (tail) nodes.push(tail)
  return nodes
}

/**
 * @param {object} [props.heightState] usePersistedHeight 的返回值（含 attach 与 heightStyle）；
 *   传入后编辑器高度可拖动并持久化
 */
export function RichTextEditor({ value, onChange, placeholder, maxLength, disabled = false, heightState }) {
  const { attach: attachHeight, heightStyle: heightStyleFn } = heightState || {}
  const { t } = useTranslation()
  const styles = useStyles()
  const placeholderText = placeholder ?? t('editor.inputPlaceholder')
  const blobUrlsRef = useRef([])

  const extensions = useMemo(() => {
    const list = [
      StarterKit,
      Placeholder.configure({ placeholder: placeholderText }),
      CustomImage.configure({
        HTMLAttributes: { class: 'rich-image' },
        allowBase64: true,
      }),
    ]
    if (maxLength && maxLength > 0) {
      list.push(CharacterCount.configure({ limit: maxLength }))
    }
    return list
  }, [placeholderText, maxLength])

  const editor = useEditor({
    extensions,
    content: value || '',
    onUpdate: ({ editor: ed }) => {
      onChange?.(ed.getHTML())
    },
  })

  // 组件卸载时释放所有本组件创建的 blob URL
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
      blobUrlsRef.current = []
    }
  }, [])

  // 受控模式：外部 value 变化时同步编辑器内容
  useEffect(() => {
    if (!editor) return
    const current = editor.getHTML()
    if (value !== current) {
      editor.commands.setContent(value || '', false)
    }
  }, [editor, value])

  // 禁用/启用编辑
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [editor, disabled])

  const insertBlobImage = (file, img) => {
    if (!editor) return false
    const blobUrl = URL.createObjectURL(file)
    const command = editor.chain().focus().setImage({
      src: blobUrl,
      alt: file.name,
      title: file.name,
      dataImgbedPending: img.pendingUrl,
    })
    const success = command.run()
    if (success) {
      blobUrlsRef.current.push(blobUrl)
    } else {
      URL.revokeObjectURL(blobUrl)
      unregisterPendingImages([img.id])
    }
    return success
  }

  const insertImage = async () => {
    if (!editor) return
    try {
      const images = await selectImageFiles({ multiple: false })
      if (images.length === 0) return
      const img = images[0]
      registerPendingImages([img])
      const success = insertBlobImage(img.file, img)
      if (!success) {
        alert(t('editor.imageInsertLimitReached') || t('editor.imageInsertFailed'))
      }
    } catch (e) {
      alert(t('editor.imageInsertFailed') + e.message)
    }
  }

  const handlePaste = (e) => {
    if (!editor) return
    const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    for (const file of files) {
      try {
        const img = createPendingImage(file)
        registerPendingImages([img])
        const success = insertBlobImage(file, img)
        if (!success) {
          alert(t('editor.imageInsertLimitReached') || t('editor.imageInsertFailed'))
          break
        }
      } catch (err) {
        alert(t('editor.imageInsertFailed') + err.message)
      }
    }
  }

  if (!editor) return null

  return (
    <div
      className={styles.editor}
      ref={attachHeight}
      style={heightStyleFn ? heightStyleFn() : undefined}
      onPaste={disabled ? undefined : handlePaste}
    >
      <div className={styles.toolbar}>
        <Tooltip content={t('editor.bold')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('bold') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></Button></Tooltip>
        <Tooltip content={t('editor.italic')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('italic') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></Button></Tooltip>
        <Tooltip content={t('editor.strikethrough')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('strike') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></Button></Tooltip>
        <Tooltip content={t('editor.inlineCode')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('code') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleCode().run()}>{'</>'}</Button></Tooltip>
        <Tooltip content={t('editor.divider')} relationship="label"><Button size="small" disabled={disabled} appearance="subtle" onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</Button></Tooltip>
        <Tooltip content={t('editor.heading2')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('heading', { level: 2 }) ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</Button></Tooltip>
        <Tooltip content={t('editor.heading3')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('heading', { level: 3 }) ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</Button></Tooltip>
        <Tooltip content={t('editor.bulletList')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('bulletList') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleBulletList().run()}>•</Button></Tooltip>
        <Tooltip content={t('editor.orderedList')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('orderedList') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</Button></Tooltip>
        <Tooltip content={t('editor.quote')} relationship="label"><Button size="small" disabled={disabled} appearance={editor.isActive('blockquote') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleBlockquote().run()}>"</Button></Tooltip>
        <Tooltip content={t('editor.insertImage')} relationship="label"><Button size="small" disabled={disabled} icon={<Image24Regular />} onClick={insertImage}>{t('editor.image')}</Button></Tooltip>
        <Tooltip content={t('editor.undo')} relationship="label"><Button size="small" disabled={disabled} appearance="subtle" onClick={() => editor.chain().focus().undo().run()}>↶</Button></Tooltip>
        <Tooltip content={t('editor.redo')} relationship="label"><Button size="small" disabled={disabled} appearance="subtle" onClick={() => editor.chain().focus().redo().run()}>↷</Button></Tooltip>
      </div>
      <EditorContent editor={editor} className={styles.editorContent} />
      {maxLength && maxLength > 0 && (
        <Text className={styles.charCount}>
          {editor.storage.characterCount?.characters() ?? 0} / {maxLength}
        </Text>
      )}
    </div>
  )
}

export function MarkdownEditor({ value, onChange, placeholder, maxLength, disabled = false, split = false, onSubmit, heightState, previewHeightState, onFocusChange, fill = false }) {
  const { attach: attachHeight, heightStyle: heightStyleFn } = heightState || {}
  const { attach: attachPreviewHeight, heightStyle: previewHeightFn } = previewHeightState || {}
  const { t } = useTranslation()
  const styles = useStyles()
  const textareaRef = useRef(null)
  const highlightRef = useRef(null)
  const highlightContentRef = useRef(null)
  const [taNode, setTaNode] = useState(null)
  const [focused, setFocused] = useState(false)
  // 输入法组合中：把显示权交还给 textarea，否则候选词/组合文本看不见
  const [composing, setComposing] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  // 存 React 节点而不是 HTML 字符串：让预览里的图片走 ImageWithLoading，
  // 与详情页共用同一套「CSS 占位 + 渐进加载 + loading 角标」逻辑。
  const [previewBody, setPreviewBody] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const placeholderText = placeholder ?? t('editor.markdownPlaceholder')
  // 预览里的图片与正文共用同一套样式（尺寸上限、块级、点击灯箱）
  const previewImgClasses = useContentImgStyles()
  // 本地图片的 data URL 缓存：分栏模式下每次按键都会重新解析，避免重复读文件
  const dataUrlCache = useRef({})

  // 预览时把 pending URL 替换为本地 data URL
  useEffect(() => {
    if (!split && !showPreview) return
    let cancelled = false
    const resolve = async () => {
      if (!split) setPreviewLoading(true)
      const rawHtml = renderMarkdown(value)
      const parser = new DOMParser()
      const doc = parser.parseFromString(rawHtml, 'text/html')
      const images = doc.querySelectorAll('img')
      for (const img of images) {
        const src = img.getAttribute('src')
        if (!isPendingUrl(src)) continue
        if (!dataUrlCache.current[src]) dataUrlCache.current[src] = await resolvePendingUrlForPreview(src)
        const resolved = dataUrlCache.current[src]
        if (isPendingUrl(resolved)) {
          // pending 仓库是内存态，刷新后旧占位就找不回来了，预览里直接移除，
          // 免得留一个永远转圈的破图
          img.remove()
        } else {
          img.setAttribute('src', resolved)
        }
      }
      if (!cancelled) {
        setPreviewBody(htmlToReact(doc.body.innerHTML, previewImgClasses))
        setPreviewLoading(false)
      }
    }
    resolve()
    return () => { cancelled = true }
  }, [split, showPreview, value, previewImgClasses])

  // 语法高亮层：尺寸与滚动位移都从 textarea 实测。
  // 不能靠 CSS 的 left/right:0 对齐——textarea 出现竖直滚动条时内容宽度会缩窄，
  // 而同一位置的高亮层不会，两层换行位置一分叉后续整段都会错开。
  const syncHighlight = useCallback(() => {
    const ta = textareaRef.current
    const layer = highlightRef.current
    const content = highlightContentRef.current
    if (!ta || !layer) return
    // 外层取景框对齐 textarea 的 padding box：clientWidth/Height 已扣掉边框与滚动条，
    // 滚动条出现/消失时内容宽度同步变化，两层换行位置不会分叉。
    layer.style.width = ta.clientWidth + 'px'
    layer.style.height = ta.clientHeight + 'px'
    layer.style.left = ta.clientLeft + 'px'
    layer.style.top = ta.clientTop + 'px'
    if (content) {
      // 内层是 textarea 内容区的镜像，必须让「内容左边缘 + 可用宽度」逐像素对齐：
      // clientWidth 不含边框，而内层自己带 1px 边框（见 MD_BOX_STYLE），
      // 直接取 clientWidth 会让内层内容区窄 2px —— 换行位置在临界处提前，
      // 长正文里表现为镜像文字与真实光标整体错开。
      // 所以宽度取 clientWidth + 2（补回内层自己的两条边框），并用 -1px 外边距
      // 把内层的内容原点挪到 textarea 内容原点（textarea: border 1 + padding 8）。
      content.style.width = (ta.clientWidth + 2) + 'px'
      content.style.marginLeft = '-1px'
      content.style.marginTop = '-1px'
      content.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
    }
  }, [])

  /**
   * 对齐自检：高亮层与 textarea 是两棵独立的渲染树，字号/字体回退/行高只要有一项
   * 不一致，换行位置就会分叉，表现为「文字和光标对不上」。
   *
   * 这里拿两边的实际内容高度做比对（内容没超出可视高度时看不出差异，跳过）。
   * 一旦发现错位就把文字交还给 textarea——宁可没有语法高亮，也不能显示错位的文字。
   */
  const [highlightAligned, setHighlightAligned] = useState(true)
  const checkAlignment = useCallback(() => {
    const ta = textareaRef.current
    const content = highlightContentRef.current
    if (!ta || !content) return
    // 高亮层只是 opacity:0 隐藏，布局仍在，scrollHeight 始终可测，判错后也能自动恢复。
    // 内容不足以撑出滚动条时两边的差异肉眼也看不出来，不做判断。
    const ok = ta.scrollHeight <= ta.clientHeight + 1
      || Math.abs(content.scrollHeight - ta.scrollHeight) <= 2
    setHighlightAligned((prev) => (prev === ok ? prev : ok))
  }, [])

  // textarea 挂载/卸载、以及用户拖动改变高度时都要重新对齐
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return undefined
    syncHighlight()
    const observer = new ResizeObserver(syncHighlight)
    observer.observe(ta)
    return () => observer.disconnect()
  }, [taNode, syncHighlight])

  // 内容增删导致滚动条出现/消失时，clientWidth 会变但 border-box 尺寸不变，
  // ResizeObserver 不会通知，必须按内容再对齐一次；顺带做一次对齐自检。
  useLayoutEffect(() => {
    syncHighlight()
    checkAlignment()
  }, [value, syncHighlight, checkAlignment])

  /**
   * 图片标记在输入框里当作一个「整体」：
   * - 方向键经过时整块跳过（不进到标记内部）
   * - 单击落在标记中间时吸到较近的一端
   * - 退格/删除碰到标记时整块删掉
   *
   * 所有改动都走浏览器原生编辑路径（setSelectionRange + execCommand），
   * 不手工切字符串：手工切片是 React 受控赋值，浏览器撤销栈收不到这次编辑，
   * Ctrl+Z 就会失效；同时 DOM 与 React 状态要等一次渲染才对齐，光标会短暂错位。
   */

  // 鼠标点击后吸附（拖动选区时不干预）
  const handleTextareaMouseUp = useCallback((e) => {
    const el = e.currentTarget
    if (el.selectionStart !== el.selectionEnd) return
    const span = imageSpanAt(el.value, el.selectionStart)
    if (!span) return
    const mid = span.start + (span.end - span.start) / 2
    const target = el.selectionStart >= mid ? span.end : span.start
    el.setSelectionRange(target, target)
  }, [])

  /**
   * 方向键：整块跳过标记。
   *
   * 在 keydown 里自己算出落点并 preventDefault，而不是移动完再纠正：
   * 事后纠正会先渲染一帧「光标在标记里」的画面，肉眼看到的就是光标乱跳。
   * 纯选区变化不会进入撤销栈，因此这里 preventDefault 不影响 Ctrl+Z。
   */
  const handleTextareaArrowKey = useCallback((e) => {
    const el = e.currentTarget
    if (el.selectionStart !== el.selectionEnd) return false
    const text = el.value
    const pos = el.selectionStart
    const spans = findMarkdownImageSpans(text)

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = e.key === 'ArrowRight' ? 1 : -1
      const next = Math.min(text.length, Math.max(0, pos + step))
      // 落点跨进标记内部 → 直接跳到该侧的边界
      for (const span of spans) {
        if (next > span.start && next < span.end) {
          const target = step > 0 ? span.end : span.start
          e.preventDefault()
          el.setSelectionRange(target, target)
          return true
        }
      }
      return false
    }

    if (e.key === 'Home' || e.key === 'End') {
      // Home/End 若会落入标记内部，同样挪到该侧边界
      const span = spans.find((s) => pos > s.start && pos < s.end)
      if (!span) return false
      const target = e.key === 'End' ? span.end : span.start
      e.preventDefault()
      el.setSelectionRange(target, target)
      return true
    }

    return false
  }, [])

  // 退格 / 删除：与图片标记相交时整段删除，而不是删掉里面的一个字符
  const handleTextareaKeyDown = useCallback((e) => {
    if (disabled) return
    const el = e.currentTarget
    const isBackspace = e.key === 'Backspace'
    const isDelete = e.key === 'Delete'
    // 方向键：整块跳过图片标记（自己算落点，避免先渲染一帧错误光标）
    if (!isBackspace && !isDelete) {
      handleTextareaArrowKey(e)
      return
    }

    const { selectionStart: selStart, selectionEnd: selEnd } = el
    const text = el.value
    // 有选区：按选区两端扩展；无选区：按方向取相邻的一个字符
    let from = selStart
    let to = selEnd
    if (selStart === selEnd) {
      if (isBackspace) from = Math.max(0, selStart - 1)
      else to = Math.min(text.length, selEnd + 1)
    }

    const expanded = expandRangeToImageSpans(text, from, to)
    if (expanded.start === from && expanded.end === to) return

    // 关键：把选区扩成整个标记后交给浏览器原生删除，而不是 preventDefault 后手工切片。
    // 手工切片走的是 React 受控赋值，浏览器撤销栈收不到这次编辑 —— Ctrl+Z 就失效了；
    // execCommand('delete') 走原生编辑路径，撤销栈完整。
    e.preventDefault()
    el.setSelectionRange(expanded.start, expanded.end)
    document.execCommand('delete')
  }, [disabled, handleTextareaArrowKey])

  // 兜底：选区/光标压在图片标记内部时，先把选区扩成整块，再让浏览器自己插入。
  // 这里只改选区、不 preventDefault、不手工切字符串——插入仍走原生路径，
  // 撤销栈才完整；手工切片正是 Ctrl+Z 失效与光标错位的根源。
  const handleTextareaBeforeInput = useCallback((e) => {
    const el = e.currentTarget
    const text = el.value
    const from = el.selectionStart
    const to = el.selectionEnd

    if (from !== to) {
      const expanded = expandRangeToImageSpans(text, from, to)
      if (expanded.start === from && expanded.end === to) return
      el.setSelectionRange(expanded.start, expanded.end)
      return
    }

    const span = imageSpanAt(text, from)
    if (span) el.setSelectionRange(span.end, span.end)
  }, [])

  const insertAtCursor = useCallback((text) => {
    const textarea = textareaRef.current
    if (!textarea) {
      onChange?.((value || '') + text)
      return
    }
    const current = textarea.value
    // 落点在已有图片语法内部时先跳到语法末尾，否则会拼出 `![a![b](c)d](e)` 这种
    // 嵌套写法——marked 会把内层当成 alt 文本，外层 URL 变成真正的 src。
    const start = clampImageInsertPosition(current, textarea.selectionStart ?? current.length)
    const end = Math.max(start, clampImageInsertPosition(current, textarea.selectionEnd ?? current.length))
    textarea.focus()
    textarea.setSelectionRange(start, end)
    // 走原生插入：撤销栈连续，光标也由浏览器自己摆好，不需要 rAF 补位
    if (!document.execCommand('insertText', false, text)) {
      // 极少数环境 execCommand 不可用：退回受控赋值（此时撤销栈会断，但不至于插不进去）
      onChange?.(current.slice(0, start) + text + current.slice(end))
      setTimeout(() => textarea.setSelectionRange(start + text.length, start + text.length), 0)
    }
  }, [value, onChange])

  const handleInsertImage = async () => {
    try {
      const images = await selectImageFiles({ multiple: false })
      if (images.length === 0) return
      const img = images[0]
      const text = `![${img.file.name}](${img.pendingUrl})`
      if (maxLength && (value || '').length + text.length > maxLength) {
        alert(t('editor.imageInsertLimitReached') || t('editor.imageInsertFailed'))
        return
      }
      registerPendingImages([img])
      insertAtCursor(text)
    } catch (e) {
      alert(t('editor.imageInsertFailed') + e.message)
    }
  }

  const handlePaste = async (e) => {
    const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    for (const file of files) {
      try {
        const img = createPendingImage(file)
        const text = `![${file.name}](${img.pendingUrl})`
        if (maxLength && (value || '').length + text.length > maxLength) {
          alert(t('editor.imageInsertLimitReached') || t('editor.imageInsertFailed'))
          break
        }
        registerPendingImages([img])
        insertAtCursor(text)
      } catch (err) {
        alert(t('editor.imageInsertFailed') + err.message)
      }
    }
  }

  // placeholder 里补上 @ 的用法；空态时贴着输入区当 placeholder，聚焦/有内容后
  // 浮到下边框，避免输入后说明消失
  const floatLabel = t('editor.mentionUsage') + ' · ' + placeholderText
  const labelFloating = focused || !!(value || '').length

  // textarea 既要给 MentionAutocomplete 用（textareaRef），也要挂给高度持久化 hook，
  // 合并成一个稳定回调，避免每次渲染都重新挂载观察者
  const handleTextareaRef = useCallback((el) => {
    textareaRef.current = el
    setTaNode(el)
    attachHeight?.(el)
  }, [attachHeight])

  // Ctrl+Enter 提交：挂在 document 捕获阶段而不是 React 的 onKeyDown 上。
  // textarea 上还有 @补全 的原生 keydown 监听，它命中候选项时会 stopPropagation，
  // 走到 React 合成事件时快捷键就丢了（楼中楼回复框尤其容易碰上）。
  useEffect(() => {
    if (!taNode || !onSubmit) return undefined
    const onKey = (e) => {
      if (e.target !== taNode) return
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key !== 'Enter' && e.keyCode !== 13) return
      e.preventDefault()
      e.stopPropagation()
      if (!disabled) onSubmit()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [taNode, onSubmit, disabled])

  // 外层包裹原本靠 flex:1 撑满，文本域一旦定高就会比包裹矮：
  // 浮动标签是相对包裹定位的，会掉到输入框下方很远。让包裹改为贴合内容。
  const wrapStyle = heightStyleFn
    ? (split ? { alignSelf: 'flex-start' } : { flex: '0 0 auto' })
    : undefined

  const textareaEl = (
    <div className={styles.mdTextareaWrap} style={wrapStyle}>
      {/* 语法高亮层：只负责「显示」，文字颜色来自这里；textarea 文字透明但保留光标。
          外层由 syncHighlight 按 textarea 实测尺寸定位（含滚动条宽度差异），
          内层承载排版并跟随滚动位移，避免每次滚动都触发 React 重渲染。 */}
      <div
        ref={highlightRef}
        className={mergeClasses(
          styles.mdHighlight,
          (composing || !highlightAligned) && styles.mdHighlightOff,
        )}
        aria-hidden="true"
      >
        <div
          ref={highlightContentRef}
          className={styles.mdHighlightContent}
          style={MD_BOX_STYLE}
        >
          {buildHighlightNodes(value || '', styles.mdHighlightImg)}
        </div>
      </div>
      <textarea
      ref={handleTextareaRef}
      className={styles.mdTextarea}
      style={{
        ...MD_BOX_STYLE,
        minHeight: '192px',
        flex: 1,
        // 边框只改颜色，不额外改宽度：宽度已在 MD_BOX_STYLE 里统一为 1px，
        // 这里再声明一次 history 会覆盖掉透明边框，导致两侧内容宽度不一致。
        borderColor: tokens.colorNeutralStroke1,
        outline: 'none',
        resize: split && !heightStyleFn ? 'none' : 'vertical',
        width: '100%',
        // 文字交给下面的高亮层绘制，这里只保留光标与选区。
        // 以下两种情况必须把文字交还给 textarea（否则会出现「看得见但显示错位」）：
        // - 输入法组合期间：要高亮层隐藏，否则候选词不可见
        // - 自检发现两层换行不一致：宁可没有语法高亮，也不能显示错位的文字
        color: composing || !highlightAligned ? tokens.colorNeutralForeground1 : 'transparent',
        caretColor: tokens.colorNeutralForeground1,
        backgroundColor: 'transparent',
        position: 'relative',
        zIndex: 1,
        ...(heightStyleFn ? heightStyleFn() : null),
      }}
      placeholder=""
      aria-label={floatLabel}
      value={value || ''}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      onFocus={(e) => { setFocused(true); onFocusChange?.(true, e) }}
      onBlur={() => { setFocused(false); onFocusChange?.(false) }}
      onScroll={syncHighlight}
      onMouseUp={handleTextareaMouseUp}
      onKeyDown={handleTextareaKeyDown}
      onBeforeInput={handleTextareaBeforeInput}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onPaste={disabled ? undefined : handlePaste}
      />
      <span className={mergeClasses(styles.mdLabel, labelFloating && styles.mdLabelFloat)}>
        {floatLabel}
      </span>
    </div>
  )

  // 预览面板的高度：传了 previewHeightState 就与编辑框一样可拖动并写入 sqlite。
  // 分栏模式下预览被限制在 384px 内，不参与持久化——它和 textarea 并排，
  // 高度由父级 grid 统一拉伸，单独记住没有意义。
  const previewHeightStyle = !split && previewHeightFn
    ? {
      ...previewHeightFn(),
      // 拖动时要能突破 mdPreview 默认的 200px 上限，否则 heightStyle 写进去的
      // height 会被 class 上的 maxHeight 截住，用户会觉得「拖不动」
      maxHeight: 'none',
      // usePersistedHeight 靠 ResizeObserver 捕捉用户拖出来的高度，前提是元素本身
      // 可拖拽（与 textarea 的 resize: vertical 同一套机制）
      resize: 'vertical',
      overflow: 'auto',
    }
    : null
  // 加载态与内容态共用同一个节点：两棵不同的树各挂一次 ref，React 会先把它置空
  // 再挂到新节点上，usePersistedHeight 的 ResizeObserver 会跟着重新挂载、重置
  // 「跳过首次观察」的状态，拖出来的高度可能记成初始值。
  const previewEl = (
    <div
      className={mergeClasses(
        styles.mdPreview,
        split && styles.mdPreviewSplit,
        fill && split && styles.mdPreviewFill,
      )}
      ref={split ? undefined : attachPreviewHeight}
      style={split ? undefined : previewHeightStyle}
    >
      {previewLoading ? t('editor.previewLoading') : previewBody}
    </div>
  )

  return (
    <div className={styles.mdContainer}>
      <div className={styles.toolbar}>
        <Tooltip content={t('editor.insertImage')} relationship="label">
          <Button size="small" disabled={disabled} icon={<Image24Regular />} onClick={handleInsertImage}>{t('editor.image')}</Button>
        </Tooltip>
        {!split && (
          <>
            <Button size="small" disabled={disabled} appearance={!showPreview ? 'filled' : 'subtle'} onClick={() => setShowPreview(false)}>{t('editor.edit')}</Button>
            <Button size="small" appearance={showPreview ? 'filled' : 'subtle'} onClick={() => setShowPreview(true)}>{t('editor.preview')}</Button>
          </>
        )}
        {split && <Text className={styles.splitHint}>{t('editor.splitPreviewHint')}</Text>}
      </div>
      {split ? (
        <div className={mergeClasses(styles.mdSplit, fill && styles.mdSplitFill)}>
          {textareaEl}
          {previewEl}
        </div>
      ) : showPreview ? (
        previewEl
      ) : (
        textareaEl
      )}
      {(!showPreview || split) && (
        <MentionAutocomplete
          textareaRef={textareaRef}
          onChange={onChange}
          disabled={disabled}
        />
      )}
      {maxLength && maxLength > 0 && (
        <Text className={styles.charCount}>
          {(value || '').length} / {maxLength}
        </Text>
      )}
    </div>
  )
}

/**
 * 纯文本多行输入（无工具栏 / 不做 Markdown 解析）。
 *
 * 与 MarkdownEditor 共用同一套输入框样式和 usePersistedHeight 高度记忆机制，
 * 用于模组简介这类本来就是纯文本的字段——不要再用 Fluent 的 Textarea：
 * 它把 style 挂在外层 span 上，拖动内层 textarea 时外壳不跟着长，高度不实时。
 *
 * @param {object} [props.heightState] usePersistedHeight 的返回值（含 attach 与 heightStyle）
 */
export function PlainTextarea({ value, onChange, placeholder, maxLength, disabled = false, heightState, ariaLabel }) {
  const styles = useStyles()
  const { attach: attachHeight, heightStyle: heightStyleFn } = heightState || {}

  return (
    <textarea
      ref={attachHeight}
      className={styles.mdTextarea}
      style={{
        minHeight: '56px',
        fontFamily: 'inherit',
        fontSize: tokens.fontSizeSmall,
        padding: '6px 8px',
        border: `1px solid ${tokens.colorNeutralStroke1}`,
        borderRadius: '4px',
        outline: 'none',
        resize: 'vertical',
        boxSizing: 'border-box',
        width: '100%',
        ...(heightStyleFn ? heightStyleFn() : null),
      }}
      placeholder={placeholder}
      aria-label={ariaLabel || placeholder}
      value={value || ''}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
    />
  )
}

/** 纯文本里的裸链接（排除中日文标点，避免把句号吃进 URL） */
const PLAIN_URL_RE = /https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef]+/g
/** URL 结尾的英文标点属于正文 */
const URL_TRAILING_PUNCT = /[.,;:!?)\]]+$/

/**
 * 纯文本模式下的链接化：把裸链接渲染成普通超链接（蓝色下划线，与 Markdown 链接一致）。
 * 独立成段的链接已被拆成卡片，走不到这里。
 */
function renderPlainText(text) {
  const nodes = []
  let last = 0
  for (const m of text.matchAll(PLAIN_URL_RE)) {
    const url = m[0].replace(URL_TRAILING_PUNCT, '')
    if (url.length <= 8) continue
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(
      <a key={m.index} href={url} target="_blank" rel="noreferrer noopener">{url}</a>
    )
    last = m.index + url.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const useLinkCardStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    marginBottom: '4px',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: '4px',
  },
})

// 正文内联图片复用 ImageWithLoading（与讨论区列表页一致的预加载占位组件）：
// 把 HTML 字符串解析成 React 树，遇到 <img> 渲染成 ImageWithLoading，其余标签原样透传，
// 使正文容器后代选择器里针对 img 的样式（maxWidth、cursor 等）继续生效。
// 编辑器输入框与语法高亮镜像层共用的排版参数。
// 两层的字体、字号、行高、内边距、边框宽度必须完全一致，否则镜像文字会和
// 真实文本错位（高亮层只在 textarea 文字透明后负责「显示」，位置必须严丝合缝）。
// 换行规则同理：两层都允许长 URL 从中间断开，否则一处换行、另一处横向滚动，
// 后续所有行都会错开。
const MD_BOX_STYLE = {
  // 注意：Fluent 没有 fontSizeSmall 这个 token（那是 v8 的名字），取到的是 undefined。
  // 一旦某一边拿到 undefined，就会各自回退到不同默认值（textarea 用 UA 的
  // 13.3333px，div 继承父级 14px），换行位置随之分叉，高亮层与文字整体错位。
  fontFamily: 'monospace',
  fontSize: tokens.fontSizeBase300,
  lineHeight: '1.4',
  padding: '6px 8px',
  // 两侧都留 1px 透明边框：textarea 的边框会占掉内容宽度，
  // 高亮层若没有等效边框，可用宽度就会差 2px、换行提前。
  border: '1px solid transparent',
  borderRadius: '4px',
  boxSizing: 'border-box',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  textAlign: 'start',
  tabSize: 4,
}

// 正文图片的排版样式。注意 makeStyles 返回的是 hook（必须组件内调用），
// 早前直接当成对象取 .block 拿到的是 undefined，类名等于没生效。
const useContentImgStyles = makeStyles({
  // 正文图片一律独占一行：ImageWithLoading 根节点默认是 inline-block，会和前后
  // 文字挤在同一行——用户写正文时几乎不会手动换行（`![a](…)文字` 是常态），
  // 结果图片与文字并排、高度参差，版面非常乱。改成 block 后图片自己吃掉一行，
  // 前后文字各自成行，不需要用户懂 Markdown 换行规则。
  // mergeClasses 里 className 排在 styles.root 之后，因此这里的 display 能覆盖
  // 组件自带的 inline-block，不需要提高选择器权重。
  block: {
    display: 'block',
    // 上下留一点节奏感；左右不设 margin，让图片贴着正文左边缘（与文字对齐）
    marginTop: '8px',
    marginBottom: '8px',
    // 大图最多占容器 70%：上限通过 inline style 挂在根节点上（inline 永远压过
    // 组件自带的 styles.root maxWidth:100%，不依赖 mergeClasses 优先级），小图不受影响。
    verticalAlign: 'top',
  },
  imgBlock: {
    display: 'block',
  },
})

// 从 <img> 的 width/height 属性推导占位比例：有真实尺寸时占位框与最终图片等高，
// 加载完成不产生任何位移。marked 对 ![alt](url) 不输出尺寸，所以只有显式写了
// width/height 的图才有值，其余返回 undefined，由组件自适应图片自身高度。
function ratioFromImg(img) {
  const w = Number(img.getAttribute('width'))
  const h = Number(img.getAttribute('height'))
  if (!(w > 0) || !(h > 0)) return undefined
  return `${w} / ${h}`
}

const HTML_ATTR_CAMEL = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  minlength: 'minLength',
  crossorigin: 'crossOrigin',
  hreflang: 'hrefLang',
  datetime: 'dateTime',
  novalidate: 'noValidate',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  spellcheck: 'spellCheck',
  contenteditable: 'contentEditable',
}
const HTML_SKIP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'noscript', 'head', 'html', 'body',
])

function parseInlineStyle(str) {
  if (!str) return undefined
  const style = {}
  for (const decl of String(str).split(';')) {
    const idx = decl.indexOf(':')
    if (idx <= 0) continue
    const prop = decl.slice(0, idx).trim().toLowerCase()
    const val = decl.slice(idx + 1).trim()
    if (!prop || !val) continue
    const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    style[camel] = val
  }
  return style
}

/**
 * 这些容器里的图片不能强制独占一行：标题本身是单行语义，把图拆成块级会让
 * 标题变短、图片掉到标题外面；表格单元格里同理。
 */
const INLINE_IMG_CONTEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'a'])

function htmlToReact(html, imgClasses) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const walk = (node, depth, ancestors = new Set()) => {
    const out = []
    Array.from(node.childNodes).forEach((child, i) => {
      const key = `${depth}-${i}`
      if (child.nodeType === 3) {
        const text = child.nodeValue
        if (text) out.push(text)
        return
      }
      if (child.nodeType !== 1) return
      const tag = child.tagName.toLowerCase()
      if (HTML_SKIP_TAGS.has(tag)) return
      if (tag === 'img') {
        const src = child.getAttribute('src') || ''
        if (!src) return
        // 未上传的本地占位（imgbed://pending/...）刷新后必然加载不出来：
        // 这类图在渲染侧直接跳过，避免正文里留一个永久的破图/占位框。
        if (isPendingUrl(src)) return
        // 标题/表格/链接这类行内上下文里保持原样，不套「独占一行」的样式
        const inlineCtx = [...ancestors].some((t) => INLINE_IMG_CONTEXT_TAGS.has(t))
        out.push(
          <ImageWithLoading
            key={key}
            src={src}
            alt={child.getAttribute('alt') || ''}
            placeholder
            placeholderRatio={ratioFromImg(child)}
            className={inlineCtx ? undefined : imgClasses?.block}
            imgClassName={imgClasses?.imgBlock}
            style={{ maxWidth: '70%' }}
          />,
        )
        return
      }
      const attrs = {}
      for (const a of Array.from(child.attributes)) {
        const name = a.name.toLowerCase()
        if (name.startsWith('on')) continue
        const mapped = HTML_ATTR_CAMEL[name] || name
        if (mapped === 'style') attrs.style = parseInlineStyle(a.value)
        else attrs[mapped] = a.value
      }
      const children = walk(child, key, new Set([...ancestors, tag]))
      out.push(createElement(tag, { key, ...attrs }, ...children))
    })
    return out
  }
  return walk(doc.body, 'n')
}

/**
 * @param {object} props
 * @param {boolean} [props.plain] 纯文本模式：正文不做 Markdown 解析（保留换行与打字原貌），
 *   但仍把独立成段的链接渲染成卡片。用于模组简介这类本来就是纯文本的字段。
 * @param {string} [props.className] 覆盖外层样式类（plain 模式下通常由调用方提供）
 */
export function MarkdownContent({ markdown, onImageClick, variant = 'compact', plain = false, className }) {
  const cardStyles = useLinkCardStyles()
  const compactStyles = useContentStyles()
  const articleStyles = useArticleContentStyles()
  const imgClasses = useContentImgStyles()
  const styles = variant === 'article' ? articleStyles : compactStyles
  const ref = useRef(null)
  const nav = useContext(UserNavContext)
  const [mentionHover, setMentionHover] = useState(null)

  // 独立成段的裸链接 / @提及 单独渲染成卡片，其余内容仍走 Markdown
  const segments = useMemo(() => splitMarkdownWithLinkCards(markdown || ''), [markdown])

  // marked 产出的是普通 <a>，这里补上 data 标记并接管悬浮卡片
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || plain) return undefined
    // 模组与主题帖两种提及都要接管（parseMentionHref 会过滤其余 sfmmm: 链接）
    const anchors = Array.from(root.querySelectorAll('a[href^="sfmmm:"]'))
    const cleanups = []
    for (const anchor of anchors) {
      const target = parseMentionHref(anchor.getAttribute('href'))
      if (!target) continue
      anchor.setAttribute('data-mod-mention', target.kind + ':' + target.ref)
      const enter = () => {
        const rect = anchor.getBoundingClientRect()
        setMentionHover({
          ...target,
          label: (anchor.textContent || '').replace(/^@/, ''),
          rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
        })
      }
      const leave = () => setMentionHover((cur) => (
        cur && cur.kind === target.kind && cur.ref === target.ref ? null : cur
      ))
      anchor.addEventListener('mouseenter', enter)
      anchor.addEventListener('mouseleave', leave)
      cleanups.push(() => {
        anchor.removeEventListener('mouseenter', enter)
        anchor.removeEventListener('mouseleave', leave)
      })
    }
    return () => {
      for (const fn of cleanups) fn()
    }
  }, [markdown, plain, segments])

  // 页面滚动时收起悬浮卡片，避免它停在原处遮挡正文
  useEffect(() => {
    if (!mentionHover) return undefined
    const hide = () => setMentionHover(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [mentionHover])

  if (!markdown) return null

  // 事件委托：@提及 走应用内跳转；图片点击回调灯箱
  const handleClick = (e) => {
    const mention = e.target?.closest?.('a[data-mod-mention]')
    if (mention) {
      e.preventDefault()
      e.stopPropagation()
      const target = parseMentionHref(mention.getAttribute('href'))
      if (target) {
        rememberEntryPoint(
          mention,
          (target.kind === 'discussion' ? 'discuss:' : 'mod:') + target.ref
        )
      }
      if (target?.kind === 'discussion') {
        window.location.hash = '#/discuss/' + encodeURIComponent(target.ref)
      } else if (target?.ref) {
        nav?.openMod?.(target.ref)
      }
      return
    }
    if (!onImageClick) return
    const target = e.target
    if (target && target.tagName === 'IMG') {
      // 链接卡片自己的封面图不弹灯箱，点击应打开外链
      if (target.closest('[data-no-progressive]')) return
      const all = ref.current
        ? Array.from(ref.current.querySelectorAll('img')).map(i => i.getAttribute('src') || '')
        : []
      onImageClick(target.getAttribute('src') || '', all)
    }
  }

  const containerClass = className !== undefined ? className : (plain ? undefined : styles.content)
  const hasSpecial = segments.some((seg) => seg.type === 'cards' || seg.type === 'mention')

  let body
  if (!hasSpecial) {
    body = plain ? (
      <div
        ref={ref}
        className={containerClass}
        onClick={handleClick}
        style={{ whiteSpace: 'pre-wrap' }}
      >
        {renderPlainText(markdown)}
      </div>
    ) : (
      <div ref={ref} className={containerClass} onClick={handleClick}>
        {htmlToReact(renderMarkdown(markdown), imgClasses)}
      </div>
    )
  } else {
    body = (
      <div ref={ref} className={containerClass} onClick={handleClick}>
        {segments.map((seg, i) => (
          seg.type === 'cards' ? (
            <div key={`cards-${i}`} className={cardStyles.list}>
              {seg.items.map((item, j) => (
                <div key={`card-${j}`} className={cardStyles.item}>
                  {item.label && <div className={cardStyles.label}>{item.label}</div>}
                  <LinkCard url={item.url} />
                </div>
              ))}
            </div>
          ) : seg.type === 'mention' ? (
            <div key={`mention-${i}`} className={cardStyles.list}>
              <MentionCard kind={seg.kind} refKey={seg.ref} label={seg.label} />
            </div>
          ) : plain ? (
            <div key={`md-${i}`} style={{ whiteSpace: 'pre-wrap' }}>{renderPlainText(seg.text)}</div>
          ) : (
            <div key={`md-${i}`}>{htmlToReact(markdown ? renderMarkdown(seg.text) : seg.text, imgClasses)}</div>
          )
        ))}
      </div>
    )
  }

  const hoverStyle = mentionHover ? (() => {
    const width = 380
    const left = Math.max(8, Math.min(mentionHover.rect.left, window.innerWidth - width - 8))
    return mentionHover.rect.top > 260
      ? { left: left + 'px', top: (mentionHover.rect.top - 8) + 'px', transform: 'translateY(-100%)' }
      : { left: left + 'px', top: (mentionHover.rect.bottom + 8) + 'px' }
  })() : null

  return (
    <>
      {body}
      {mentionHover && (
        <div
          style={{
            position: 'fixed',
            zIndex: 10000,
            pointerEvents: 'none',
            ...hoverStyle,
          }}
        >
          <MentionCard
            kind={mentionHover.kind}
            refKey={mentionHover.ref}
            label={mentionHover.label}
            variant="hover"
          />
        </div>
      )}
    </>
  )
}

export function RichTextContent({ html, onImageClick, variant = 'compact' }) {
  const cardStyles = useLinkCardStyles()
  const compactStyles = useContentStyles()
  const articleStyles = useArticleContentStyles()
  const imgClasses = useContentImgStyles()
  const styles = variant === 'article' ? articleStyles : compactStyles
  const ref = useRef(null)

  // 富文本里独立成段的裸链接同样渲染成卡片，与 Markdown 正文保持一致
  const segments = useMemo(() => splitRichtextWithLinkCards(html || ''), [html])
  const hasCards = segments.some((seg) => seg.type === 'cards')

  if (!html) return null

  // 事件委托：捕获内容区域内的图片点击，回调图片地址与全部图片列表（与 MarkdownContent 同模式）
  const handleClick = (e) => {
    if (!onImageClick) return
    const target = e.target
    if (target && target.tagName === 'IMG') {
      const all = ref.current
        ? Array.from(ref.current.querySelectorAll('img')).map(i => i.getAttribute('src') || '')
        : []
      onImageClick(target.getAttribute('src') || '', all)
    }
  }

  if (!hasCards) {
    return (
      <div
        ref={ref}
        className={styles.content}
        onClick={handleClick}
      >
        {htmlToReact(html, imgClasses)}
      </div>
    )
  }

  return (
    <div ref={ref} className={styles.content} onClick={handleClick}>
      {segments.map((seg, i) => (
        seg.type === 'cards' ? (
          <div key={`cards-${i}`} className={cardStyles.list}>
            {seg.items.map((item, j) => (
              <div key={`card-${j}`} className={cardStyles.item}>
                {item.label && <div className={cardStyles.label}>{item.label}</div>}
                <LinkCard url={item.url} />
              </div>
            ))}
          </div>
        ) : (
          <div key={`html-${i}`}>{htmlToReact(seg.html, imgClasses)}</div>
        )
      ))}
    </div>
  )
}
