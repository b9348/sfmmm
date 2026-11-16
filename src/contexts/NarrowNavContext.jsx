/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo } from 'react'

/**
 * 窄屏抽屉导航上下文。
 *
 * 窄屏（≤768px）时侧栏是 LeftMinimal 抽屉，但触发按钮不再由导航层浮在内容之上，
 * 而是由「页面自己」放进顶部那一行——汉堡和页签 tabs 共用一行，
 * 内容区不必为它单独留一条空白行，也不依赖窗口标题栏
 * （后续若出 APK 形态、去掉自绘标题栏，这条路径依然成立）。
 *
 * 用法：页面顶部行里放 <NarrowMenuButton />，按钮自己判断宽度并从这里取 openDrawer。
 */
const NarrowNavContext = createContext({ isNarrow: false, drawerOpen: false, openDrawer: null })

export function NarrowNavProvider({ isNarrow, drawerOpen, openDrawer, children }) {
  const value = useMemo(
    () => ({ isNarrow, drawerOpen, openDrawer }),
    [isNarrow, drawerOpen, openDrawer],
  )
  return <NarrowNavContext.Provider value={value}>{children}</NarrowNavContext.Provider>
}

export function useNarrowNav() {
  return useContext(NarrowNavContext)
}
