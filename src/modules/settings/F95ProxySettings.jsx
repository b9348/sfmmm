import { useEffect, useState } from 'react'
import { Button, Card, CardHeader, Field, Input, MessageBar, MessageBarBody, Text, Title2, makeStyles, tokens } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { F95SettingsRow } from './F95SettingsRow'

const useStyles = makeStyles({
  body: { display: 'grid', gap: tokens.spacingVerticalM, padding: '8px' },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
})

export function F95ProxySettings({ showTitle = true, inline = false }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const [config, setConfig] = useState(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    let active = true
    invoke('f95_proxy_settings').then(result => {
      if (!active) return
      setConfig(result)
      setHost(result?.host ?? '')
      setPort(result?.port != null ? String(result.port) : '')
    }).catch(reason => {
      if (active) setMessage({ error: String(reason) })
    })
    return () => { active = false }
  }, [])

  function change(field, value) {
    if (field === 'host') setHost(value)
    else setPort(value)
    setDirty(true)
    setMessage(null)
  }

  async function save(clear = false) {
    setBusy(true)
    setMessage(null)
    try {
      const result = await invoke('f95_save_proxy_settings', {
        host: clear ? null : host.trim() || null,
        port: clear ? null : port.trim() || null,
      })
      setConfig(result)
      setHost(result?.host ?? '')
      setPort(result?.port != null ? String(result.port) : '')
      setDirty(false)
      setMessage({ status: clear ? 'cleared' : 'saved' })
    } catch (reason) {
      setMessage({ error: String(reason) })
    } finally {
      setBusy(false)
    }
  }

  const body = (
    <div className={styles.body} style={inline ? { padding: 0, minWidth: 0 } : undefined}>
      <Field label={t('f95.proxy.host')}>
        <Input size={inline ? 'small' : 'medium'} value={host} disabled={busy}
          placeholder="proxy.example.com" onChange={(_, data) => change('host', data.value)} />
      </Field>
      <Field label={t('f95.proxy.port')}>
        <Input size={inline ? 'small' : 'medium'} value={port} disabled={busy}
          placeholder="8080" inputMode="numeric" onChange={(_, data) => change('port', data.value)} />
      </Field>
      <Text size="small">{t('f95.proxy.note')}</Text>
      <div className={styles.actions}>
        <Button size="small" appearance="primary" disabled={busy || !dirty} onClick={() => save(false)}>
          {t('f95.proxy.save')}
        </Button>
        <Button size="small" disabled={busy || !config} onClick={() => save(true)}>
          {t('f95.proxy.clear')}
        </Button>
      </div>
      {message && (
        <MessageBar intent={message.error ? 'error' : 'success'}>
          <MessageBarBody>
            {message.error
              ? t('f95.proxy.errors.' + message.error, { defaultValue: t('f95.proxy.errors.generic') })
              : t('f95.proxy.' + message.status)}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  )

  if (inline) return <F95SettingsRow title={t('f95.proxy.settingsTitle')}>{body}</F95SettingsRow>

  return (
    <Card appearance="outline">
      {showTitle && <CardHeader header={<Title2>{t('f95.proxy.settingsTitle')}</Title2>} />}
      {body}
    </Card>
  )
}
