import { useContext } from 'react'
import V2PrereqNoticeContext from './V2PrereqNoticeContext'

/**
 * 取 v2 前置版本提醒上下文。
 * 用法：const v2Notice = useV2PrereqNotice(); v2Notice?.checkAndNotify()
 * 未挂载 Provider 时返回 null（调用处判空即可），不抛错。
 */
export function useV2PrereqNotice() {
  return useContext(V2PrereqNoticeContext)
}
