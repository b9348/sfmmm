import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getDb } from '../../services/dbHelper'
import { useUserNav } from '../../contexts/useUserNav'
import { LANG_LABELS } from '../../i18n/languages'
import {
  Card, Text, Button, Badge, ProgressBar, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components'
import {
  ArrowSync24Regular, Dismiss24Regular, Folder24Regular,
  ArrowDownload24Regular, ErrorCircle24Regular, Cloud24Regular,
} from '@fluentui/react-icons'
import { invoke as openFolder } from '@tauri-apps/api/core'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    padding: '16px',
    gap: '12px',
    overflow: 'auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    flexShrink: 0,
  },
  title: {
    fontWeight: '600',
    fontSize: tokens.fontSizeBase500,
    margin: 0,
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minHeight: 0,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: '8px',
    padding: '12px',
    alignItems: 'center',
  },
  rowMain: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
  },
  rowTop: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  rowMeta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  // 与工坊卡片 ModCard.description 一致：两行截断，淡色小字
  description: {
    display: '-webkit-box',
    WebkitLineClamp: '2',
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
  },
  rowActions: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
  },
  errorText: {
    color: tokens.colorPaletteRedForeground2,
    fontSize: tokens.fontSizeSmall,
    marginTop: '4px',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '48px 16px',
    color: tokens.colorNeutralForeground2,
  },
})

function statusBadge(t, status) {
  const map = {
    pending:      { appearance: 'ghost',   color: 'neutral' },
    downloading:  { appearance: 'inform',  color: 'brand'   },
    extracting:   { appearance: 'inform',  color: 'brand'   },
    recording:    { appearance: 'inform',  color: 'brand'   },
    done:         { appearance: 'filled',  color: 'success' },
    uninstalled:  { appearance: 'ghost',   color: 'severe'  },
    failed:       { appearance: 'filled',  color: 'danger'  },
    cancelled:    { appearance: 'ghost',   color: 'severe'  },
  }
  const conf = map[status] || map.pending
  return (
    <Badge appearance={conf.appearance} color={conf.color}>
      {t(`subscriptions.status.${status}`, status)}
    </Badge>
  )
}

function isRunning(status) {
  return ['pending', 'downloading', 'extracting', 'recording'].includes(status)
}

export function SubscriptionRecords() {
  const { t } = useTranslation()
  const styles = useStyles()
  const { openMod } = useUserNav()
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)

  // 前往创意工坊查看该 mod 详情页（按 mod_key 跳转），与 MissionFolder.handleViewDetail 一致
  const handleViewDetail = useCallback((modKey) => {
    if (!modKey) return
    openMod(modKey)
  }, [openMod])

  const refresh = useCallback(async () => {
    try {
      const rows = await invoke('db_list_subscription_tasks', { statusFilter: null, limit: 200 })
      // translations 后端按 JSON 字符串原样存，前端解析为对象供渲染取对应语言文件名；
      // 解析失败兜底为空对象，不阻断整页
      rows.forEach(r => {
        r.translations = (() => {
          try { return JSON.parse(r.translations || '{}') || {} } catch { return {} }
        })()
      })
      // done 行校验 installed_workshop_mods 是否还在——不在改显已退订（虚拟态，不回写 SQLite）
      // 与 db_subscribe_mod 的去重校验逻辑呼应：done 但安装记录不在 = 已被退订失效
      const doneRows = rows.filter(r => r.status === 'done')
      let uninstalledKeys = new Set()
      if (doneRows.length > 0) {
        try {
          const db = await getDb()
          const keys = doneRows.map(r => r.modKey)
          const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ')
          const existing = await db.select(
            `SELECT DISTINCT mod_key FROM installed_workshop_mods WHERE mod_key IN (${placeholders})`,
            keys
          )
          const stillInstalled = new Set(existing.map(r => r.mod_key))
          uninstalledKeys = new Set(keys.filter(k => !stillInstalled.has(k)))
        } catch (e) {
          console.warn('[SubscriptionRecords] 校验安装记录失败:', e)
        }
      }
      if (uninstalledKeys.size > 0) {
        rows.forEach(r => {
          if (r.status === 'done' && uninstalledKeys.has(r.modKey)) {
            r.status = 'uninstalled'
          }
        })
      }
      setTasks(rows)
    } catch (e) {
      console.warn('[SubscriptionRecords] 查询任务失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    // 全局进度事件：后台任务 emit 广播，此页刷新对应行进度
    // listen() 返回 Promise<UnlistenFn>，用 async/await 拿到真实 unlisten fn 存 ref，cleanup 时调
    let unlistenFn = null
    listen('subscription-progress', (ev) => {
      const payload = ev.payload || {}
      const tid = payload.taskId
      setTasks(prev => {
        const idx = prev.findIndex(t => t.id === tid)
        // 若 payload 对应任务不在当前列表（用户从未进过本页或新建任务后表里还没拉到），
        // 先触发一次 refresh 把表里最新任务拉回来，再由后续 emit 增量更新
        if (idx === -1) {
          refresh()
          return prev
        }
        const next = [...prev]
        next[idx] = {
          ...next[idx],
          status: payload.status,
          percent: payload.percent,
          stage: payload.stage,
          error: payload.error || next[idx].error,
        }
        return next
      })
    })
      .then(fn => { unlistenFn = fn })
      .catch(() => {})
    return () => { if (unlistenFn) unlistenFn() }
  }, [refresh])

  const cancelTask = async (taskId) => {
    try {
      await invoke('db_cancel_subscription', { taskId })
      refresh()
    } catch (e) {
      console.warn('[SubscriptionRecords] 取消失败:', e)
    }
  }

  const openDir = async (dir) => {
    if (!dir) return
    try {
      await openFolder('open_folder', { path: dir })
    } catch (e) {
      console.warn('[SubscriptionRecords] 打开目录失败:', e)
    }
  }

  const runningCount = tasks.filter(t => isRunning(t.status)).length
  const doneCount = tasks.filter(t => t.status === 'done').length
  const uninstalledCount = tasks.filter(t => t.status === 'uninstalled').length
  const failedCount = tasks.filter(t => t.status === 'failed').length

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{t('subscriptions.title')}</h2>
          <div className={styles.meta}>
            {t('subscriptions.summary', { running: runningCount, done: doneCount, failed: failedCount })}
          </div>
        </div>
        <Button
          icon={<ArrowSync24Regular />}
          appearance="subtle"
          onClick={refresh}
          disabled={loading}
        >
          {t('subscriptions.refresh')}
        </Button>
      </div>

      {tasks.length === 0 ? (
        <div className={styles.empty}>
          <ArrowDownload24Regular style={{ fontSize: '32px' }} />
          <Text>{t('subscriptions.empty')}</Text>
        </div>
      ) : (
        <div className={styles.list}>
          {tasks.map(task => {
            // 对应语言文件名优先（与工坊卡片 ModCard/MyMods 一致）：translations[lang].name → displayName → modKey 兜底
            const langName = task.translations?.[task.langCode]?.name || task.displayName || task.modKey || `#${task.id}`
            return (
            <Card key={task.id} className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTop}>
                  {statusBadge(t, task.status)}
                  <Text weight="semibold">{langName}</Text>
                  {task.version && <Badge appearance="outline" size="small">v{task.version}</Badge>}
                  {task.langCode && <Badge appearance="outline" size="small">{LANG_LABELS[task.langCode] || task.langCode}</Badge>}
                  <Badge appearance="outline" size="small">{task.category ? t(`workshop.category_${task.category}`, task.category) : t('workshop.uncategorized')}</Badge>
                  <Text className={styles.rowMeta}>{task.modKey}</Text>
                </div>
                {task.description && (
                  <Text className={styles.description}>{task.description}</Text>
                )}
                {isRunning(task.status) && (
                  <ProgressBar value={task.percent / 100} />
                )}
                {task.status === 'done' && task.targetDir && (
                  <Text className={styles.rowMeta}>{task.targetDir}</Text>
                )}
                {task.status === 'failed' && task.error && (
                  <div className={styles.errorText}>
                    <ErrorCircle24Regular style={{ fontSize: '12px', verticalAlign: 'middle' }} /> {task.error}
                  </div>
                )}
                {task.status === 'cancelled' && (
                  <Text className={styles.rowMeta}>{t('subscriptions.cancelledNote')}</Text>
                )}
              </div>
              <div className={styles.rowActions}>
                <Tooltip content={t('mods.menuViewDetail')} relationship="label">
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Cloud24Regular />}
                    onClick={() => handleViewDetail(task.modKey)}
                    disabled={!task.modKey}
                  />
                </Tooltip>
                {isRunning(task.status) && (
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Dismiss24Regular />}
                    onClick={() => cancelTask(task.id)}
                  >
                    {t('subscriptions.cancel')}
                  </Button>
                )}
                {task.status === 'done' && task.targetDir && (
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Folder24Regular />}
                    onClick={() => openDir(task.targetDir)}
                  >
                    {t('subscriptions.openDir')}
                  </Button>
                )}
              </div>
            </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default SubscriptionRecords
