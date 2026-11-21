import { useEffect, useState } from 'react'
import { Button, Card, CardHeader, Field, Input, MessageBar, MessageBarBody, Select, Text, Title2, makeStyles, tokens } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { F95SettingsRow } from './F95SettingsRow'

const useStyles = makeStyles({
  body: { display: 'grid', gap: tokens.spacingVerticalM, padding: '8px' },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
})

export function F95TranslationSettings({ showTitle = true, inline = false }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const [config, setConfig] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    let active = true
    invoke('f95_translation_settings').then(result => {
      if (active) setConfig(result)
    }).catch(reason => {
      if (active) setMessage({ error: String(reason) })
    })
    return () => { active = false }
  }, [])

  function change(field, value) {
    setConfig(previous => ({ ...previous, [field]: value }))
    setDirty(true)
    setMessage(null)
  }

  async function save(clearKey = false) {
    setBusy(true)
    setMessage(null)
    try {
      const result = await invoke('f95_save_translation_settings', {
        endpoint: config.endpoint, model: config.model, language: config.language,
        apiKey: apiKey.trim() || null, clearKey,
      })
      setConfig(result)
      setApiKey('')
      setDirty(false)
      setMessage({ status: 'saved' })
    } catch (reason) {
      setMessage({ error: String(reason) })
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setBusy(true)
    setMessage(null)
    try {
      await invoke('f95_test_translation')
      setMessage({ status: 'connected' })
    } catch (reason) {
      setMessage({ error: String(reason) })
    } finally {
      setBusy(false)
    }
  }

  const body = (
      <div className={styles.body} style={inline ? { padding: 0, minWidth: 0 } : undefined}>
        {config && <>
          <Field label={t('f95.translation.endpoint')} required>
            <Input size={inline ? "small" : "medium"} value={config.endpoint} disabled={busy} onChange={(_, data) => change('endpoint', data.value)} />
          </Field>
          <Field label={t('f95.translation.model')} required>
            <Input size={inline ? "small" : "medium"} value={config.model} disabled={busy} onChange={(_, data) => change('model', data.value)} />
          </Field>
          <Field label={t('f95.translation.language')}>
            <Select size={inline ? "small" : "medium"} value={config.language} disabled={busy} onChange={(_, data) => change('language', data.value)}>
              <option value="zh-CN">简体中文</option>
              <option value="zh-TW">繁體中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
            </Select>
          </Field>
          <Field label={t('f95.translation.apiKey')} hint={config.hasKey ? t('f95.translation.hasKey') : undefined}>
            <Input size={inline ? "small" : "medium"} type="password" autoComplete="new-password" disabled={busy} value={apiKey}
              onChange={(_, data) => { setApiKey(data.value); setDirty(true); setMessage(null) }} />
          </Field>
          <Text size="small">{t('f95.translation.serviceNote')}</Text>
          <div className={styles.actions}>
            <Button size="small" appearance="primary" disabled={busy || !dirty} onClick={() => save()}>
              {t('f95.translation.save')}
            </Button>
            <Button size="small" disabled={busy || dirty} onClick={test}>
              {t('f95.translation.test')}
            </Button>
            {config.hasKey && <Button size="small" disabled={busy} onClick={() => save(true)}>
              {t('f95.translation.clearKey')}
            </Button>}
          </div>
        </>}
        {message && <MessageBar intent={message.error ? 'error' : 'success'}><MessageBarBody>
          {message.error ? t('f95.translation.errors.' + message.error, { defaultValue: t('f95.translation.errors.generic') })
            : t('f95.translation.' + message.status)}
        </MessageBarBody></MessageBar>}
      </div>
  )

  if (inline) return <F95SettingsRow title={t('f95.translation.settingsTitle')}>{body}</F95SettingsRow>

  return (
    <Card appearance="outline">
      {showTitle && <CardHeader header={<Title2>{t('f95.translation.settingsTitle')}</Title2>} />}
      {body}
    </Card>
  )
}
