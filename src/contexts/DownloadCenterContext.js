import { createContext } from 'react'

/**
 * 全局下载中心上下文
 * 维护"当前进程内所有进行中的下载/安装任务"，供悬浮下载条在任意页面展示。
 * 数据源是后端两个全局事件（subscription-progress / archive-download-progress）
 * 加一次挂载时的恢复查询，与具体页面无关——所以用户离开详情页、切换标签、
 * 甚至去订阅记录页，进度都不会丢。
 */
const DownloadCenterContext = createContext(null)

export default DownloadCenterContext
