import { useState, useEffect } from 'react'
import { Button, Text, makeStyles, tokens } from '@fluentui/react-components'
import { useTranslation } from 'react-i18next'

const useStyles = makeStyles({
  hole: {
    position: 'fixed',
    zIndex: 2000,
    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
    borderRadius: '8px',
    transition: 'left 0.2s ease, top 0.2s ease, width 0.2s ease, height 0.2s ease',
  },
  bubble: {
    position: 'fixed',
    zIndex: 2001,
    width: '260px',
    padding: '12px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    boxShadow: tokens.shadow16,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
})

/**
 * 聚光灯式漫游引导：半透明遮罩 + 高亮目标元素 + 气泡提示。
 * 仅当目标元素存在时渲染；目标消失（切换页面/未挂载）自动隐藏。
 */
export default function SpotlightGuide({ targetSelector, guideId, onDone }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const [rect, setRect] = useState(null)

  // 轮询等待目标元素渲染完成（跨 tab 挂载 / 数据加载）
  useEffect(() => {
    let raf
    let tries = 0
    const find = () => {
      const el = document.querySelector(targetSelector)
      if (el) {
        const r = el.getBoundingClientRect()
        // 忽略隐藏/未布局元素（display:none 的 tab、未渲染的 Select 返回 0 尺寸矩形），继续等待可见目标
        if (r.width > 0 && r.height > 0) {
          setRect(r)
          return
        }
      }
      // 目标 3s 内未出现则放弃（避免无限轮询）
      if (++tries > 180) return
      raf = requestAnimationFrame(find)
    }
    raf = requestAnimationFrame(find)
    return () => cancelAnimationFrame(raf)
  }, [targetSelector])

  // 滚动 / 缩放时跟随目标元素重新定位
  useEffect(() => {
    const update = () => {
      const el = document.querySelector(targetSelector)
      if (!el) {
        setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      setRect(r.width > 0 && r.height > 0 ? r : null)
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [targetSelector])

  if (!rect) return null

  // 气泡优先放目标下方；底部空间不足则放上方
  const bubbleBelow = rect.bottom + 12 + 120 < window.innerHeight
  const bubbleLeft = Math.max(4, Math.min(rect.left, window.innerWidth - 264))

  return (
    <>
      <div
        className={styles.hole}
        style={{ left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }}
      />
      <div
        className={styles.bubble}
        style={{
          left: bubbleLeft,
          top: bubbleBelow ? rect.bottom + 12 : undefined,
          bottom: bubbleBelow ? undefined : window.innerHeight - rect.top + 12,
        }}
      >
        <Text size="small" weight="semibold">{t('guide.title')}</Text>
        <Text size="small">{t(`guide.content.${guideId}`)}</Text>
        <div className={styles.actions}>
          <Button size="small" appearance="primary" onClick={onDone}>{t('guide.gotIt')}</Button>
        </div>
      </div>
    </>
  )
}
