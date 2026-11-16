import { Toaster } from '@fluentui/react-components'

/**
 * 全局右下角 Toaster。
 * 独立于 App 默认的 top-end Toaster：用于「操作结果」类短提示（删除成功/失败等），
 * 使用方通过 useToastController(BOTTOM_TOASTER_ID) 派发，toast 不会随触发它的页面卸载而消失。
 */
export const BOTTOM_TOASTER_ID = 'app-bottom-toast'

export function BottomToaster() {
  return <Toaster toasterId={BOTTOM_TOASTER_ID} position="bottom-end" />
}
