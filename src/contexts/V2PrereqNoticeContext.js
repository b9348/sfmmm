import { createContext } from 'react'

// v2 前置版本提醒（右下角 toast）的上下文：由 V2PrereqNoticeProvider 提供，
// 页面向下传递 checkAndNotify()。默认 null，供可选调用处判空。
export default createContext(null)
