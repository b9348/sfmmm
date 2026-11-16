import { createContext } from 'react'

/**
 * 安装覆盖 / 本地残留确认上下文。
 * value: { confirmOverwrite(check) => Promise<boolean> }
 */
const OverwriteConfirmContext = createContext(null)

export default OverwriteConfirmContext
