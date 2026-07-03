import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditor, EditorContent } from '@tiptap/react'
import { nodeInputRule, nodePasteRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import CharacterCount from '@tiptap/extension-character-count'
import { makeStyles, tokens, Button, Tooltip, Text } from '@fluentui/react-components'
import { marked } from 'marked'
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
} from '../../services/imageApi'

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
    },
  },
})

export function RichTextEditor({ value, onChange, placeholder, maxLength, disabled = false }) {
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
    <div className={styles.editor} onPaste={disabled ? undefined : handlePaste}>
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

export function MarkdownEditor({ value, onChange, placeholder, maxLength, disabled = false }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const textareaRef = useRef(null)
  const [showPreview, setShowPreview] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const placeholderText = placeholder ?? t('editor.markdownPlaceholder')

  // 预览时把 pending URL 替换为本地 data URL
  useEffect(() => {
    if (!showPreview) return
    let cancelled = false
    const resolve = async () => {
      setPreviewLoading(true)
      const rawHtml = await marked(value || '')
      const parser = new DOMParser()
      const doc = parser.parseFromString(rawHtml, 'text/html')
      const images = doc.querySelectorAll('img')
      for (const img of images) {
        const src = img.getAttribute('src')
        if (isPendingUrl(src)) {
          const realSrc = await resolvePendingUrlForPreview(src)
          img.setAttribute('src', realSrc)
        }
      }
      if (!cancelled) {
        setPreviewHtml(doc.body.innerHTML)
        setPreviewLoading(false)
      }
    }
    resolve()
    return () => { cancelled = true }
  }, [showPreview, value])

  const insertAtCursor = useCallback((text) => {
    const textarea = textareaRef.current
    if (textarea) {
      const start = textarea.selectionStart ?? (value || '').length
      const end = textarea.selectionEnd ?? (value || '').length
      const current = value || ''
      const newValue = current.slice(0, start) + text + current.slice(end)
      onChange?.(newValue)
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + text.length
        textarea.focus()
      }, 0)
    } else {
      onChange?.((value || '') + text)
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

  return (
    <div className={styles.mdContainer}>
      <div className={styles.toolbar}>
        <Tooltip content={t('editor.insertImage')} relationship="label">
          <Button size="small" disabled={disabled} icon={<Image24Regular />} onClick={handleInsertImage}>{t('editor.image')}</Button>
        </Tooltip>
        <Button size="small" disabled={disabled} appearance={!showPreview ? 'filled' : 'subtle'} onClick={() => setShowPreview(false)}>{t('editor.edit')}</Button>
        <Button size="small" appearance={showPreview ? 'filled' : 'subtle'} onClick={() => setShowPreview(true)}>{t('editor.preview')}</Button>
      </div>
      {showPreview ? (
        previewLoading ? (
          <div className={styles.mdPreview}>{t('editor.previewLoading')}</div>
        ) : (
          <div
            className={styles.mdPreview}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )
      ) : (
        <textarea
          ref={textareaRef}
          className={styles.mdTextarea}
          style={{ minHeight: '160px', fontFamily: 'monospace', fontSize: tokens.fontSizeSmall, flex: 1, padding: '6px 8px', border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: '4px', outline: 'none', resize: 'vertical', boxSizing: 'border-box', width: '100%' }}
          placeholder={placeholderText}
          value={value || ''}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
          onPaste={disabled ? undefined : handlePaste}
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

export function MarkdownContent({ markdown }) {
  const styles = useContentStyles()

  if (!markdown) return null

  return (
    <div
      className={styles.content}
      dangerouslySetInnerHTML={{ __html: marked(markdown) }}
    />
  )
}

export function RichTextContent({ html }) {
  const styles = useContentStyles()

  if (!html) return null

  return (
    <div
      className={styles.content}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
