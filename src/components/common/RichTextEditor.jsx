import { useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { makeStyles, tokens, Button, Tooltip } from '@fluentui/react-components'
import { marked } from 'marked'

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

export function RichTextEditor({ value, onChange, placeholder = '输入内容...' }) {
  const styles = useStyles()

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
    ],
    content: value || '',
    onUpdate: ({ editor: ed }) => {
      onChange?.(ed.getHTML())
    },
  })

  if (!editor) return null

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <Tooltip content="粗体" relationship="label"><Button size="small" appearance={editor.isActive('bold') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></Button></Tooltip>
        <Tooltip content="斜体" relationship="label"><Button size="small" appearance={editor.isActive('italic') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></Button></Tooltip>
        <Tooltip content="删除线" relationship="label"><Button size="small" appearance={editor.isActive('strike') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></Button></Tooltip>
        <Tooltip content="行内代码" relationship="label"><Button size="small" appearance={editor.isActive('code') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleCode().run()}>{'</>'}</Button></Tooltip>
        <Tooltip content="分隔线" relationship="label"><Button size="small" appearance="subtle" onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</Button></Tooltip>
        <Tooltip content="标题 2" relationship="label"><Button size="small" appearance={editor.isActive('heading', { level: 2 }) ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</Button></Tooltip>
        <Tooltip content="标题 3" relationship="label"><Button size="small" appearance={editor.isActive('heading', { level: 3 }) ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</Button></Tooltip>
        <Tooltip content="无序列表" relationship="label"><Button size="small" appearance={editor.isActive('bulletList') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleBulletList().run()}>•</Button></Tooltip>
        <Tooltip content="有序列表" relationship="label"><Button size="small" appearance={editor.isActive('orderedList') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</Button></Tooltip>
        <Tooltip content="引用" relationship="label"><Button size="small" appearance={editor.isActive('blockquote') ? 'filled' : 'subtle'} onClick={() => editor.chain().focus().toggleBlockquote().run()}>"</Button></Tooltip>
        <Tooltip content="撤销" relationship="label"><Button size="small" appearance="subtle" onClick={() => editor.chain().focus().undo().run()}>↶</Button></Tooltip>
        <Tooltip content="重做" relationship="label"><Button size="small" appearance="subtle" onClick={() => editor.chain().focus().redo().run()}>↷</Button></Tooltip>
      </div>
      <EditorContent editor={editor} className={styles.editorContent} />
    </div>
  )
}

export function MarkdownEditor({ value, onChange, placeholder = '输入 Markdown 内容...' }) {
  const styles = useStyles()
  const [showPreview, setShowPreview] = useState(false)

  return (
    <div className={styles.mdContainer}>
      <div className={styles.toolbar}>
        <Button size="small" appearance={!showPreview ? 'filled' : 'subtle'} onClick={() => setShowPreview(false)}>编辑</Button>
        <Button size="small" appearance={showPreview ? 'filled' : 'subtle'} onClick={() => setShowPreview(true)}>预览</Button>
      </div>
      {showPreview ? (
        <div
          className={styles.mdPreview}
          dangerouslySetInnerHTML={{ __html: marked(value || '') }}
        />
      ) : (
        <textarea
          className={styles.mdTextarea}
          style={{ minHeight: '160px', fontFamily: 'monospace', fontSize: tokens.fontSizeSmall, flex: 1, padding: '6px 8px', border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: '4px', outline: 'none', resize: 'vertical', boxSizing: 'border-box', width: '100%' }}
          placeholder={placeholder}
          value={value || ''}
          onChange={(e) => onChange?.(e.target.value)}
        />
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
