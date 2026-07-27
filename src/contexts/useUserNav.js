import { useContext } from 'react'
import UserNavContext from './UserNavContext'

export function useUserNav() {
  const ctx = useContext(UserNavContext)
  if (!ctx) throw new Error('useUserNav must be used within UserNavProvider')
  return ctx
}
