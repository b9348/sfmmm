import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input, Text, makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '6px',
    padding: '12px 0',
    flexWrap: 'wrap',
  },
  // 悬浮模式：相对视口底部居中固定，带背景/阴影/圆角，避免遮挡内容
  floating: {
    position: 'fixed',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 1000,
    padding: '6px 12px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow8,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  // 悬浮时在文档流末尾预留等同高度的占位，避免固定条盖住最后一行内容
  spacer: {
    height: '64px',
    flexShrink: 0,
  },
  pageInput: {
    width: '56px',
    '& input': {
      textAlign: 'center',
    },
  },
})

/**
 * 分页组件。
 *
 * @param {number} page        当前页码（1 起）
 * @param {number} totalPages  总页数
 * @param {(p: number) => void} onChange 切换页码回调
 * @param {boolean} disabled   禁用交互（如加载中）
 * @param {boolean} floating   为 true 时相对视口底部悬浮（固定定位）
 */
export function Pagination({ page, totalPages, onChange, disabled = false, floating = false }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const inputRef = useRef(null)

  // 输入框草稿值；editing 为 true 表示正在编辑，不随外部 page 变化而被覆盖
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  // 健壮性：对非数值/越界做归一化，page 钳制到 [1, total]
  const total = Number.isFinite(Number(totalPages)) ? Math.max(1, Math.floor(Number(totalPages))) : 1
  const current = Number.isFinite(Number(page)) ? Math.min(Math.max(1, Math.floor(Number(page))), total) : 1

  // 外部页码变化（翻页/刷新/筛选）时同步输入框；正在编辑时保持用户输入
  useEffect(() => {
    if (!editing) setDraft(String(current))
  }, [current, editing])

  if (total <= 1) return null

  // 跳转：钳制到合法范围，触发 onChange（页码未变化时忽略）
  const jumpTo = (raw) => {
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n)) {
      setDraft(String(current))
      return
    }
    const next = Math.min(Math.max(1, n), total)
    setDraft(String(next))
    setEditing(false)
    if (next !== current) onChange?.(next)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      jumpTo(draft)
      inputRef.current?.blur?.()
    } else if (e.key === 'Escape') {
      setDraft(String(current))
      setEditing(false)
      inputRef.current?.blur?.()
    }
  }

  const pageNav = (
    <>
      <Button size="small" disabled={current <= 1 || disabled} onClick={() => onChange?.(current - 1)}>
        {t('workshop.prevPage')}
      </Button>
      <Input
        ref={inputRef}
        size="small"
        className={styles.pageInput}
        value={editing ? draft : String(current)}
        aria-label={t('workshop.pageInput')}
        disabled={disabled}
        onChange={(_, d) => {
          // 只允许数字
          const digits = d.value.replace(/\D/g, '')
          setDraft(digits)
          setEditing(true)
        }}
        onFocus={() => { setDraft(String(current)); setEditing(true) }}
        onKeyDown={handleKeyDown}
        onBlur={() => { setDraft(String(current)); setEditing(false) }}
      />
      <Text size="small">/ {total}</Text>
      <Button size="small" disabled={current >= total || disabled} onClick={() => onChange?.(current + 1)}>
        {t('workshop.nextPage')}
      </Button>
    </>
  )

  if (floating) {
    return (
      <>
        {/* 预留空间：固定条悬浮在视口底部，末尾占位保证滚动到底时最后一行不被遮挡 */}
        <div className={styles.spacer} aria-hidden="true" />
        <div className={`${styles.root} ${styles.floating}`}>{pageNav}</div>
      </>
    )
  }

  return <div className={styles.root}>{pageNav}</div>
}
