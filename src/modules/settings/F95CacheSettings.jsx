import { useEffect, useState } from 'react'
import { Button, Card, CardHeader, Checkbox, Input, MessageBar, MessageBarBody, Text, Title2, makeStyles, tokens } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useTranslation } from 'react-i18next'
import { F95SettingsRow } from './F95SettingsRow'

const useStyles = makeStyles({
  body: { display: 'grid', gap: tokens.spacingVerticalS, padding: '8px' },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
})

export function F95CacheSettings({ inline = false } = {}) {
  const { t } = useTranslation()
  const styles = useStyles()
  const [location, setLocation] = useState(null)
  const [migrate, setMigrate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    let active = true
    invoke('f95_cache_location').then(result => {
      if (active) setLocation(result)
    }).catch(reason => {
      if (active) setMessage({ error: String(reason) })
    })
    return () => { active = false }
  }, [])

  async function changeLocation(restoreDefault) {
    setBusy(true)
    setMessage(null)
    try {
      const directory = restoreDefault ? null : await open({ directory: true, multiple: false })
      if (!restoreDefault && !directory) return
      const result = await invoke('f95_set_cache_location', { directory, migrate })
      setLocation(result)
      setMessage({ status: result.sourceRetained ? 'cacheSourceRetained' : 'cacheLocationSaved' })
    } catch (reason) {
      setMessage({ error: String(reason) })
    } finally {
      setBusy(false)
    }
  }

  const body = (
      <div className={styles.body} style={inline ? { padding: 0, minWidth: 0 } : undefined}>
        <Input size="small" aria-label={t('f95.cacheLocationTitle')} readOnly value={location?.directory ?? ''} />
        {location && <Text size="small">{t('f95.cacheDefaultDirectory', { directory: location.defaultDirectory })}</Text>}
        <div className={styles.actions}>
          <Button size="small" disabled={busy || !location} onClick={() => changeLocation(false)}>{t('f95.chooseCacheDirectory')}</Button>
          <Button size="small" disabled={busy || !location || location.directory === location.defaultDirectory} onClick={() => changeLocation(true)}>
            {t('f95.restoreCacheDirectory')}
          </Button>
          <Checkbox checked={migrate} disabled={busy} onChange={(_, data) => setMigrate(data.checked === true)} label={t('f95.moveCachedPosts')} />
        </div>
        {message && (
          <MessageBar intent={message.error ? 'error' : 'info'}>
            <MessageBarBody>
              {message.error ? t(`f95.errors.${message.error}`, { defaultValue: t('f95.errors.cacheWrite') }) : t(`f95.${message.status}`)}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>
  )

  if (inline) return <F95SettingsRow title={t('f95.cacheLocationTitle')}>{body}</F95SettingsRow>

  return (
    <Card appearance="outline">
      <CardHeader header={<Title2>{t('f95.cacheLocationTitle')}</Title2>} />
      {body}
    </Card>
  )
}
