import { useEffect, useRef, useState } from 'react'
import { Button, MessageBar, MessageBarBody, Spinner, Switch, makeStyles, tokens } from '@fluentui/react-components'
import { Channel, invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { createTranslationLayout } from './translationLayout'

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM, marginBlockEnd: tokens.spacingVerticalM,
  },
})

export function F95TranslatedPost({ postId, children }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const source = useRef(null)
  const layout = useRef(null)
  const request = useRef(null)
  const [count, setCount] = useState(0)
  const [total, setTotal] = useState(0)
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const view = createTranslationLayout().collect(source.current)
    layout.current = view
    const received = new Set()
    let active = true
    const accept = batch => {
      if (!active) return
      view.render(batch)
      batch.forEach(part => received.add(part.id))
      setCount(received.size)
    }
    view.accept = accept
    view.show(false)
    Promise.resolve().then(async () => {
      if (!active) return
      setTotal(view.parts.length)
      if (view.parts.length) accept(await invoke('f95_cached_translation', { postId, parts: view.parts }))
    }).catch(reason => {
      if (active) setError(String(reason))
    })
    return () => {
      active = false
      request.current = null
      layout.current = null
      view.clear()
    }
  }, [postId])

  async function translatePost() {
    const view = layout.current
    if (!view?.parts.length || request.current) return
    setBusy(true)
    setError(null)
    setShown(true)
    view.show(true)
    const progress = new Channel(batch => {
      if (request.current === progress) view.accept(batch)
    })
    request.current = progress
    try {
      await invoke('f95_translate_post', { postId, parts: view.parts, onProgress: progress })
    } catch (reason) {
      if (request.current === progress) setError(String(reason))
    } finally {
      if (request.current === progress) {
        request.current = null
        setBusy(false)
      }
    }
  }

  return (
    <>
      <div className={styles.toolbar}>
        {count < total && (
          <Button size="small" disabled={busy} onClick={translatePost}>
            {t(count ? 'f95.translation.continue' : 'f95.translation.translate')}
          </Button>
        )}
        {count > 0 && <Switch
          label={t('f95.translation.show')}
          checked={shown}
          onChange={(_, data) => { setShown(data.checked); layout.current?.show(data.checked) }}
        />}
        {busy && <Spinner size="tiny" label={t('f95.translation.progress', { count, total })} />}
      </div>
      {error && <MessageBar intent="error"><MessageBarBody>
        {t('f95.translation.errors.' + error, { defaultValue: t('f95.translation.errors.generic') })}
      </MessageBarBody></MessageBar>}
      <div ref={source}>{children}</div>
    </>
  )
}
