import { useCallback, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Toast,
  ToastBody,
  ToastFooter,
  ToastTitle,
  Toaster,
  useToastController,
} from '@fluentui/react-components'
import V2PrereqNoticeContext from './V2PrereqNoticeContext'
import { useUserNav } from './useUserNav'
import { checkV2Prereq } from '../services/v2PrereqCheck'
import { V2_F95_URL } from '../components/common/prereqPoints'
import { openExternalUrl } from '../utils/externalLinks'

const TOAST_ID = 'v2-prereq-outdated'
// timeout < 0 表示不自动关闭（@fluentui/react-toast 的 Timer 以 timeout < 0 跳过计时器）
const NO_AUTO_DISMISS = -1

/**
 * toast 内容单独成组件，而不是在 dispatchToast 时把 t() 的结果拼成静态 JSX：
 * dispatch 出去的节点只会渲染一次，之后切换界面语言不会重建它。这里让组件
 * 自己 useTranslation()，i18n 的 languageChanged 事件会触发它重渲染，
 * 标题/正文/按钮文案随语言同步变化（不关闭、不丢失已显示的提醒）。
 */
function V2OutdatedToast({ version, onOpenF95, onOpenV2 }) {
  const { t } = useTranslation()
  return (
    <Toast>
      <ToastTitle>{t('mods.v2ToastTitle')}</ToastTitle>
      <ToastBody>{t('mods.v2ToastBody', { version })}</ToastBody>
      <ToastFooter>
        <Button size="small" appearance="primary" onClick={onOpenF95}>
          {t('mods.v2ToastOpenF95')}
        </Button>
        <Button size="small" title={t('mods.v2ToastOpenV2Hint')} onClick={onOpenV2}>
          {t('mods.v2ToastOpenV2')}
        </Button>
      </ToastFooter>
    </Toast>
  )
}

/**
 * v2 前置版本提醒 Provider：挂载在 App 内（需在 UserNavProvider 之内，跳转用 openLocalMods），
 * 自渲染一个右下角 Toaster。
 *
 * 触发点（用户明确要求的两处）：
 *   - 创意工坊详情页点击「安装」
 *   - 侧栏左下角「启动游戏」
 * 两处动作前调用 checkAndNotify()（fire-and-forget，不阻塞动作）：Rust 命令
 * check_v2_prereq_version 读出已安装 dll 的 FileVersion，低于基准（2.4.0）时
 * 弹 toast 并提供「打开 F95 原网站」「打开程序 v2 页面」两个出口。
 *
 * 用固定 toastId 去重：连续点安装/启动不会叠出多条；toast 常驻，直到用户点
 * 任一按钮（或手动关闭）才消失。
 */
export function V2PrereqNoticeProvider({ children }) {
  const { openLocalMods } = useUserNav()
  const toasterId = useId('v2-prereq-toaster')
  const { dispatchToast, dismissToast } = useToastController(toasterId)

  const checkAndNotify = useCallback(async () => {
    try {
      const { outdated, required } = await checkV2Prereq()
      if (!outdated) return
      dispatchToast(
        <V2OutdatedToast
          version={required}
          onOpenF95={() => {
            dismissToast(TOAST_ID)
            openExternalUrl(V2_F95_URL)
          }}
          onOpenV2={() => {
            dismissToast(TOAST_ID)
            openLocalMods('v2')
          }}
        />,
        { toastId: TOAST_ID, intent: 'warning', timeout: NO_AUTO_DISMISS }
      )
    } catch {
      // 检测失败静默：版本提醒是辅助提示，不能打断安装/启动
    }
  }, [dispatchToast, dismissToast, openLocalMods])

  const value = useMemo(() => ({ checkAndNotify }), [checkAndNotify])

  return (
    <V2PrereqNoticeContext.Provider value={value}>
      {children}
      <Toaster toasterId={toasterId} position="bottom-end" />
    </V2PrereqNoticeContext.Provider>
  )
}
