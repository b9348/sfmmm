import { useEffect, useId } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Toaster,
  Toast,
  ToastBody,
  ToastTitle,
  useToastController,
} from '@fluentui/react-components'

const TOAST_ID = 'offline-cache-notice'

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ''
  }
}

/**
 * 本地缓存标注（Fluent Toast）：页面秒开用的是本地 SQLite 缓存的历史内容（缓存优先策略），
 * 必须明示数据来源与缓存时间，避免用户误以为是实时数据。
 * partial=true 表示详情由列表快照合成，个人评分/权限/boost 成员等字段可能不完整。
 * Toast 6 秒自动消失（信息性提示，无需常驻）；数据被网络结果替换时也会提前撤销。
 */
export function OfflineCacheNotice({ cachedAt, partial = false }) {
  const { t } = useTranslation()
  const toasterId = useId('cache-notice-toaster')
  const { dispatchToast, dismissToast } = useToastController(toasterId)

  // partial 但没有缓存时间戳：列表是实时数据、详情补全失败，当前展示的仍是列表快照。
  // 这时也要提示（正文里的 {{time}} 为空），否则用户会以为看到的是完整详情。
  const active = cachedAt != null || partial

  useEffect(() => {
    if (!active) return undefined
    const time = cachedAt ? t('offline.cachedAt', { time: formatTime(cachedAt) }) : ''
    dispatchToast(
      <Toast>
        <ToastTitle>{partial ? t('offline.cachePartialTitle') : t('offline.cacheTitle')}</ToastTitle>
        <ToastBody>
          {partial
            ? t('offline.cachePartialBody', { time })
            : t('offline.cacheBody', { time })}
        </ToastBody>
      </Toast>,
      { toastId: TOAST_ID, timeout: 6000 },
    )
    return () => dismissToast(TOAST_ID)
  }, [active, cachedAt, partial, t, dispatchToast, dismissToast])

  if (!active) return null

  return <Toaster toasterId={toasterId} position="top" />
}
