import { useState, useEffect, useReducer, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { FluentProvider, webLightTheme, webDarkTheme, Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger, Button, Text, Toaster } from '@fluentui/react-components'
import { makeStyles, tokens } from '@fluentui/react-components'
import { TabNavigation, WelcomeScreen, TitleBar } from './components'
import SpotlightGuide from './components/common/SpotlightGuide'
import { SaveManagement, ImportExport, GameSettings, Workshop, LocalMods, NotifyPage } from './modules'
import { AuthProvider } from './contexts/AuthContext.jsx'
import { UserNavProvider } from './contexts/UserNavProvider.jsx'
import { NotificationProvider } from './contexts/NotificationContext'
import { usePersistUI } from './hooks/usePersistUI'
import { getConfigs, setConfig } from './services/dbHelper'
import { checkVersion, applyUpdate, prepareUpdate, getUpdateStatus, armPendingUpdate } from './services/updateApi'
import { isInBackoff, canAutoApply } from './services/updatePolicy'
import { uninstallMod } from './services/installMod'
import { installExternalLinkInterceptor } from './utils/externalLinks'
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
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
  },
})

// 漫游引导：每个引导有独立 id；已读记录用 SQLite config 按 id 存版本号，互不影响、便于后续扩展其他引导
const WORKSHOP_SORT_GUIDE = 'workshop-sort'
const GUIDE_SEEN_KEY = 'guide_seen_versions'

const initialState = { isFirstRun: null, config: null }

function appReducer(state, action) {
  switch (action.type) {
    case 'INIT_COMPLETE':
      return { isFirstRun: false, config: action.config }
    case 'FIRST_RUN':
      return { isFirstRun: true, config: null }
    case 'WELCOME_COMPLETE':
      return { isFirstRun: false, config: action.config }
    case 'UPDATE_CONFIG':
      return { ...state, config: { ...state.config, ...action.config } }
    default:
      return state
  }
}

function App() {
  const styles = useStyles()
  const [selectedTab, setSelectedTab] = useState('mods')
  const [navTarget, setNavTarget] = useState(null)
  const { sidebarCollapsed, toggleSidebar } = usePersistUI()
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

  // 启动时静默自动更新编排（单一入口，串行执行避免与全局监听竞态）：
  // 1) 检测更新；2) 已有待应用更新时，仅当安装包就绪、文件在盘且版本仍为当前
  // 最新版才自动应用（防陈旧提升：旧版残留不被静默安装）；3) 否则按需用默认源
  // 静默下载，就绪后由全局监听写入 pending_update，下次启动自动应用
  useEffect(() => {
    let cancelled = false
    const startup = async () => {
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
                const res = await prepareUpdate(info.updateUrl, info.latestVersion, 8)
                autoTaskIdRef.current = res?.taskId ?? null
              }
            } else {
              // 无任务 / 失败 / 进行中 / 安装包缺失：发起（或由 Rust 端去重复用）
              // 默认源后台下载任务，并记录自动任务 id 供全局监听识别
              if (applyingRef.current) return
              const res = await prepareUpdate(info.updateUrl, info.latestVersion, 8)
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
  }, [])

  // 静默自动更新：全局监听下载进度。仅处理启动编排自动发起的任务（taskId 匹配）：
  // - ready：经 getUpdateStatus 复核安装包就绪、文件在盘且版本仍为最新版后才写入
  //   pending_update（防陈旧提升，不绕过启动编排的版本校验）
  // - failed：记录失败退避时间戳（手动下载失败不压制自动更新，由设置页展示错误）
  useEffect(() => {
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
  }, [])

  useEffect(() => {
    let isMounted = true

    const initialize = async () => {
      try {
        const configMap = await getConfigs(['language', 'selected_tab', 'initialized', 'game_path', 'exe_path', 'theme_mode', GUIDE_SEEN_KEY])

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
        const validTabs = ['localmods', 'saves', 'import-export', 'workshop', 'notify', 'settings']
        let restoredTab = configMap.selected_tab
        if (LEGACY_LOCAL_TABS[restoredTab]) restoredTab = LEGACY_LOCAL_TABS[restoredTab]
        if (LEGACY_NOTIFY_TABS[restoredTab]) restoredTab = LEGACY_NOTIFY_TABS[restoredTab]
        if (restoredTab && validTabs.includes(restoredTab)) {
          setSelectedTab(restoredTab)
          // 旧值映射后回写持久化，避免每次启动都走映射
          if (configMap.selected_tab !== restoredTab) {
            setConfig('selected_tab', restoredTab).catch(() => {})
          }
        }

        if (configMap.initialized === 'true' || (configMap.game_path && configMap.exe_path)) {
          dispatch({ type: 'INIT_COMPLETE', config: { ...configMap, initialized: 'true' } })
        } else {
          dispatch({ type: 'FIRST_RUN' })
        }
      } catch (e) {
        console.error('Failed to initialize app:', e)
        if (isMounted) {
          dispatch({ type: 'FIRST_RUN' })
        }
      }
    }

    initialize()

    return () => {
      isMounted = false
    }
  }, [])

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

  const { t } = useTranslation()
  const [uninstallTarget, setUninstallTarget] = useState(null)
  const [uninstalling, setUninstalling] = useState(false)
  const [modListKey, setModListKey] = useState(0)
  // 版本更新引导：升级用户首次进入本版本时弹一次「更新说明」；全新安装（走过欢迎屏）不打扰。
  // 已见版本记录在 SQLite config 表（应用数据目录），不依赖 WebView localStorage，避免缓存/清理导致误判
  const [showGuide, setShowGuide] = useState(false)
  const [guideSeenMap, setGuideSeenMap] = useState({})
  const sawWelcomeRef = useRef(false)
  useEffect(() => {
    if (state.isFirstRun) sawWelcomeRef.current = true
  }, [state.isFirstRun])
  useEffect(() => {
    if (state.isFirstRun !== false) return
    // 全新安装（走过欢迎屏）不弹更新说明
    if (sawWelcomeRef.current) return
    // 该引导未在本版本看过则触发（多引导各自记录已看版本，互不影响）
    if (guideSeenMap[WORKSHOP_SORT_GUIDE] !== APP_VERSION) setShowGuide(true)
  }, [state.isFirstRun, guideSeenMap])
  const handleCloseGuide = () => {
    setShowGuide(false)
    setGuideSeenMap((prev) => {
      const next = { ...prev, [WORKSHOP_SORT_GUIDE]: APP_VERSION }
      setConfig(GUIDE_SEEN_KEY, JSON.stringify(next)).catch((e) => {
        console.warn('[Guide] 记录已读版本失败:', e)
      })
      return next
    })
  }

  // 漫游引导激活时自动切到创意工坊「云」tab（排序下拉框所在页），组件内部会轮询定位目标元素
  useEffect(() => {
    if (!showGuide) return
    setSelectedTab('workshop')
    window.location.hash = '#/workshop/browse'
  }, [showGuide])

  const handleUninstallMod = (mod) => {
    setUninstallTarget(mod)
  }

  const confirmUninstall = async () => {
    if (!uninstallTarget) return
    setUninstalling(true)
    try {
      await uninstallMod({ modKey: uninstallTarget.name.replace(/\.\w+$/, '').replace(/\/$/, '') })
      setUninstallTarget(null)
      setModListKey(k => k + 1)
    } catch (e) {
      alert('退订失败: ' + e.message)
    } finally {
      setUninstalling(false)
    }
  }

  if (state.isFirstRun === null) {
    return (
      <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
        <div className={styles.loadingContainer}>
        </div>
      </FluentProvider>
    )
  }

  if (state.isFirstRun) {
    return (
      <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
        <div className={styles.root}>
          <TitleBar />
          <WelcomeScreen onComplete={handleWelcomeComplete} />
        </div>
      </FluentProvider>
    )
  }

  return (
    <FluentProvider theme={resolvedTheme === 'dark' ? webDarkTheme : webLightTheme} className={`app-theme-${resolvedTheme}`}>
      <AuthProvider>
        <UserNavProvider onOpenMod={(modId) => {
          window.location.hash = `#/mod/${modId}`
          setNavTarget({ modId, commentId: null })
          handleTabChange('workshop')
        }} onOpenLocalMods={(localTab, modKey) => {
          // 携带 modKey 时写入 #/localmods/<tab>?mod=<key>，LocalMods 解析后透传 MissionFolder 定位高亮
          const base = `#/localmods/${localTab || 'mods'}`
          window.location.hash = modKey ? `${base}?mod=${encodeURIComponent(modKey)}` : base
          handleTabChange('localmods')
        }}>
        <NotificationProvider>
          <div className={styles.root}>
          <TitleBar />
          <div className={styles.appShell}>
            <TabNavigation
             value={selectedTab}
             onChange={handleTabChange}
             isCollapsed={sidebarCollapsed}
             onToggleCollapse={toggleSidebar}
             updateInfo={updateInfo}
             themeMode={themeMode}
             onSelectTheme={handleSelectTheme}
             onNavigateToSettings={() => handleTabChange('settings')}
           >
            <main className={styles.tabContent}>
              {selectedTab === 'localmods' && <LocalMods key={`localmods-${state.config?.game_path || ''}-${modListKey}`} config={state.config} onUninstall={handleUninstallMod} />}
              {selectedTab === 'saves' && <SaveManagement config={state.config} />}
              {selectedTab === 'import-export' && <ImportExport config={state.config} />}
              {selectedTab === 'workshop' && <Workshop initialModId={navTarget?.modId} initialCommentId={navTarget?.commentId} onConsumeNavTarget={() => setNavTarget(null)} />}
              {selectedTab === 'notify' && <NotifyPage onNavigate={(entity, targetId, commentId) => {
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
              {selectedTab === 'settings' && <GameSettings config={state.config} onConfigChange={handleConfigChange} appUpdateInfo={updateInfo} />}
            </main>
          </TabNavigation>
          </div>
        </div>
        </NotificationProvider>
        </UserNavProvider>

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

        {showGuide && (
          <SpotlightGuide targetSelector="[data-tour='workshop-sort-select']" guideId={WORKSHOP_SORT_GUIDE} onDone={handleCloseGuide} />
        )}
      </AuthProvider>
      <Toaster position="top-end" />
    </FluentProvider>
  )
}

export default App