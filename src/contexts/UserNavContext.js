import { createContext } from 'react'

/**
 * 用户导航上下文
 * 提供 openUser(userInfo) 方法，在任意位置打开用户个人资料弹窗
 */
const UserNavContext = createContext(null)

export default UserNavContext
