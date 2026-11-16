import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import {
  CheckmarkCircle24Filled,
  Dismiss24Regular,
  ErrorCircle24Regular,
  ArrowDownload24Regular,
  ArrowSync24Regular,
  Delete24Regular,
  Folder24Regular,
  Info24Regular,
  Open24Regular,
} from '@fluentui/react-icons'
import {
  Button,
  ProgressBar,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
  Toast,
  ToastTitle,
  ToastBody,
  useToastController,
} from '@fluentui/react-components'
import { useDownloadCenter } from '../../contexts/useDownloadCenter'
import { useUserNav } from '../../contexts/useUserNav'
import { BOTTOM_TOASTER_ID } from './BottomToaster'
import { formatSpeed } from '../../utils/formatSpeed'
import { localizeError } from '../../utils/localizeError'

// 满不透明度保持时长：任务出现后 2s、鼠标移出后 2s
const SOLID_HOLD_MS = 2000
// 降低后的不透明度：仍可读，但不压页面内容
const DIM_OPACITY = 0.35
// 完成提示 / 失败提示的自动关闭延时
const DONE_CLOSE_MS = 3000
const FAILED_CLOSE_MS = 8000

const RUNNING = new Set(['pending', 'downloading', 'extracting', 'recording'])

const useStyles = makeStyles({
  container: {
    position: 'fixed',
    top: '40px',
    right: '16px',
    zIndex: 1200,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    width: '340px',
    maxWidth: 'calc(100vw - 32px)',
    // 整个面板一起变透明/变实：逐行动画会让多任务时的边缘互相错位
    willChange: 'opacity',
    pointerEvents: 'auto',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px 10px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  rowDone: {
    border: `1px solid ${tokens.colorPaletteGreenBorder1}`,
    backgroundColor: tokens.colorPaletteGreenBackground1,
  },
  rowFailed: {
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    backgroundColor: tokens.colorPaletteRedBackground1,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
  },
  kindTag: {
    flexShrink: 0,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: '4px',
    padding: '0 5px',
  },
  iconDone: {
    color: tokens.colorPaletteGreenForeground1,
    flexShrink: 0,
  },
  iconFailed: {
    color: tokens.colorPaletteRedForeground1,
    flexShrink: 0,
  },
  iconRunning: {
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-word',
  },
  // 下载完成后的快捷操作：2×2 等宽格子，四格等大对齐，宽度撑满整行
  actions: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '4px',
    marginTop: '2px',
  },
  actionButton: {
    width: '100%',
    minWidth: 0,
    justifyContent: 'flex-start',
  },
  actionLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})

/**
 * 弹簧插值：不直接用 CSS transition，因为 cubic-bezier 无法产生"过冲再回落"
 * 的手感（opacity 超界会被裁掉，视觉上就是普通缓动）。这里用 rAF 逐步积分
 * 阻尼弹簧，把结果写进 style.opacity；不经过 React state，逐帧更新不触发重渲染。
 */
function useSpringOpacity(target) {
  const ref = useRef(null)
  const stateRef = useRef({ value: target, velocity: 0, target })
  const rafRef = useRef(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const s = stateRef.current
    s.target = target

    let lastTs = 0
    let stopped = false
    // 欠阻尼（阻尼比 < 1）：k=170, c=14 时临界阻尼应为 2√k≈26，取 14 会
    // 产生一次明显的过冲回落，符合"弹簧感"且不至于晃太久
    const stiffness = 170
    const damping = 14
    const step = (ts) => {
      if (stopped) return
      const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 1 / 60
      lastTs = ts
      const accel = -stiffness * (s.value - s.target) - damping * s.velocity
      s.velocity += accel * dt
      s.value += s.velocity * dt
      // opacity 越界无意义（>1 与 1 相同、<0 不可见），撞边即吸收掉速度
      if (s.value > 1) {
        s.value = 1
        if (s.velocity > 0) s.velocity = 0
      } else if (s.value < 0) {
        s.value = 0
        if (s.velocity < 0) s.velocity = 0
      }
      el.style.opacity = String(s.value)
      if (Math.abs(s.value - s.target) < 0.0015 && Math.abs(s.velocity) < 0.015) {
        s.value = s.target
        s.velocity = 0
        el.style.opacity = String(s.target)
        rafRef.current = 0
        return
      }
      rafRef.current = requestAnimationFrame(step)
    }
    lastTs = 0
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(step)
    return () => {
      stopped = true
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [target])

  return ref
}

/**
 * 悬浮下载横条（右上角）。
 *
 * 存在意义：安装/仅下载都已改为 Rust 后台任务，用户离开详情页后任务照常跑完，
 * 但原来的进度只画在详情页按钮旁边——离开就看不见。这个条与页面解耦，任何
 * 页面都显示同一份进度。
 *
 * 交互约定（按需求）：
 * - 任务出现时全不透明，2s 后降到 0.35，避免长期遮挡浏览内容；
 * - hover 立即恢复全不透明；移出后再保持 2s 才降透明；
 * - 透明度变化走弹簧曲线；
 * - 完成后绿色强调 + 3s 自动关闭；失败红色，8s 后关闭（hover 期间暂停计时，
 *   让用户有时间看清报错）。
 */
export function DownloadStatusBar() {
  const { t } = useTranslation()
  const styles = useStyles()
  const { tasks, cancelTask } = useDownloadCenter()
  const { openMod } = useUserNav()
  const { dispatchToast } = useToastController(BOTTOM_TOASTER_ID)

  const [hovered, setHovered] = useState(false)
  const [dimmed, setDimmed] = useState(false)
  // 已关闭的浮条（kind:taskId）。只在本组件内隐藏，不从全局中心移除：
  // 详情页要靠终态任务继续显示"已下载 + 打开目录"，浮条关掉不该把它一起删掉。
  const [hidden, setHidden] = useState(() => new Set())
  // 已安排自动关闭的任务（kind:taskId → timeout id）
  const closeTimers = useRef(new Map())

  // hidden 是只增集合：任务被全局中心裁掉后无法从这里清理（渲染期改 state 会
  // 触发级联渲染），但它只在任务终结时写入，一次会话内的量级与任务数同级，
  // 可以接受；查找用 Set 保证过滤本身仍是 O(n)。
  const visibleTasks = useMemo(
    () => tasks.filter((task) => !hidden.has(`${task.kind}:${task.taskId}`)),
    [tasks, hidden],
  )

  // 触发"重新计 2s 全不透明"的输入：悬浮状态 + 运行中任务集合。
  // 用任务 id 集合而不是 tasks 数组：进度帧每 400ms 变一次，若依赖数组会让
  // 2s 计时被无限续命，永远降不下来；只有任务增删才值得重新计时。
  const taskIds = useMemo(
    () => tasks.filter((task) => RUNNING.has(task.status)).map((task) => `${task.kind}:${task.taskId}`).join(','),
    [tasks],
  )

  // 透明度时序的唯一调度点：悬浮中恒全不透明；否则从"最后活动"起 2s 后降透明。
  // 每次调度都先复位为不透明——直接调用两次 setState 会被 React 合并成一次渲染，
  // 不会闪。规则对"effect 内同步 setState"保守报错，此处语义明确故豁免。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDimmed(false)
    if (hovered) return undefined
    const timer = setTimeout(() => setDimmed(true), SOLID_HOLD_MS)
    return () => clearTimeout(timer)
  }, [hovered, taskIds])

  const handleEnter = useCallback(() => setHovered(true), [])
  const handleLeave = useCallback(() => setHovered(false), [])

  // 终态任务自动关闭：done 3s、failed 8s；hover 中不启动计时，
  // 移出后再重新计时（用户正在看的时候不要把它抽走）。
  // 只在本组件内隐藏（hidden），不从全局中心删——详情页还要靠终态任务
  // 显示"已下载 + 打开目录"，浮条关掉不该把那份信息一起抹掉。
  useEffect(() => {
    const timers = closeTimers.current
    const hide = (key) => {
      timers.delete(key)
      setHidden((prev) => {
        if (prev.has(key)) return prev
        const next = new Set(prev)
        next.add(key)
        return next
      })
    }
    for (const task of tasks) {
      const key = `${task.kind}:${task.taskId}`
      if (hidden.has(key)) continue
      const terminal = task.status === 'done' || task.status === 'failed'
      const hasTimer = timers.has(key)
      // 取消是用户自己的动作，立刻收起即可——再挂 3s/8s 提示只会碍眼
      if (task.status === 'cancelled') {
        if (hasTimer) {
          clearTimeout(timers.get(key))
          timers.delete(key)
        }
        timers.set(key, setTimeout(() => hide(key), 0))
        continue
      }
      if (!terminal || hovered) {
        if (hasTimer) {
          clearTimeout(timers.get(key))
          timers.delete(key)
        }
        continue
      }
      if (hasTimer) continue
      const delay = task.status === 'done' ? DONE_CLOSE_MS : FAILED_CLOSE_MS
      timers.set(key, setTimeout(() => hide(key), delay))
    }
    // 任务被全局中心裁掉（超出保留上限）时清掉遗留计时器
    for (const [key, timer] of timers) {
      if (!tasks.some((task) => `${task.kind}:${task.taskId}` === key)) {
        clearTimeout(timer)
        timers.delete(key)
      }
    }
  }, [tasks, hovered, hidden])

  // 卸载时清空所有计时器
  useEffect(() => {
    // 捕获 ref 当前值：cleanup 期间 .current 可能已被改动，直接读会漏清
    const timers = closeTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // 完成后的快捷操作。几个"打开"都可能失败（文件已被用户在资源管理器删掉、
  // 没有关联程序、详情已下架），一律用底部 toast 明确回报：浮条 3s 后就自动收起，
  // 静默失败等于什么都没发生。
  const toastOpenError = useCallback((title, e) => {
    dispatchToast(
      <Toast>
        <ToastTitle>{title}</ToastTitle>
        <ToastBody>{String(e?.message || e)}</ToastBody>
      </Toast>,
      { intent: 'error', timeout: 4000 },
    )
  }, [dispatchToast])

  const handleOpenFile = useCallback(async (task) => {
    if (!task?.path) return
    try {
      await invoke('open_file', { path: task.path })
    } catch (e) {
      toastOpenError(t('downloadBar.openFileFailed'), e)
    }
  }, [t, toastOpenError])

  const handleOpenFolder = useCallback(async (task) => {
    // 两类任务的落点不同：仅下载是一个 zip 文件（传文件路径 → 打开父目录并高亮它）；
    // 安装的产物已按 manifest 铺进游戏目录，只有 targetDir 可用（传目录 → 直接打开）。
    const folderPath = task?.kind === 'archive' ? task?.path : task?.targetDir
    if (!folderPath) return
    try {
      await invoke('open_folder', { path: folderPath })
    } catch (e) {
      toastOpenError(t('downloadBar.openDirFailed'), e)
    }
  }, [t, toastOpenError])

  // 完成后的快捷操作：两类任务共用同一套 2×2 网格，但可用动作不同。
  // - 仅下载：有独立的 zip 落盘，可「打开」；给「删除」是因为它就一个文件，删得干净。
  // - 安装：产物已按 manifest 铺进游戏目录，临时包解压后即删，没有单个文件可交给
  //   默认程序，故不给「打开」；也不给「删除」——文件散落在 BepInEx / CustomMisions*
  //   等多处，从浮条一键删既确定不了范围也删不干净，误以为清空反而更糟。
  const actionItems = useCallback((task) => {
    const dirPath = task.kind === 'archive' ? task.path : task.targetDir
    const items = [
      {
        key: 'detail',
        icon: <Info24Regular />,
        label: t('downloadBar.openDetail'),
        disabled: !task.modKey,
        onClick: () => openMod(task.modKey),
      },
    ]
    if (task.kind === 'archive') {
      items.push({
        key: 'openFile',
        icon: <Open24Regular />,
        label: t('downloadBar.openFile'),
        disabled: !task.path,
        onClick: () => handleOpenFile(task),
      })
    }
    items.push({
      key: 'openDir',
      icon: <Folder24Regular />,
      label: t('downloadBar.openDir'),
      disabled: !dirPath,
      onClick: () => handleOpenFolder(task),
    })
    if (task.kind === 'archive') {
      items.push({
        key: 'remove',
        icon: <Delete24Regular />,
        label: t('downloadBar.removeFile'),
        onClick: () => cancelTask(task),
      })
    }
    return items
  }, [t, openMod, handleOpenFile, handleOpenFolder, cancelTask])

  const opacityTarget = hovered || !dimmed ? 1 : DIM_OPACITY
  const panelRef = useSpringOpacity(opacityTarget)

  if (visibleTasks.length === 0) return null

  return (
    <div
      ref={panelRef}
      className={styles.container}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      role="status"
      aria-live="polite"
    >
      {visibleTasks.map((task) => {
        const running = RUNNING.has(task.status)
        const done = task.status === 'done'
        const failed = task.status === 'failed'
        const name = task.displayName || task.modKey || `#${task.taskId}`
        const kindLabel = task.kind === 'archive' ? t('downloadBar.archive') : t('downloadBar.install')
        let statusText = ''
        if (running) {
          // 安装有阶段（pending/downloading/extracting/recording），仅下载只有 downloading
          statusText = t(`workshop.stage.${task.stage || 'downloading'}`, { defaultValue: '' })
        } else if (done) {
          statusText = task.kind === 'archive' ? t('downloadBar.archiveDone') : t('downloadBar.installDone')
        } else if (failed) {
          statusText = t('downloadBar.failed')
        } else if (task.status === 'cancelled') {
          statusText = t('downloadBar.cancelled')
        }
        const detail = running && task.status !== 'extracting' && task.status !== 'recording'
          ? [
            `${task.percent ?? 0}%`,
            task.speed > 0 ? formatSpeed(task.speed) : '',
          ].filter(Boolean).join(' · ')
          : ''

        return (
          <div
            key={`${task.kind}:${task.taskId}`}
            className={mergeClasses(
              styles.row,
              done && styles.rowDone,
              failed && styles.rowFailed,
            )}
          >
            <div className={styles.head}>
              {done ? (
                <CheckmarkCircle24Filled className={styles.iconDone} fontSize={16} />
              ) : failed ? (
                <ErrorCircle24Regular className={styles.iconFailed} fontSize={16} />
              ) : task.kind === 'archive' ? (
                <ArrowDownload24Regular className={styles.iconRunning} fontSize={16} />
              ) : (
                <ArrowSync24Regular className={styles.iconRunning} fontSize={16} />
              )}
              <Text size="small" weight="semibold" className={styles.title} title={name}>
                {name}
              </Text>
              <span className={styles.kindTag}>{kindLabel}</span>
              {/* 两种任务都可取消：安装只中止下载，仅下载还会删掉已落盘的缓存文件 */}
              {running && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Dismiss24Regular />}
                  title={t('downloadBar.cancel')}
                  onClick={() => cancelTask(task)}
                />
              )}
            </div>
            {running && (
              <ProgressBar
                value={(task.percent ?? 0) / 100}
                thickness="thin"
                // 解压/写记录阶段没有字节进度，进度条已满，用品牌色即可
                color="brand"
              />
            )}
            {done && <ProgressBar value={1} thickness="thin" color="success" />}
            {failed && <ProgressBar value={0} thickness="thin" color="error" />}
            <div className={styles.head}>
              <Text className={styles.meta} style={{ flex: 1 }}>
                {statusText}
                {detail ? ` · ${detail}` : ''}
              </Text>
            </div>
            {/* 完成任务的操作区：两类任务共用 2×2 网格（每行两格，只有两项时
                正好一行两格，不会留空格子）。仅下载是「详情页/打开/所在文件夹/删除」，
                安装是「详情页/所在文件夹」——理由见 actionItems 的注释 */}
            {done && (
              <div className={styles.actions}>
                {actionItems(task).map((item) => (
                  <Button
                    key={item.key}
                    size="small"
                    appearance="subtle"
                    className={styles.actionButton}
                    icon={item.icon}
                    title={item.label}
                    disabled={item.disabled}
                    onClick={item.onClick}
                  >
                    <span className={styles.actionLabel}>{item.label}</span>
                  </Button>
                ))}
              </div>
            )}
            {failed && task.error && (
              <Text className={styles.error}>{localizeError(t, task.error)}</Text>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default DownloadStatusBar
