import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Text, Button, Spinner, makeStyles, tokens } from '@fluentui/react-components'
import { ArrowClockwise24Regular } from '@fluentui/react-icons'
import { formatDbError, DB_CALL_TIMEOUT_S, DB_BACKEND_TIMEOUT_S } from '../../services/dbCall'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
    padding: '32px',
    textAlign: 'center',
  },
})

// 加载期间每秒跳动的已耗时计数（loading 时展示「已加载 Xs / 超时 Ys」）。
// 计时随 loading 起停：页面常驻挂载时若从挂载起一直计时，秒数会跨多次加载累加，
// 之后每次加载都会显示成两位/三位数；停止后保留最终秒数供错误提示展示。
function useElapsedSeconds(loading) {
  const [secs, setSecs] = useState(0)
  // 渲染期同步重置：loading 上升沿把秒数清零（React 推荐「随 props 变化调整 state」写法，
  // 不在 effect 内 setState 以免级联渲染）
  const [prevLoading, setPrevLoading] = useState(loading)
  if (loading !== prevLoading) {
    setPrevLoading(loading)
    if (loading) setSecs(0)
  }
  useEffect(() => {
    if (!loading) return
    const t0 = Date.now()
    const timer = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [loading])
  return secs
}

export function AsyncView({ loading, error, onRetry, loadingLabel, children }) {
  const { t } = useTranslation()
  const styles = useStyles()
  // 每次进入 loading 重新计时，loading→error 切换后保留本次等待的秒数
  const secs = useElapsedSeconds(loading)

  if (loading) {
    return (
      <div className={styles.root}>
        <Spinner size="small" label={loadingLabel || t('app.loading')} />
        <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>
          {t('workshop.loadElapsed', { secs, timeout: DB_CALL_TIMEOUT_S })}
        </Text>
      </div>
    )
  }

  if (error) {
    // 后端结构化错误（[DBERR:*]）转成面向用户的友好文案；
    // 非结构化错误（前端超时兜底等）原样展示
    const errorText = formatDbError(error, t)
    return (
      <div className={styles.root}>
        <Text weight="semibold">{t('workshop.loadFailed')}</Text>
        <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>{errorText}</Text>
        <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>
          {t('workshop.loadFailedElapsed', {
            secs,
            timeout: DB_CALL_TIMEOUT_S,
            queue: DB_BACKEND_TIMEOUT_S.queue,
            exec: DB_BACKEND_TIMEOUT_S.exec,
          })}
        </Text>
        {onRetry && (
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={onRetry}>
            {t('workshop.retry')}
          </Button>
        )}
      </div>
    )
  }

  return children
}
