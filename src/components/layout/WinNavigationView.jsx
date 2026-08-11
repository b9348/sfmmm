import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import './WinNavigationView.css'

// 对应 winuionweb（WinUI on Web）中的 NavigationView 组件，使用 React 19 复刻。
// 支持 Left / LeftCompact / LeftMinimal / Auto 四种展示模式，含分组折叠、
// 选中指示条动画、紧凑模式等交互。

const GLYPH = {
  hamburger: '\uE700', // GlobalNavButton
  back: '\uE72B',       // Back
  settings: '\uE713',   // Setting
  chevron: '\uE70D',    // ChevronDown
}

// 将外部传入的菜单项规范化为内部结构
const normalizeItem = (item, fallbackKey = 'item') => {
  const declaredType = item?.type ?? (item?.isHeader ? 'Header' : item?.isSeparator ? 'Separator' : 'Item')
  const children = item?.children ?? item?.menuItems ?? item?.MenuItems
  return {
    value: item?.value ?? item?.key ?? item?.tag ?? fallbackKey,
    label: item?.label ?? item?.content ?? item?.Content ?? '',
    icon: item?.icon ?? item?.glyph ?? item?.Icon ?? '',
    badge: item?.badge ?? item?.infoBadge ?? null,
    type: declaredType,
    children: Array.isArray(children) ? children.map((child, i) => normalizeItem(child, `${fallbackKey}-${i}`)) : null,
    isEnabled: item?.isEnabled !== false && item?.disabled !== true,
    selectsOnInvoked: item?.selectsOnInvoked !== false,
  }
}

// 扁平化所有菜单项（含子项），用于选中值解析
const flattenItems = (items) => items.flatMap((item) => [item, ...(item.children || [])])

const resolveDisplayMode = (mode, width, expandedThreshold, compactThreshold) => {
  if (mode !== 'Auto' && mode !== 'auto') return mode
  if (width >= expandedThreshold) return 'Left'
  if (width >= compactThreshold) return 'LeftCompact'
  return 'LeftMinimal'
}

/**
 * WinNavigationView — React 版 WinUI NavigationView 侧边导航栏
 *
 * @param {Array}  menuItems        主菜单项，结构见 normalizeItem
 * @param {Array}  footerMenuItems  底部菜单项（在设置按钮上方）
 * @param {string} selectedValue    受控选中值
 * @param {Function} onSelect       选中回调 (value)
 * @param {string} paneTitle        面板标题
 * @param {string} header           内容区顶部标题
 * @param {string} displayMode      'Auto' | 'Left' | 'LeftCompact' | 'LeftMinimal'
 * @param {boolean} isPaneOpen      受控面板展开状态
 * @param {Function} onTogglePane   汉堡按钮回调
 * @param {boolean} isBackButtonVisible / isBackEnabled / onBackRequested
 * @param {boolean} isSettingsVisible / settingsLabel / onSettings
 * @param {number} openPaneLength   展开宽度（默认 320）
 * @param {number} compactPaneLength 紧凑宽度（默认 48）
 * @param {Object} icons            内置按钮图标（可选，React 节点）：
 *                                  { hamburger, back, settings, chevron }，
 *                                  缺省使用 Segoe Fluent Icons 字形
 */
export function WinNavigationView({
  menuItems = [],
  footerMenuItems = [],
  selectedValue = null,
  onSelect,
  paneTitle = '',
  header = '',
  displayMode = 'Auto',
  isPaneOpen,
  onTogglePane,
  isBackButtonVisible = true,
  isBackEnabled = false,
  onBackRequested,
  isSettingsVisible = true,
  settingsLabel = '设置',
  onSettings,
  openPaneLength = 320,
  compactPaneLength = 48,
  expandedThreshold = 1008,
  compactThreshold = 641,
  icons = {},
  paneHeader = null,
  paneFooter = null,
  children,
}) {
  // 内置按钮图标：优先使用传入的 React 节点，否则回退到 Segoe 字形
  const builtinIcons = {
    hamburger: icons.hamburger ?? GLYPH.hamburger,
    back: icons.back ?? GLYPH.back,
    settings: icons.settings ?? GLYPH.settings,
    chevron: icons.chevron ?? GLYPH.chevron,
  }
  const normalizedMenu = useMemo(() => menuItems.map((item, i) => normalizeItem(item, `menu-${i}`)), [menuItems])
  const normalizedFooter = useMemo(() => footerMenuItems.map((item, i) => normalizeItem(item, `footer-${i}`)), [footerMenuItems])
  const allItems = useMemo(() => [...normalizedMenu, ...normalizedFooter], [normalizedMenu, normalizedFooter])
  const flatItems = useMemo(() => flattenItems(allItems), [allItems])

  // 面板开关：受控优先，否则内部状态
  const [internalOpen, setInternalOpen] = useState(true)
  const paneOpen = isPaneOpen !== undefined ? isPaneOpen : internalOpen
  const togglePane = () => {
    if (onTogglePane) onTogglePane(!paneOpen)
    else setInternalOpen(!paneOpen)
  }

  // Auto 模式：监听容器宽度
  const shellRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : expandedThreshold)
  useEffect(() => {
    if (displayMode !== 'Auto' && displayMode !== 'auto') return
    const el = shellRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [displayMode])

  const resolvedMode = useMemo(
    () => resolveDisplayMode(displayMode, containerWidth, expandedThreshold, compactThreshold),
    [displayMode, containerWidth, expandedThreshold, compactThreshold]
  )
  const isTopNav = resolvedMode === 'Top'
  const isLeftMinimal = resolvedMode === 'LeftMinimal'
  const isLeftCompact = resolvedMode === 'LeftCompact'
  const isOverlay = isLeftMinimal || isLeftCompact
  // 紧凑状态：Left 模式折叠后收窄为 rail；覆盖模式未展开时同样收窄
  const isCompact = isLeftMinimal ? !paneOpen : !paneOpen || isLeftCompact

  // 选中值
  const resolveSelected = (selected) => {
    if (selected === 'settings') return 'settings'
    const hit = flatItems.find((item) => item.value === selected)
    return hit ? hit.value : selected
  }
  const currentValue = resolveSelected(selectedValue)

  // 分组展开状态
  const [expandedGroups, setExpandedGroups] = useState(() => {
    const init = {}
    for (const item of allItems) {
      if (item.children?.length) init[item.value] = true
    }
    return init
  })
  const toggleGroup = (value) => setExpandedGroups((prev) => ({ ...prev, [value]: !prev[value] }))
  const isChildOfGroup = (group) => group.children?.some((child) => child.value === currentValue)

  // 选中指示条定位
  const itemRefs = useRef({})
  const indicatorRef = useRef(null)
  const [indicatorTop, setIndicatorTop] = useState(null)
  // 布局过渡（折叠/展开、分组收展）期间蓝标进入跟随模式：
  // 禁用自身过渡，位置由 JS 逐帧跟随目标条目，形成 WinUI 风格的推动感
  const [indicatorFollowing, setIndicatorFollowing] = useState(false)
  // 蓝标目标值（对齐源码 getIndicatorTargetForValue + watch(isCompact)）：
  // 侧边栏折叠（紧凑 rail）或所属组被收起时，蓝标回到一级父菜单；
  // 否则（展开且组展开）定位到子项本身
  const indicatorTargetValue = useMemo(() => {
    const parent = allItems.find((item) => item.children?.some((child) => child.value === currentValue))
    if (!parent) return currentValue
    const groupCollapsed = !expandedGroups[parent.value]
    if (isCompact || groupCollapsed) return parent.value
    return currentValue
  }, [currentValue, isCompact, allItems, expandedGroups])

  const updateIndicator = useCallback(() => {
    const el = itemRefs.current[indicatorTargetValue]
    const indicator = indicatorRef.current
    if (!el || !indicator) return
    // 指示条以轨道为参考系（轨道覆盖整个面板）。用 getBoundingClientRect
    // 计算条目在轨道内的纵向位置，避免 offsetParent 层级造成的坐标错位。
    const track = indicator.parentElement
    if (!track) return
    const itemRect = el.getBoundingClientRect()
    const trackRect = track.getBoundingClientRect()
    // 指示条高度 16px，条目高度 36px，垂直居中偏移 10px
    const top = itemRect.top - trackRect.top + 10
    setIndicatorTop(top)
  }, [indicatorTargetValue])

  // 记录上一次 effect 运行时的布局状态，用于区分「布局过渡」与「普通选中切换」
  const prevLayoutRef = useRef({ isCompact, expandedGroups })
  // 布局过渡（200ms CSS 动画）窗口截止时间：窗口内 resize / ResizeObserver
  // 等被动回调读到的是中间布局，一律跳过，改由 settle 定时器在过渡结束后测量一次
  const transitioningUntilRef = useRef(0)
  // 跟随模式 rAF 句柄：过渡期间每帧驱动蓝标贴住目标条目，形成推动感
  const followRafRef = useRef(null)

  // 被动入口（resize / RO）：过渡窗口内跳过，避免蓝标被中间布局拖到半路
  const gatedUpdate = useCallback(() => {
    if (performance.now() < transitioningUntilRef.current) return
    updateIndicator()
  }, [updateIndicator])

  // 跟随模式：每帧读取目标条目的实时位置，直接写 DOM 驱动蓝标
  // （is-following 下蓝标自身无过渡，随条目动画同步移动，WinUI 推动感）
  const startFollowing = useCallback(() => {
    cancelAnimationFrame(followRafRef.current)
    const tick = () => {
      const el = itemRefs.current[indicatorTargetValue]
      const indicator = indicatorRef.current
      if (el && indicator) {
        const track = indicator.parentElement
        if (track) {
          const itemRect = el.getBoundingClientRect()
          const trackRect = track.getBoundingClientRect()
          indicator.style.top = `${itemRect.top - trackRect.top + 10}px`
        }
      }
      followRafRef.current = requestAnimationFrame(tick)
    }
    followRafRef.current = requestAnimationFrame(tick)
  }, [indicatorTargetValue])

  const stopFollowing = useCallback(() => {
    cancelAnimationFrame(followRafRef.current)
    followRafRef.current = null
  }, [])

  useEffect(() => {
    // 折叠/展开、分组收展存在 200ms CSS 过渡（面板 clip-path、分组 grid-template-rows）。
    // 过渡期间目标条目位置连续变化——蓝标进入跟随模式，逐帧贴住目标条目，
    // 与条目动画同步移动（WinUI 推动感），而非停在原地等过渡结束再跳。
    // 窗口结束（过渡已完成）后停止跟随，最终校准一次并恢复自身过渡；
    // 普通选中切换（条目位置未变）才立即测量。
    const prev = prevLayoutRef.current
    prevLayoutRef.current = { isCompact, expandedGroups }
    const layoutTransition = prev.isCompact !== isCompact || prev.expandedGroups !== expandedGroups

    window.addEventListener('resize', gatedUpdate)
    if (layoutTransition) {
      transitioningUntilRef.current = performance.now() + 250
      setIndicatorFollowing(true)
      startFollowing()
      const settleTimer = window.setTimeout(() => {
        stopFollowing()
        // 先校准 state 再恢复自身过渡，避免 React 用旧 indicatorTop 覆盖 DOM 位置
        updateIndicator()
        setIndicatorFollowing(false)
      }, 250)
      return () => {
        stopFollowing()
        window.removeEventListener('resize', gatedUpdate)
        window.clearTimeout(settleTimer)
      }
    }
    updateIndicator()
    return () => window.removeEventListener('resize', gatedUpdate)
  }, [updateIndicator, gatedUpdate, startFollowing, stopFollowing, isCompact, expandedGroups])

  // 布局变化（登录状态、面板开合、标题加载等）后重新定位指示条；
  // 折叠/展开过渡期间 shell 尺寸随之变化会触发 RO，同样走 gatedUpdate 跳过
  useEffect(() => {
    const shell = shellRef.current
    if (!shell || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(gatedUpdate)
    ro.observe(shell)
    return () => ro.disconnect()
  }, [gatedUpdate])

  // 分组高度动画由 CSS grid-template-rows 0fr/1fr 过渡实现，无需 JS 测量
  const handleItemClick = (item) => {
    if (!item.isEnabled) return
    // 有 children 即为分组（TabNavigation 等调用方只传 children、不显式声明 type）
    if (item.children?.length) {
      // 已处于该组所属页面时：只展开/折叠子菜单（源码行为）；
      // 在其他页面时：打开该组页面并展开二级菜单。
      const isOnThisPage = currentValue === item.value || isChildOfGroup(item)
      if (isOnThisPage) {
        toggleGroup(item.value)
      } else {
        setExpandedGroups((prev) => ({ ...prev, [item.value]: true }))
        if (item.selectsOnInvoked && onSelect) onSelect(item.value)
      }
      return
    }
    if (onSelect) onSelect(item.value)
  }

  const handleSettingsClick = () => {
    if (onSettings) onSettings()
    else if (onSelect) onSelect('settings')
  }

  // 设置齿轮动画状态机（对齐源码 animated-icon-gear）：
  // mousedown → gear-rewind（0.15s 转至 -20deg）；
  // mouseup/leave（rewind 完成后）→ gear-spin（0.65s 从 -20deg 转到 360deg）。
  const [gearClass, setGearClass] = useState('')
  const gearPressedRef = useRef(false)
  const gearRewindDoneRef = useRef(false)

  const onGearDown = () => {
    gearPressedRef.current = true
    gearRewindDoneRef.current = false
    setGearClass('gear-rewind')
  }

  const onGearUpOrLeave = () => {
    if (!gearPressedRef.current) return
    gearPressedRef.current = false
    if (gearRewindDoneRef.current) setGearClass('gear-spin')
  }

  const onGearAnimEnd = () => {
    if (gearClass === 'gear-rewind') {
      gearRewindDoneRef.current = true
      if (!gearPressedRef.current) setGearClass('gear-spin')
    } else if (gearClass === 'gear-spin') {
      setGearClass('')
      gearRewindDoneRef.current = false
    }
  }

  const chevronClass = (value) => (expandedGroups[value] ? 'chevron-open' : 'chevron-close')
  const showPaneContent = !isLeftMinimal || paneOpen
  // 标题：展开态显示，紧凑态隐藏
  const showTitle = paneOpen && !isCompact

  const renderIcon = (icon, className) => {
    if (!icon) return null
    if (typeof icon === 'string' || typeof icon === 'number') {
      return <span className={`winnv-icon ${className || ''}`}>{icon}</span>
    }
    // 允许传入 React 节点（如 Fluent UI 图标）
    return <span className={`winnv-icon winnv-icon-node ${className || ''}`}>{icon}</span>
  }

  const renderMenuItem = (item) => {
    if (item.type === 'Header') {
      return (
        <div key={item.value} className="winnv-item-header">{item.label}</div>
      )
    }
    if (item.type === 'Separator') {
      return <div key={item.value} className="winnv-item-separator" />
    }
    if (item.children?.length) {
      const expanded = expandedGroups[item.value]
      const childSelected = isChildOfGroup(item)
      return (
        <div key={item.value} className={`winnv-group ${expanded && !isCompact ? 'is-expanded' : ''} ${childSelected ? 'is-child-selected' : ''}`}>
          <div
            role="button"
            tabIndex={item.isEnabled ? 0 : -1}
            className={`winnv-item winnv-group-header ${currentValue === item.value && item.selectsOnInvoked ? 'is-selected' : ''} ${!item.isEnabled ? 'is-disabled' : ''}`}
            aria-disabled={!item.isEnabled || undefined}
            onClick={() => handleItemClick(item)}
            ref={(el) => { itemRefs.current[item.value] = el }}
          >
            {renderIcon(item.icon)}
            <span className="winnv-label">{item.label}</span>
            {item.badge && <span className="winnv-infobadge">{item.badge}</span>}
            <span className={`winnv-icon winnv-group-chevron ${chevronClass(item.value)}`} onClick={(e) => { e.stopPropagation(); toggleGroup(item.value) }}>{builtinIcons.chevron}</span>
          </div>
          <div
            className="winnv-group-children"
            aria-hidden={!expanded || isCompact ? 'true' : undefined}
          >
            <div className="winnv-group-children-inner">
              {item.children.map((child) => (
                <div
                  key={child.value}
                  role="button"
                  tabIndex={child.isEnabled ? 0 : -1}
                  className={`winnv-item winnv-group-child ${currentValue === child.value ? 'is-selected' : ''} ${!child.isEnabled ? 'is-disabled' : ''}`}
                  aria-disabled={!child.isEnabled || undefined}
                  onClick={() => handleItemClick(child)}
                  ref={(el) => { itemRefs.current[child.value] = el }}
                >
                  {renderIcon(child.icon)}
                  <span className="winnv-label">{child.label}</span>
                  {child.badge && <span className="winnv-infobadge">{child.badge}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    }
    return (
      <div
        key={item.value}
        role="button"
        tabIndex={item.isEnabled ? 0 : -1}
        className={`winnv-item ${currentValue === item.value ? 'is-selected' : ''} ${!item.isEnabled ? 'is-disabled' : ''}`}
        aria-disabled={!item.isEnabled || undefined}
        title={isCompact ? item.label : undefined}
        onClick={() => handleItemClick(item)}
        ref={(el) => { itemRefs.current[item.value] = el }}
      >
        {renderIcon(item.icon)}
        <span className="winnv-label">{item.label}</span>
        {item.badge && <span className="winnv-infobadge">{item.badge}</span>}
      </div>
    )
  }

  return (
    <div
      ref={shellRef}
      className={`winnv-shell ${isLeftMinimal ? 'is-left-minimal' : isLeftCompact ? 'is-left-compact' : 'is-left'} ${isOverlay ? 'is-overlay-left' : ''}`}
      style={{
        '--winnv-open-pane-length': `${openPaneLength}px`,
        '--winnv-compact-pane-length': `${compactPaneLength}px`,
      }}
    >
      {isTopNav ? (
        <nav className="winnv-top-bar">
          {isBackButtonVisible && (
            <button className="winnv-back-button" disabled={!isBackEnabled} onClick={onBackRequested} aria-label="返回">
              <span className="winnv-icon">{builtinIcons.back}</span>
            </button>
          )}
          {paneTitle && <span className="winnv-top-pane-title">{paneTitle}</span>}
          <div className="winnv-menu winnv-top-menu">
            {normalizedMenu.map((item) => renderMenuItem(item))}
          </div>
        </nav>
      ) : (
        <nav
          className={`winnv-left-panel ${isCompact ? 'is-compact is-closed-compact' : ''} ${isLeftMinimal ? 'is-minimal' : ''} ${isBackButtonVisible ? 'has-back-button' : ''}`}
        >
          {isBackButtonVisible && (
            <button className="winnv-back-button" disabled={!isBackEnabled} onClick={onBackRequested} aria-label="返回" title="返回">
              <span className="winnv-icon">{builtinIcons.back}</span>
            </button>
          )}
          <div className="winnv-pane-command-row">
            <button className={`winnv-hamburger ${paneTitle && showTitle ? 'has-pane-title' : ''}`} onClick={togglePane} aria-label={paneOpen ? '收起导航' : '展开导航'} title={paneOpen ? '收起导航' : '展开导航'}>
              <span className="winnv-icon">{builtinIcons.hamburger}</span>
              {paneTitle && showTitle && <span className="winnv-pane-title">{paneTitle}</span>}
            </button>
          </div>
          {showPaneContent && (
            <div className="winnv-pane-surface" aria-hidden={isLeftMinimal && isCompact ? 'true' : undefined}>
              <div className="winnv-indicator-track">
                <div
                  className={`winnv-indicator ${indicatorFollowing ? 'is-following' : ''}`}
                  ref={indicatorRef}
                  style={{ top: indicatorTop !== null ? `${indicatorTop}px` : undefined, opacity: indicatorTop !== null ? 1 : 0 }}
                />
              </div>
              {paneHeader && <div className="winnv-pane-header">{paneHeader}</div>}
              <div className="winnv-menu">
                {normalizedMenu.map((item) => renderMenuItem(item))}
              </div>
              <div className="winnv-footer">
                {normalizedFooter.map((item) => renderMenuItem(item))}
                {isSettingsVisible && (
                  <div
                    role="button"
                    tabIndex={0}
                    className={`winnv-item winnv-settings-item ${currentValue === 'settings' ? 'is-selected' : ''}`}
                    title={isCompact ? settingsLabel : undefined}
                    onClick={handleSettingsClick}
                    onMouseDown={onGearDown}
                    onMouseUp={onGearUpOrLeave}
                    onMouseLeave={onGearUpOrLeave}
                    ref={(el) => { itemRefs.current.settings = el }}
                  >
                    <span className={`winnv-icon winnv-icon-node winnv-settings-glyph animated-icon-gear ${gearClass}`} onAnimationEnd={onGearAnimEnd}>{builtinIcons.settings}</span>
                    <span className="winnv-label">{settingsLabel}</span>
                  </div>
                )}
                {/* 版本号置于最底部 */}
                {paneFooter && <div className="winnv-pane-footer">{paneFooter}</div>}
              </div>
            </div>
          )}
        </nav>
      )}
      <main className="winnv-content">
        {header && <div className="winnv-page-header">{header}</div>}
        <div className="winnv-content-inner">{children}</div>
      </main>
    </div>
  )
}

export default WinNavigationView
