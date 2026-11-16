import { useContext } from 'react'
import OverwriteConfirmContext from './OverwriteConfirmContext'

/**
 * 取安装覆盖确认上下文。
 * 用法：const overwrite = useOverwriteConfirm(); await overwrite?.confirmOverwrite(check)
 * 未挂载 Provider 时返回 null（调用处判空即可），不抛错。
 */
export function useOverwriteConfirm() {
  return useContext(OverwriteConfirmContext)
}
