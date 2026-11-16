import { createContext } from 'react'

const EMPTY_MASTERS = new Set()

/**
 * 游戏领域大神集合。默认值提供安全的空实现，
 * 使未包裹 Provider 的场景（登录页/独立预览）也能正常渲染头像。
 */
const GameMasterContext = createContext({
  masters: EMPTY_MASTERS,
  isMaster: () => false,
  refresh: () => {},
})

export default GameMasterContext
