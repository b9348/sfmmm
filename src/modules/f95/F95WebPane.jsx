import { useEffect, useRef, useState } from 'react'
import { Button, makeStyles, MessageBar, MessageBarBody, Spinner, tokens } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'

const useStyles = makeStyles({
  root: { display: 'flex', flex: '1 1 auto', minHeight: 0, flexDirection: 'column', gap: tokens.spacingVerticalS },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  site: {
    flex: '1 1 auto', minHeight: 0, minWidth: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'grid', placeItems: 'center',
  },
})

// React may unmount this reader before WebView2 finishes starting.
// Order destruction before any following reader on another tab is opened.
let readerQueue = Promise.resolve()
function queueReader(command, args) {
  const operation = readerQueue.then(() => invoke(command, args))
  readerQueue = operation.catch(() => {})
  return operation
}

function readerBounds(element) {
  const rect = element.getBoundingClientRect()
  const x = Math.max(0, Math.ceil(rect.left))
  const y = Math.max(0, Math.ceil(rect.top))
  return {
    x, y,
    width: Math.max(0, Math.floor(Math.min(window.innerWidth, rect.right)) - x),
    height: Math.max(0, Math.floor(Math.min(window.innerHeight, rect.bottom)) - y),
  }
}

export function F95WebPane({ target, accountMode }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const site = useRef(null)
  const [mounting, setMounting] = useState(true)
  const [openError, setOpenError] = useState(null)
  const [translationError, setTranslationError] = useState(null)
  const [translating, setTranslating] = useState(false)

  useEffect(() => {
    const element = site.current
    const account = Boolean(accountMode)
    let active = true
    let opened = false
    let frame = 0
    let lastBounds = ''
    const refresh = () => {
      if (!opened || !active || frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const bounds = readerBounds(element)
        const key = JSON.stringify(bounds)
        if (key === lastBounds) return
        lastBounds = key
        queueReader('f95_position_reader', { bounds, account }).catch(reason => {
          if (active) setOpenError(String(reason))
        })
      })
    }
    const observer = new ResizeObserver(refresh)
    observer.observe(element)
    window.addEventListener('resize', refresh)
    window.addEventListener('scroll', refresh, true)
    const bounds = readerBounds(element)
    const opening = account
      ? queueReader('f95_open_account', { register: accountMode === 'register', bounds })
      : queueReader('f95_open_reader', { target, bounds })
    opening.then(() => {
      if (!active) return
      opened = true
      setMounting(false)
      refresh()
    }).catch(reason => {
      if (!active) return
      setMounting(false)
      setOpenError(String(reason))
    })
    return () => {
      active = false
      observer.disconnect()
      window.removeEventListener('resize', refresh)
      window.removeEventListener('scroll', refresh, true)
      if (frame) cancelAnimationFrame(frame)
      queueReader('f95_close_reader', { account }).catch(reason => console.warn('F95 reader close failed:', reason))
    }
  }, [accountMode, target])

  async function translate(toggle) {
    setTranslationError(null)
    if (!toggle) setTranslating(true)
    try {
      await invoke('f95_translate_reader', { toggle })
    } catch (reason) {
      setTranslationError(String(reason))
    } finally {
      if (!toggle) setTranslating(false)
    }
  }

  return (
    <div className={styles.root}>
      {!accountMode && <div className={styles.actions}>
        <Button size="small" disabled={mounting || Boolean(openError) || translating} onClick={() => translate(false)}>
          {t('f95.translation.liveTranslate')}
        </Button>
        <Button size="small" disabled={mounting || Boolean(openError) || translating} onClick={() => translate(true)}>
          {t('f95.translation.liveToggle')}
        </Button>
        {translating && <Spinner size="tiny" label={t('f95.translation.liveProgress')} />}
      </div>}
      {openError && <MessageBar intent="error"><MessageBarBody>
        {t('f95.errors.' + openError, { defaultValue: t(accountMode ? 'f95.errors.windowOpen' : 'f95.errors.postOpen') })}
      </MessageBarBody></MessageBar>}
      {translationError && <MessageBar intent="error"><MessageBarBody>
        {t('f95.translation.errors.' + translationError, { defaultValue: t('f95.translation.errors.generic') })}
      </MessageBarBody></MessageBar>}
      <div ref={site} className={styles.site} data-f95-reader-site="">
        {mounting && <Spinner size="small" label={t(accountMode ? 'f95.webLoginLoading' : 'f95.originalLoading')} />}
      </div>
    </div>
  )
}
