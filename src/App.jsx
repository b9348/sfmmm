import { useState, useEffect, useReducer, useRef, useCallback, lazy, Suspense } from 'react'
import { listen } from '@tauri-apps/api/event'
import { FluentProvider, webLightTheme, webDarkTheme, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger, Button, Text, Toaster, Spinner } from '@fluentui/react-components'
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
// 常驻骨架组件走具体文件路径，不经 `./components` 桶文件：桶文件 re-export 了
// components 目录下全部组件，会把只被页面用到的弹窗/表单也拉进首屏模块图。
import { TabNavigation } from './components/layout/TabNavigation'
import { WelcomeScreen } from './components/WelcomeScreen'
import { TitleBar } from './components/TitleBar'
import SpotlightGuide from './components/common/SpotlightGuide'
import { BottomToaster } from './components/common/BottomToaster'

// 页面级模块按需加载：首屏只装载侧栏、标题栏与 Provider 骨架，切到哪个 tab 才去
// 取哪个页面的代码。原先经 `./modules` 桶文件全量静态导入，tiptap / jszip / marked
// 等重库都落在首屏图上，dev 下需逐个转换，是白屏时间的主要来源。
const SaveManagement = lazy(() => import('./modules/saves').then((m) => ({ default: m.SaveManagement })))
const ImportExport = lazy(() => import('./modules/importExport').then((m) => ({ default: m.ImportExport })))
const GameSettings = lazy(() => import('./modules/settings').then((m) => ({ default: m.GameSettings })))
const Workshop = lazy(() => import('./modules/workshop').then((m) => ({ default: m.Workshop })))
const LocalMods = lazy(() => import('./modules/localmods').then((m) => ({ default: m.LocalMods })))
const NotifyPage = lazy(() => import('./modules/notify').then((m) => ({ default: m.NotifyPage })))
import { AuthProvider } from './contexts/AuthContext.jsx'
import { LegacyAccountProvider } from './contexts/LegacyAccountContext.jsx'
import { GameMasterProvider } from './contexts/GameMasterProvider.jsx'
import { UserNavProvider } from './contexts/UserNavProvider.jsx'
import { V2PrereqNoticeProvider } from './contexts/V2PrereqNoticeProvider.jsx'
import { OverwriteConfirmProvider } from './contexts/OverwriteConfirmProvider.jsx'
import { NotificationProvider } from './contexts/NotificationContext'
import { AnnouncementProvider } from './contexts/AnnouncementContext.jsx'
import { DownloadCenterProvider } from './contexts/DownloadCenterProvider.jsx'
import { DownloadStatusBar } from './components/common/DownloadStatusBar'
import { NarrowMenuButton } from './components/common/NarrowMenuButton'
import { NarrowNavProvider } from './contexts/NarrowNavContext.jsx'
import { usePersistUI } from './hooks/usePersistUI'
import { useMediaQuery } from './hooks/useMediaQuery'
import { usePlatform } from './hooks/usePlatform'
import { getConfigs, setConfig } from './services/dbHelper'
import { checkVersion, applyUpdate, prepareUpdate, getUpdateStatus, armPendingUpdate } from './services/updateApi'
import { isInBackoff, canAutoApply } from './services/updatePolicy'
import { uninstallMod } from './services/installMod'
import { initDbTimeouts } from './services/dbCall'
import { initCdnMode } from './services/cdnApi'
import { installExternalLinkInterceptor } from './utils/externalLinks'
import { noteView, setViewRestorer, tabOfHash } from './utils/navHistory'
import { useNavBrowsing } from './hooks/useNavBrowsing'
import { useTranslation } from 'react-i18next'
import APP_VERSION from './version.js'
import i18n from './i18n'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
  },
  // 手机端 WebView 是边到边绘制：状态栏区域的触摸会被系统下拉通知栏截走，
  // 顶部 tabs / 汉堡会点不到。至少留出一个状态栏高度；有刘海/挖孔时用系统安全区。
  mobileRoot: {
    paddingTop: 'max(env(safe-area-inset-top, 0px), 24px)',
    // 必须在运行时读 FluentProvider 注入的主题变量：makeStyles 里的 tokens
    // 是构建期亮色常量，深色模式下会把状态栏安全区刷成浅灰。
    backgroundColor: 'var(--colorNeutralBackground2)',
  },
  appShell: {
    display: 'flex',
    flexDirection: 'row',
    flex: 1,
    backgroundColor: tokens.colorNeutralBackground2,
    overflow: 'hidden',
  },
  tabContent: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '8px',
  },
  // 窄屏下「本页没有自定义页签、汉堡无处可并」的页面（存档/导入导出/设置）用的顶栏：
  // 汉堡与页面标题同行，只有这些页面会多出这一行，有页签的页面把汉堡并进页签行里
  narrowAppBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    padding: '4px 8px 0',
  },
  narrowAppBarTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // 懒加载页面在 tab 内容区里的占位：撑满内容区，不引入滚动条
  pageLoading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    minHeight: '200px',
  },
})

// 漫游引导：每个引导有独立 id；已读记录用 SQLite config 按 id 存版本号，互不影响、便于后续扩展其他引导
const WORKSHOP_SORT_GUIDE = 'workshop-sort'
const GUIDE_SEEN_KEY = 'guide_seen_versions'

const initialState = { isFirstRun: null, config: null, sawWelcome: false }

// 顶层标签集合：导航历史恢复时只接受这些值，避免把脏数据写回 selectedTab
const NAV_TABS = new Set(['mods', 'saves', 'import-export', 'workshop', 'localmods', 'notify', 'settings'])

// 手机端可用标签：纯社区模式（浏览/讨论/通知/设置），不含任何本地文件操作页
const MOBILE_TABS = ['workshop', 'notify', 'settings']

// 窄屏顶栏标题：只有「本页没有页签行、汉堡无处可并」的页面才由 App 统一出一行，
// 有页签的页面（localmods / workshop / notify）自己把汉堡放进页签行，不再额外占一行
const NARROW_APP_BAR_TITLE = { saves: 'nav.saves', 'import-export': 'nav.importExport', settings: 'nav.settings' }
const NARROW_OWN_TABS = new Set(['localmods', 'workshop', 'notify'])

function appReducer(state, action) {
  switch (action.type) {
    case 'INIT_COMPLETE':
      // 冷启动直通主界面：本次启动没走过欢迎屏，仍需弹漫游引导
      return { isFirstRun: false, config: action.config, sawWelcome: false }
    case 'FIRST_RUN':
      return { isFirstRun: true, config: null, sawWelcome: false }
    case 'WELCOME_COMPLETE':
      // 刚在欢迎屏配好游戏目录：全新安装，不弹引导
      return { isFirstRun: false, config: action.config, sawWelcome: true }
    case 'UPDATE_CONFIG':
      return { ...state, config: { ...state.config, ...action.config } }
    default:
      return state
  }
}

function App() {
  const styles = useStyles()
  // APK 分支：手机端是纯社区模式，只保留 社区/通知/设置 三个标签。
  // 桌面能力（本地模组、存档、导入导出、下载安装、订阅记录）在移动端既不渲染
  // 也不发起云查询，相关入口统一由 isMobile 关掉。
  const { isMobile } = usePlatform()
  const [selectedTab, setSelectedTab] = useState('mods')
  const [navTarget, setNavTarget] = useState(null)
  const { sidebarCollapsed, toggleSidebar } = usePersistUI()
  // 窄屏（≤768px）：侧栏改成 LeftMinimal 抽屉，开抽屉的按钮由页面自己渲染
  // （<NarrowMenuButton /> 并进页签行，或由 App 出一行「☰ + 页面标题」），
  // 不依赖自绘标题栏——将来 APK 形态去掉标题栏后这条路径照样成立
  const isNarrow = useMediaQuery('(max-width: 768px)')
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 抽屉开合状态只活在小屏这一段，不写回 sidebar_collapsed（不影响宽屏的折叠偏好）；
  // 回到宽屏时复位，避免下次变窄时抽屉一进来就是展开态
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isNarrow && drawerOpen) setDrawerOpen(false)
  }, [isNarrow, drawerOpen])
  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const [state, dispatch] = useReducer(appReducer, initialState)
  const [updateInfo, setUpdateInfo] = useState(null)
  // 启动自动应用进行中的内存标志：串行化启动编排（检测/自动下载）与自动应用流程，
  // 避免二者对 pending_update 的 TOCTOU 竞态（自动应用已接管时不再写回标志/发起下载）
  const applyingRef = useRef(false)
  // 启动编排发起的自动下载任务 id：全局 update-progress 监听据此区分自动/手动任务
  // （手动下载失败不武装自动更新退避，手动下载完成也不强制安排下次启动应用）
  const autoTaskIdRef = useRef(null)
  // 最近一次检测到的最新版本：全局监听在 ready 时复核安装包版本仍为最新才提升待应用
  const latestVersionRef = useRef('')
  // 主题模式：'light' | 'dark' | 'system'。默认跟随系统，启动后读取持久化配置覆盖。
  // 通过 class 名驱动 WinNavigationView 的自定义 CSS 变量，Fluent 组件则切换 webDarkTheme。
  const [themeMode, setThemeMode] = useState('system')
  // 系统是否处于深色模式（仅 themeMode === 'system' 时生效）
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  // 实际生效的主题：跟随系统模式下由系统偏好决定
  const resolvedTheme = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode

  // 把主题类挂到 <html>：WinNavigationView 的自定义 CSS 变量依赖祖先上的
  // app-theme-dark。只挂在 FluentProvider 上时，手机抽屉这类被绝对定位/重排的
  // 子树在部分 WebView 里拿不到主题变量，会出现深色模式导航图标和文字仍是深色。
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('app-theme-dark', resolvedTheme === 'dark')
    root.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  // 监听系统主题变化，供"跟随系统"模式使用
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const onChange = (e) => setSystemDark(e.matches)
    onChange(mq)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  // 选择主题模式（亮色/深色/跟随系统）并持久化到 config 表
  const handleSelectTheme = async (mode) => {
    if (!['light', 'dark', 'system'].includes(mode) || mode === themeMode) return
    const prev = themeMode
    setThemeMode(mode)
    try {
      await setConfig('theme_mode', mode)
    } catch (e) {
      console.error('Failed to persist theme mode:', e)
      // 保存失败时回滚 UI，避免界面声称已切换但重启后丢失
      setThemeMode(prev)
      alert(t('nav.themePersistFailed'))
    }
  }

  // 全局拦截外部链接点击：改用系统默认浏览器打开，避免 WebView 原地导航
  useEffect(() => {
    return installExternalLinkInterceptor()
  }, [])

  // 启动时先发起取后端超时参数（`db_timeouts` 纯内存返回，不建连接），
  // dbCall 之后 await 同一个 Promise，不会重复 invoke。失败由 dbCall 侧原样上抛，
  // 这里只避免未处理的 Promise rejection，不做任何兜底替换。
  useEffect(() => {
    initDbTimeouts().catch(() => {})
  }, [])

  // 启动时初始化资源线路：读用户持久化选择应用到 Rust，并拉取测速后的生效状态。
  // 之后前端 <img> 展示域名改写（cdnUrl）才有依据；失败静默保持老域名。
  useEffect(() => {
    initCdnMode().catch(() => {})
  }, [])

  // 启动时静默自动更新编排（单一入口，串行执行避免与全局监听竞态）：
  // 1) 检测更新；2) 已有待应用更新时，仅当安装包就绪、文件在盘且版本仍为当前
  // 最新版才自动应用（防陈旧提升：旧版残留不被静默安装）；3) 否则按需用默认源
  // 静默下载，就绪后由全局监听写入 pending_update，下次启动自动应用
  useEffect(() => {
    let cancelled = false
    const startup = async () => {
      // 手机端没有 PC 安装包自更新管线（APK 更新走发布页/应用商店），整段跳过：
      // 既不发检测更新请求，也不碰 pending_update / update_tasks 这些桌面状态
      if (isMobile) return
      try {
        const info = await checkVersion(APP_VERSION)
        if (cancelled) return
        setUpdateInfo(info)
        latestVersionRef.current = info.latestVersion || ''

        const cfg = await getConfigs(['initialized', 'pending_update', 'auto_update_fail_at'])
        if (cancelled) return
        // 首次运行时不自动下载/自动应用，避免在欢迎屏/设置流程中退出
        if (cfg.initialized !== 'true') return

        // 失败退避：自动下载/自动应用最近失败过（24h 内）则不再自动发起，
        // 避免更新源不可达/安装反复失败时每次启动都重试；用户手动"检测更新"
        // 会重置该时间戳（见 GameSettings.handleCheckUpdate）。同时约束自动应用
        // 与自动下载两条路径（此处为启动编排唯一入口）
        if (isInBackoff(cfg.auto_update_fail_at)) {
          console.warn('[Update] 自动更新失败退避中（24h），跳过自动应用/下载；可在设置页手动检测更新')
          return
        }

        // 已有待应用更新：仅当安装包就绪、文件在盘且版本仍为当前最新版才自动应用。
        // 注意不依赖 info.hasUpdate：版本齐平（本地=服务器=安装包）时服务器虽报告
        // "无更新"，但已下载的安装包仍应被应用——与手动"立即重启并更新"按钮同语义
        // （按钮只看安装包就绪，不查 hasUpdate），避免"按钮能更新、重启后自动应用失效"
        // 的不对等。canAutoApply 仍校验 st.version === latestVersion，防陈旧提升；
        // 网络故障时 latestVersion 为 null，canAutoApply 返回 false，走 error 分支保留标志。
        if (cfg.pending_update === 'true') {
          const st = await getUpdateStatus()
          if (cancelled) return
          if (canAutoApply(st, info.latestVersion)) {
            // 关键：应用更新前先清除 pending_update 标志并置 applyingRef。
            // applyUpdate() 会调用 app_handle.exit(0) 终止当前进程，由 bat 脚本
            // 静默安装后重启；否则重启后的新进程会再次触发 applyUpdate()，
            // 形成"白屏 → 退出 → bat 弹窗 → 重启 → 白屏"的死循环。
            applyingRef.current = true
            try {
              await setConfig('pending_update', 'false')
              await applyUpdate()
              return // 进程将退出
            } catch (e) {
              console.warn('[Update] 自动应用待更新失败:', e)
              // 失败后复位 applyingRef（含 setConfig 拒绝/applyUpdate 失败）：
              // 本会话后续下载（全局 update-progress 监听）仍能正常写回
              // pending_update，避免静默更新被永久抑制
              applyingRef.current = false
              // 记录失败退避时间戳，24h 内不再自动发起下载/提升待应用
              setConfig('auto_update_fail_at', new Date().toISOString()).catch((failErr) => {
                console.warn('[Update] 记录失败退避失败:', failErr)
              })
              // 应用失败已记录退避：本会话不再回落到自动下载，避免同会话立即
              // 重新下载并再次武装 pending_update；下次启动由上方退避检查统一拦截
              return
            }
          } else if (info.error) {
            // 更新源故障（图床不可达/清单异常）且安装包不满足应用条件：保留
            // pending_update 待下次启动重试——瞬态故障不能误删有效安装包的待应用状态
            console.warn('[Update] 检测更新源失败，保留待应用状态:', info.error)
            return
          }
          // 服务器明确确认无更新且安装包不满足应用条件（陈旧/失效/版本不符）：清残留标志
          await setConfig('pending_update', 'false')
        }

        // 静默自动下载：检测到新版本时自动用默认源下载
        if (info.hasUpdate && info.updateUrl) {
          try {
            const st = await getUpdateStatus()
            if (cancelled) return
            // ready 是否可信取决于"安装包文件确实在盘上"且其记录版本 === 当前最新版：
            // - 就绪、文件在、版本匹配：直接安排下次启动应用，不重复下载
            // - 就绪、文件在、版本未知（migration 16 遗留行）或版本不匹配（过期
            //   残留/其他渠道旧版）：回落重新下载当前最新版，避免遗留安装包阻塞
            //   自动更新管线
            // - 文件缺失或任务失败/无任务：重新下载当前最新版
            if (st && st.status === 'ready' && st.installerExists) {
              if (st.version === info.latestVersion) {
                if (applyingRef.current) return
                await setConfig('pending_update', 'true')
              } else {
                // 版本未知或版本不匹配：重新下载当前最新版
                if (applyingRef.current) return
                const res = await prepareUpdate(info.updateUrl, info.latestVersion)
                autoTaskIdRef.current = res?.taskId ?? null
              }
            } else {
              // 无任务 / 失败 / 进行中 / 安装包缺失：发起（或由 Rust 端去重复用）
              // 默认源后台下载任务，并记录自动任务 id 供全局监听识别
              if (applyingRef.current) return
              const res = await prepareUpdate(info.updateUrl, info.latestVersion)
              autoTaskIdRef.current = res?.taskId ?? null
            }
          } catch (e) {
            console.warn('[Update] 静默自动下载启动失败:', e.message)
          }
        }
      } catch (e) {
        setUpdateInfo({ hasUpdate: false, error: e.message })
      }
    }
    startup()
    return () => { cancelled = true }
  }, [isMobile])

  // 静默自动更新：全局监听下载进度。仅处理启动编排自动发起的任务（taskId 匹配）：
  // - ready：经 getUpdateStatus 复核安装包就绪、文件在盘且版本仍为最新版后才写入
  //   pending_update（防陈旧提升，不绕过启动编排的版本校验）
  // - failed：记录失败退避时间戳（手动下载失败不压制自动更新，由设置页展示错误）
  useEffect(() => {
    // 手机端不参与 PC 安装包静默更新：不监听 update-progress，避免写 pending_update
    if (isMobile) return
    let cancelled = false
    let unlisten = null
    listen('update-progress', (ev) => {
      const payload = ev.payload || {}
      // 自动应用进行中（即将退出进程）时不再写回，避免残留标志
      if (applyingRef.current) return
      // 只处理自动任务；手动下载（设置页发起）由 GameSettings 自身监听处理
      if (payload.taskId !== autoTaskIdRef.current) return
      if (payload.status === 'ready') {
        // 复用共享提升门禁（armPendingUpdate：版本 + 安装包在盘校验 + 写
        // pending_update + 清退避），与设置页 ready 分支行为一致，不重复内联逻辑
        armPendingUpdate(latestVersionRef.current).catch((e) => console.warn('[Update] 复核就绪状态失败:', e))
      } else if (payload.status === 'failed') {
        // 仅自动任务失败记录退避时间戳，24h 内启动编排不再自动发起下载
        setConfig('auto_update_fail_at', new Date().toISOString()).catch((e) => {
          console.warn('[Update] 记录失败退避失败:', e)
        })
      }
    }).then((fn) => {
      // listen() 异步 resolve：若组件已卸载（StrictMode 双挂载/热更新），
      // 立即注销返回的 unlisten，避免首个监听器泄漏（重复触发 ready 写入）
      if (cancelled) fn()
      else unlisten = fn
    }).catch((e) => console.warn('[Update] 监听更新进度失败:', e))
    return () => { cancelled = true; unlisten?.() }
  }, [isMobile])

  const { t } = useTranslation()
  const [uninstallTarget, setUninstallTarget] = useState(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [modListKey, setModListKey] = useState(0)
  // 漫游引导：看过一次就不再弹（记录在 SQLite config 表，跨版本/跨 WebView 缓存稳定）。
  // 判断依据是 guideId 是否存在于已看映射，而非版本号相等——按版本比较会导致每次升级都重复弹出。
  // 注意：这些 state 必须声明在下方 initialize effect 之前——该 effect 会调
  // setGuideSeenMap，声明在后面会命中 react-hooks/immutability 的 TDZ 检查。
  const [guideSeenMap, setGuideSeenMap] = useState({})

  useEffect(() => {
    let isMounted = true

    const initialize = async () => {
      try {
        const configMap = await getConfigs(['language', 'selected_tab', 'initialized', 'game_path', 'theme_mode', GUIDE_SEEN_KEY])

        if (!isMounted) {
          return
        }

        // 已见引导版本映射：{ [guideId]: version }，各漫游引导独立记录（存 SQLite config，跨 WebView 缓存稳定）
        try {
          setGuideSeenMap(JSON.parse(configMap[GUIDE_SEEN_KEY] || '{}'))
        } catch {
          setGuideSeenMap({})
        }

        // 应用已保存的主题模式（未保存时保持跟随系统）
        if (['light', 'dark', 'system'].includes(configMap.theme_mode)) {
          setThemeMode(configMap.theme_mode)
        }

        // 应用已保存的语言设置（在 dispatch 之前等待完成，避免 UI 渲染时语言正在切换）
        if (configMap.language) {
          try {
            await i18n.changeLanguage(configMap.language)
          } catch {
            // changeLanguage 失败不影响主流程
          }
        }

        // 旧版本把 模组/v1/v2 作为独立 tab 持久化；新版本统一收纳到 localmods
        const LEGACY_LOCAL_TABS = { mods: 'localmods', v1: 'localmods', v2: 'localmods' }
        // 旧版本 点赞/申请 独立 tab → 新版本统一收纳到 notify
        const LEGACY_NOTIFY_TABS = { likes: 'notify', apply: 'notify' }
        const validTabs = isMobile
          ? MOBILE_TABS
          : ['localmods', 'saves', 'import-export', 'workshop', 'notify', 'settings']
        let restoredTab = configMap.selected_tab
        if (LEGACY_LOCAL_TABS[restoredTab]) restoredTab = LEGACY_LOCAL_TABS[restoredTab]
        if (LEGACY_NOTIFY_TABS[restoredTab]) restoredTab = LEGACY_NOTIFY_TABS[restoredTab]
        // 手机端残留的桌面 tab（localmods/saves/import-export）一律回落到社区页
        if (isMobile && !validTabs.includes(restoredTab)) restoredTab = 'workshop'
        if (restoredTab && validTabs.includes(restoredTab)) {
          setSelectedTab(restoredTab)
          // 旧值映射后回写持久化，避免每次启动都走映射
          if (configMap.selected_tab !== restoredTab) {
            setConfig('selected_tab', restoredTab).catch(() => {})
          }
        }

        // 游戏目录配好即视为初始化完成。无需再校验 exe_path——它是从 game_path
        // 派生的死字段（启动游戏由 Rust 端 launch_game 自行 join 文件名），已删除。
        // 手机端没有"游戏目录"概念（也不做本地模组），直接视为已初始化，
        // 跳过欢迎屏/首启向导，进主界面。
        if (isMobile) {
          dispatch({ type: 'INIT_COMPLETE', config: { ...configMap, initialized: 'true' } })
        } else if (configMap.initialized === 'true' || configMap.game_path) {
          dispatch({ type: 'INIT_COMPLETE', config: { ...configMap, initialized: 'true' } })
        } else {
          dispatch({ type: 'FIRST_RUN' })
        }
      } catch (e) {
        console.error('Failed to initialize app:', e)
        if (isMounted) {
          if (isMobile) {
            // 读本地配置失败也不能把手机端卡在欢迎屏（那里要选游戏目录）
            dispatch({ type: 'INIT_COMPLETE', config: { initialized: 'true' } })
          } else {
            dispatch({ type: 'FIRST_RUN' })
          }
        }
      }
    }

    initialize()

    return () => {
      isMounted = false
    }
  }, [isMobile])

  const handleWelcomeComplete = async (configData) => {
    dispatch({ type: 'WELCOME_COMPLETE', config: configData })
  }

  const handleConfigChange = (configData) => {
    dispatch({ type: 'UPDATE_CONFIG', config: configData })
  }

  const handleTabChange = async (tab) => {
    setSelectedTab(tab)
    try {
      await setConfig('selected_tab', tab)
    } catch (e) {
      console.error('Failed to persist selected tab:', e)
    }
  }

  // 是否弹出漫游引导：纯粹由 state 推导，渲染期直接算，不落 effect——
  // 落 effect 再 setState 会多一轮渲染，也命中 react-hooks/set-state-in-effect。
  // 一旦用户点过「知道了」，handleCloseGuide 会写入 guideSeenMap，本表达式随即转 false。
  const shouldShowGuide =
    // 手机端不弹漫游引导：引导定位的是桌面排序下拉框，社区页在手机上也不常驻
    !isMobile &&
    state.isFirstRun === false &&
    // 全新安装（走过欢迎屏）不弹更新说明
    !state.sawWelcome &&
    // 该引导从未看过才触发（多引导各自记录，互不影响）
    !guideSeenMap[WORKSHOP_SORT_GUIDE]

  // 引导激活时切到创意工坊「云」tab——排序下拉框在该页，SpotlightGuide 靠轮询定位它。
  // 用 setSelectedTab 而非 handleTabChange，避免覆盖用户上次停留的 tab 持久化值。
  // 这里是「同步到外部系统」（DOM hash），非 effect 内 setState，符合规则要求。
  useEffect(() => {
    if (!shouldShowGuide) return
    window.location.hash = '#/workshop/browse'
  }, [shouldShowGuide])

  // 上面若判定要弹引导，就渲染在工坊页——同样在渲染期推导，与 shouldShowGuide 同源。
  // 首帧 selectedTab 可能仍是上次停留的 tab，故用 shouldShowGuide 覆盖它。
  // 手机端兜底：持久化下来的桌面 tab 一律回落到社区页（侧栏也不会再给出那些入口）
  const activeTab = shouldShowGuide
    ? 'workshop'
    : isMobile && !MOBILE_TABS.includes(selectedTab)
      ? 'workshop'
      : selectedTab

  // 导航历史：每次页面停留（标签 + hash）都对齐栈游标，侧键前进/后退按栈恢复。
  // 详情页的开关本身由各详情组件的 hashchange 处理，这里只负责记账，
  // 这样「详情按钮返回」这类组件自己改 hash 的路径也能让游标保持正确。
  const activeTabRef = useRef(activeTab)
  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])

  // 详情页的归属标签由 hash 决定：从通知页点开详情时「改 hash」与「切标签」是两次
  // 状态更新，按 activeTab 记会得到半新半旧的混合态，按 hash 推导才稳定
  const navReady = state.isFirstRun === false
  const noteCurrentView = useCallback(() => {
    // 启动恢复 tab 之前的默认值（mods）不是用户停留过的页面，补一条会把侧键后退
    // 引到空白处；欢迎屏同理不参与浏览历史
    if (!navReady) return
    const hash = window.location.hash
    noteView({ tab: tabOfHash(hash) || activeTabRef.current, hash })
  }, [navReady])

  useEffect(() => {
    noteCurrentView()
  }, [activeTab, noteCurrentView])

  useEffect(() => {
    window.addEventListener('hashchange', noteCurrentView)
    return () => window.removeEventListener('hashchange', noteCurrentView)
  }, [noteCurrentView])

  // 把「恢复视图」的实现交给 navHistory：切标签 + 写 hash 都在这里统一执行
  useEffect(() => {
    setViewRestorer((view) => {
      // 手机端只接受移动端标签集合，桌面页的浏览历史不恢复（否则会切到不存在的页）
      const allowed = isMobile ? MOBILE_TABS.includes(view.tab) : NAV_TABS.has(view.tab)
      if (view.tab && allowed && view.tab !== activeTabRef.current) {
        setSelectedTab(view.tab)
        setConfig('selected_tab', view.tab).catch((e) => {
          console.error('Failed to persist selected tab:', e)
        })
      }
      const hash = view.hash || ''
      if (window.location.hash !== hash) window.location.hash = hash
    })
    return () => setViewRestorer(null)
  }, [isMobile])

  // 唯一的侧键监听：详情页自己先处理，没人接管时按导航历史后退/前进
  useNavBrowsing()

  const handleCloseGuide = () => {
    setGuideSeenMap((prev) => {
      const next = { ...prev, [WORKSHOP_SORT_GUIDE]: APP_VERSION }
      setConfig(GUIDE_SEEN_KEY, JSON.stringify(next)).catch((e) => {
        console.warn('[Guide] 记录已读版本失败:', e)
      })
      return next
    })
  }

  const handleUninstallMod = (mod) => {
    setUninstallTarget(mod)
  }

  const confirmUninstall = async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      // modKey 由卡片侧（ModCardActions）解析后透传，勿再用 name 做去扩展名等
      // 字符串加工 —— mod_key 本身可含点号（如 "Manaka's Challenge v0.2"）
      await uninstallMod({ modKey: uninstallTarget.modKey || uninstallTarget.name.replace(/\/$/, '') })
      setUninstallTarget(null)
      setModListKey(k => k + 1)
    } catch (e) {
      alert('退订失败: ' + e.message)
    } finally {
      setUninstalling(false)
    }
  }

  // 首次读取本地配置期间（isFirstRun === null）此前渲染的是个纯色空 div：
  // 配置查询 + 页面代码下载可能持续数秒，窗口又已由 usePersistUI 显示，用户只看到
  // 一片空白。这里给出明确的加载指示，让「还在启动」和「已经卡死」可区分。
  if (state.isFirstRun === null) {
    return (
      <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
        <div className={styles.loadingContainer}>
          <Spinner size="large" label={t('app.loading')} />
        </div>
      </FluentProvider>
    )
  }

  if (state.isFirstRun) {
    return (
      <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
        <div className={mergeClasses(styles.root, isMobile && styles.mobileRoot)}>
          <TitleBar />
          <WelcomeScreen onComplete={handleWelcomeComplete} />
        </div>
      </FluentProvider>
    )
  }

  return (
    <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
      <AuthProvider>
        <GameMasterProvider>
        <LegacyAccountProvider>
        <UserNavProvider onOpenMod={(modId) => {
          window.location.hash = `#/mod/${modId}`
          setNavTarget({ modId, commentId: null })
          handleTabChange('workshop')
        }} onOpenLocalMods={(localTab, modKey) => {
          // 携带 modKey 时写入 #/localmods/<tab>?mod=<key>，LocalMods 解析后透传 MissionFolder 定位高亮
          const base = `#/localmods/${localTab || 'mods'}`
          window.location.hash = modKey ? `${base}?mod=${encodeURIComponent(modKey)}` : base
          handleTabChange('localmods')
        }} onOpenSettings={() => {
          // 游戏版本门控弹窗「去设置页」：与侧栏 onNavigateToSettings 同款，持久化 selected_tab
          handleTabChange('settings')
        }}>
        <V2PrereqNoticeProvider>
          <OverwriteConfirmProvider>
            <NotificationProvider>
              <AnnouncementProvider>
                {/* 下载中心必须挂在所有页面之上：进度数据源是全局事件，
                    任何页面进出都只是换消费者，任务本身不随组件卸载消失 */}
                <DownloadCenterProvider>
                <div className={mergeClasses(styles.root, isMobile && styles.mobileRoot)}>
                  <TitleBar />
                  <div className={styles.appShell}>
                    <TabNavigation
                      value={activeTab}
                      onChange={handleTabChange}
                      isCollapsed={sidebarCollapsed}
                      onToggleCollapse={toggleSidebar}
                      isNarrow={isNarrow}
                      drawerOpen={drawerOpen}
                      onOpenDrawer={openDrawer}
                      onCloseDrawer={closeDrawer}
                      updateInfo={updateInfo}
                      themeMode={themeMode}
                      onSelectTheme={handleSelectTheme}
                      onNavigateToSettings={() => handleTabChange('settings')}
                    >
                      {/* 窄屏抽屉：开抽屉的入口交给页面自己渲染的 <NarrowMenuButton />，
                          有页签的页面并进页签行，其余页面在这里统一出一行顶栏 */}
                      <NarrowNavProvider isNarrow={isNarrow} drawerOpen={drawerOpen} openDrawer={openDrawer}>
                      {isNarrow && !NARROW_OWN_TABS.has(activeTab) && (
                        <div className={styles.narrowAppBar}>
                          <NarrowMenuButton />
                          <span className={styles.narrowAppBarTitle}>{t(NARROW_APP_BAR_TITLE[activeTab] || 'app.title')}</span>
                        </div>
                      )}
                      <main className={styles.tabContent}>
                        {/* 懒加载页面的统一加载态：只在首次切到该 tab、其代码块仍在下载时短暂出现 */}
                        <Suspense fallback={<div className={styles.pageLoading}><Spinner size="medium" label={t('app.loading')} /></div>}>
                        {activeTab === 'localmods' && <LocalMods key={`localmods-${state.config?.game_path || ''}-${modListKey}`} config={state.config} onUninstall={handleUninstallMod} />}
                        {activeTab === 'saves' && <SaveManagement config={state.config} />}
                        {activeTab === 'import-export' && <ImportExport config={state.config} />}
                        {activeTab === 'workshop' && <Workshop initialModId={navTarget?.modId} initialCommentId={navTarget?.commentId} onConsumeNavTarget={() => setNavTarget(null)} />}
                        {activeTab === 'notify' && <NotifyPage onNavigate={(entity, targetId, commentId) => {
                          if (entity === 'discussion') {
                            // 讨论区通知：设置 #/discuss/<id>?comment=<cid>，Workshop hashchange 自动切到讨论区并打开对应楼层
                            window.location.hash = commentId ? `#/discuss/${targetId}?comment=${commentId}` : `#/discuss/${targetId}`
                            handleTabChange('workshop')
                          } else {
                            // mod 通知：同步写入 #/mod/<id> hash（BrowseMods 从 hash 恢复详情），
                            // 避免残留上次讨论区的 #/discuss/ hash 导致刷新/挂载时 tab 恢复错乱
                            window.location.hash = commentId ? `#/mod/${targetId}?comment=${commentId}` : `#/mod/${targetId}`
                            setNavTarget({ modId: targetId, commentId })
                            handleTabChange('workshop')
                          }
                        }} />}
                        {activeTab === 'settings' && <GameSettings config={state.config} onConfigChange={handleConfigChange} appUpdateInfo={updateInfo} />}
                        </Suspense>
                      </main>
                      </NarrowNavProvider>
                    </TabNavigation>
                  </div>
                  {/* 悬浮下载条：桌面端全局显示；手机端没有安装/下载能力，不渲染 */}
                  {!isMobile && <DownloadStatusBar />}
                </div>
              </DownloadCenterProvider>
              </AnnouncementProvider>
            </NotificationProvider>
          </OverwriteConfirmProvider>
        </V2PrereqNoticeProvider>
        </UserNavProvider>
        </LegacyAccountProvider>
        </GameMasterProvider>

        <Dialog open={!!uninstallTarget} onOpenChange={(_, { open }) => !open && setUninstallTarget(null)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{t('workshop.confirmUninstall')}</DialogTitle>
              <DialogContent>
                <Text size="small">{t('workshop.uninstallHint')}</Text>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button size="small" appearance="subtle">{t('workshop.cancel')}</Button>
                </DialogTrigger>
                <Button size="small" appearance="primary" onClick={confirmUninstall} disabled={uninstalling}>
                  {uninstalling ? t('workshop.processing') : t('workshop.uninstall')}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        {shouldShowGuide && !isMobile && (
          <SpotlightGuide targetSelector="[data-tour='workshop-sort-select']" guideId={WORKSHOP_SORT_GUIDE} onDone={handleCloseGuide} />
        )}
      </AuthProvider>
      <Toaster position="top-end" />
      <BottomToaster />
    </FluentProvider>
  )
}

export default App