import { Toaster } from '@fluentui/react-components'

/** 顶部独立公告 Toaster，避免与底部「操作结果」提示互相覆盖。 */
export const ANNOUNCEMENT_TOASTER_ID = 'app-announcement-toast'

export function AnnouncementToaster() {
  return <Toaster toasterId={ANNOUNCEMENT_TOASTER_ID} position="top" />
}
