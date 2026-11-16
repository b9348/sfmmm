import { useContext } from 'react'
import GameMasterContext from './GameMasterContext'

export function useGameMaster() {
  return useContext(GameMasterContext)
}

export default useGameMaster
