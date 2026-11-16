import { useContext } from 'react'
import DownloadCenterContext from './DownloadCenterContext'

/**
 * 读取全局下载中心。返回：
 * - tasks: 全部任务（进行中 + 最近终结的，供悬浮条回显完成/失败）
 * - installByLang(modKey): 安装类，langCode → 任务（只含运行中）
 * - archiveByLang(modKey): 仅下载类，langCode → 任务（含终态，供按钮展示结果）
 * - cancel(task): 取消安装类任务（仅下载没有取消入口）
 */
export function useDownloadCenter() {
  const ctx = useContext(DownloadCenterContext)
  if (!ctx) throw new Error('useDownloadCenter must be used within DownloadCenterProvider')
  return ctx
}
