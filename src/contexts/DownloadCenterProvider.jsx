import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import DownloadCenterContext from './DownloadCenterContext'

/** 运行中状态集合（与 Rust 侧 reset_stale_running_tasks 的口径一致） */
const RUNNING_STATUSES = new Set(['pending', 'downloading', 'extracting', 'recording'])

/** 终态任务在内存里最多各留几条：仅用于行内"已完成/失败"回显，无限累积没有意义 */
const MAX_TERMINAL_TASKS = 20

const taskKey = (kind, taskId) => `${kind}:${taskId}`

/**
 * 把两个后端事件源与一次恢复查询归一成同一种任务形状。
 * 详情页 / 订阅记录页 / 悬浮条都消费这个形状，避免每个页面各写一套字段映射。
 *
 * 注意 `taskId` 的两种来源不同名：事件 payload 是 taskId（Rust 结构的 camelCase），
 * 恢复查询是 db_list_subscription_tasks 的 SQL 行，主键叫 `id`。漏掉 `?? task.id`
 * 会让恢复出来的任务 taskId 全是 undefined，多条互相覆盖成一条，取消也发不出去。
 */
function normalizeInstall(task) {
  return {
    kind: 'install',
    taskId: task.taskId ?? task.id,
    modKey: task.modKey || '',
    langCode: task.langCode || '',
    displayName: task.displayName || '',
    percent: task.percent ?? 0,
    speed: task.speed ?? 0,
    stage: task.stage || '',
    status: task.status || '',
    error: task.error || '',
    path: '',
    targetDir: task.targetDir || '',
  }
}

function normalizeArchive(task) {
  return {
    kind: 'archive',
    taskId: task.taskId,
    modKey: task.modKey || '',
    langCode: task.langCode || '',
    displayName: task.displayName || '',
    percent: task.percent ?? 0,
    speed: task.speed ?? 0,
    // 仅下载没有阶段概念：下载完成即结束，用 downloading 兜住 UI 取文案
    stage: task.status === 'downloading' ? 'downloading' : '',
    status: task.status || '',
    error: task.error || '',
    path: task.path || '',
    targetDir: '',
  }
}

/**
 * 全局下载中心：App 级单一数据源，维护本进程内所有进行中的安装/仅下载任务。
 *
 * 为什么必须放在 App 级而不是详情页：
 * 进度状态原先由 ModDetailPage 自己持有（`lang → taskId` 映射 + listen 回调），
 * 组件一卸载，映射和进度就全丢了；用户再回到详情页只能看到空白按钮，直到
 * 后端下一帧事件到达才重新出现——而进行中的任务不会再"新建"，`lang → taskId`
 * 无从得知，进度就永久恢复不了。把数据源上提后，任何页面离开/回来都只是换了个
 * 消费者，任务本身一直在。
 *
 * 恢复有两条路，缺一不可：
 * 1. 安装任务：`db_list_subscription_tasks` 读 SQLite（后端顺带把重启后无人
 *    接管的残留 running 行判为中断失败），拿到 taskId/modKey/langCode；
 * 2. 仅下载任务：`db_list_archive_tasks` 读后端内存快照（不落库，见 archive.rs）。
 */
export function DownloadCenterProvider({ children }) {
  const [tasks, setTasks] = useState([])

  // 实时事件写入：同 key 覆盖（保留旧条目里事件没带的字段，如 archive 的 path）
  const upsert = useCallback((next) => {
    setTasks((prev) => {
      const key = taskKey(next.kind, next.taskId)
      const idx = prev.findIndex((t) => taskKey(t.kind, t.taskId) === key)
      let merged
      if (idx === -1) {
        merged = [...prev, next]
      } else {
        merged = [...prev]
        merged[idx] = { ...prev[idx], ...next }
      }
      // 终态任务只留最近 MAX_TERMINAL_TASKS*2 条（两类共用上限）：
      // 该列表只用于"完成/失败"回显，无限累积没有意义
      const terminal = merged.filter((t) => !RUNNING_STATUSES.has(t.status))
      if (terminal.length > MAX_TERMINAL_TASKS * 2) {
        const keep = new Set(
          terminal
            .slice()
            .sort((a, b) => b.taskId - a.taskId)
            .slice(0, MAX_TERMINAL_TASKS * 2)
            .map((t) => taskKey(t.kind, t.taskId)),
        )
        return merged.filter((t) => RUNNING_STATUSES.has(t.status) || keep.has(taskKey(t.kind, t.taskId)))
      }
      return merged
    })
  }, [])

  // 恢复写入：只补缺、不覆盖。恢复查询读的是 SQLite（写库节流 1s）与内存快照，
  // 可能比已经到达的实时事件旧；若直接覆盖会出现进度条倒退一帧再跳回来。
  const insertMissing = useCallback((incoming) => {
    setTasks((prev) => {
      const existing = new Set(prev.map((t) => taskKey(t.kind, t.taskId)))
      const fresh = incoming.filter((t) => !existing.has(taskKey(t.kind, t.taskId)))
      return fresh.length > 0 ? [...prev, ...fresh] : prev
    })
  }, [])

  // 挂载即恢复：把后端还在跑的任务拉回本地状态。
  // 两个查询都失败不阻断 UI（离线开发模式下 MySQL 不可用也不影响本地任务）。
  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      try {
        const rows = await invoke('db_list_subscription_tasks', { statusFilter: null, limit: 200 })
        if (cancelled) return
        insertMissing(
          (rows || [])
            .filter((r) => RUNNING_STATUSES.has(r.status))
            .map(normalizeInstall),
        )
      } catch (e) {
        console.warn('[DownloadCenter] 恢复安装任务失败:', e)
      }
      try {
        const rows = await invoke('db_list_archive_tasks')
        if (cancelled) return
        insertMissing((rows || []).map(normalizeArchive))
      } catch (e) {
        // 旧版后端没有该命令时（热更新场景）静默跳过
        console.warn('[DownloadCenter] 恢复仅下载任务失败:', e)
      }
    }
    restore()
    return () => { cancelled = true }
  }, [insertMissing])

  // 全局事件监听：安装链路与仅下载链路是两套独立事件源，各接一支
  useEffect(() => {
    let cancelled = false
    const unlisteners = []
    const bind = (event, mapper) => {
      listen(event, (ev) => {
        const payload = ev.payload || {}
        if (payload.taskId == null) return
        upsert(mapper(payload))
      })
        .then((fn) => {
          // 卸载竞态：Promise 落定时组件可能已销毁，立即注销避免监听器泄漏
          if (cancelled) fn()
          else unlisteners.push(fn)
        })
        .catch(() => {})
    }
    bind('subscription-progress', normalizeInstall)
    bind('archive-download-progress', normalizeArchive)
    return () => {
      cancelled = true
      unlisteners.forEach((fn) => fn())
    }
  }, [upsert])

  // 取消任务：两条链路各有自己的命令，语义也不同。
  // - install：中止下载 + 删临时包，不动游戏目录里已解压的文件
  //   （那部分归"退订"管，取消安装不该顺手删已装内容）
  // - archive：用户点取消 = 不要这个文件了，连已落盘的 zip 一起删
  //   （"移除下载的缓存"），后端 db_cancel_archive_download 负责
  // 从中心移除一条任务。用于"已下载的文件被删掉"——此时那条 done 记录
  // 描述的状态已不成立（文件不在），必须让它从详情页与浮条上一起消失，
  // 否则会一直显示"已下载 + 打开目录"，点开是空目录。
  const removeTask = useCallback((kind, taskId) => {
    setTasks((prev) => prev.filter((t) => taskKey(t.kind, t.taskId) !== taskKey(kind, taskId)))
  }, [])

  const cancelTask = useCallback(async (task) => {
    if (!task?.taskId) return
    try {
      if (task.kind === 'archive') {
        // path 用于"任务已结束、快照已摘除"的删缓存场景（完成后再点删除文件）：
        // 后端只接受下载目录内的路径，其它一律忽略
        await invoke('db_cancel_archive_download', { task_id: task.taskId, path: task.path || '' })
        // 已落盘的文件被删了，这条 done 记录不再成立，连同状态一起移除
        if (task.status === 'done') removeTask('archive', task.taskId)
      } else {
        await invoke('db_cancel_subscription', { task_id: task.taskId })
      }
    } catch (e) {
      console.warn('[DownloadCenter] 取消失败:', e)
    }
  }, [removeTask])

  // 详情页需要"某个 mod 下按语言索引的任务"：同一语言可能有历史终态 + 新任务，
  // 取 taskId 最大的一条，避免旧任务盖住新任务
  const latestByLang = useCallback((modKey, kind) => {
    const out = {}
    for (const t of tasks) {
      if (t.modKey !== modKey || t.kind !== kind) continue
      const prev = out[t.langCode]
      if (!prev || t.taskId > prev.taskId) out[t.langCode] = t
    }
    return out
  }, [tasks])

  const value = useMemo(() => ({
    tasks,
    cancelTask,
    // 安装：只暴露运行中的任务。按钮的 disabled 直接依赖"有没有进度"，
    // 若把终态也放进来，按钮在完成/失败后会永久置灰，用户无法重装。
    installByLang: (modKey) => {
      const out = latestByLang(modKey, 'install')
      for (const lang of Object.keys(out)) {
        if (!RUNNING_STATUSES.has(out[lang].status)) delete out[lang]
      }
      return out
    },
    // 仅下载：终态也要保留——文件行要用它显示"已下载 + 打开目录"，
    // 按钮的 disabled 由 ModFileRow 自己按 status 判断（只在 downloading 时禁用）
    archiveByLang: (modKey) => latestByLang(modKey, 'archive'),
  }), [tasks, cancelTask, latestByLang])

  return (
    <DownloadCenterContext.Provider value={value}>
      {children}
    </DownloadCenterContext.Provider>
  )
}
