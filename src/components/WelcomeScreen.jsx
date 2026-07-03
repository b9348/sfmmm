import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  CardHeader,
  Text,
  Title2,
  Button,
  Input,
  Select,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  ArrowRight24Regular,
  Settings24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'
import { open } from '@tauri-apps/plugin-dialog'
import { exists } from '@tauri-apps/plugin-fs'
import Database from '@tauri-apps/plugin-sql'
import i18n, { detectSystemLanguage } from '../i18n'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    gap: '16px',
    padding: '16px',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  card: {
    maxWidth: '400px',
    width: '100%',
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: '80px 1fr',
    gap: '8px',
    alignItems: 'center',
  },
  formLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  hintText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    marginTop: '4px',
  },
  buttonRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '12px',
  },
  iconLarge: {
    fontSize: '32px',
    color: tokens.colorBrandBackground,
  },
})

export function WelcomeScreen({ onComplete }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const savedLang = localStorage.getItem('i18nextLng') || detectSystemLanguage()
  const [gamePath, setGamePath] = useState('')
  const [language, setLanguage] = useState(savedLang)
  const [error, setError] = useState('')

  const validateAndSave = async () => {
    if (!gamePath) {
      setError(t('welcome.errNoGameDir'))
      return
    }

    const exePath = gamePath.replace(/\\+$/, '') + '\\SecretFlasherManaka.exe'

    const exeExists = await exists(exePath)
    if (!exeExists) {
      setError(t('welcome.errExeNotFound'))
      return
    }

    try {
      const db = await Database.load('sqlite:config.db')

      await db.execute(
        `DELETE FROM config WHERE ` + "`key`" + ` IN ('game_path', 'exe_path', 'initialized', 'language')`
      )

      await db.execute(
        `INSERT INTO config (` + "`key`" + `, value) VALUES ($1, $2)`,
        ['game_path', gamePath]
      )
      await db.execute(
        `INSERT INTO config (` + "`key`" + `, value) VALUES ($1, $2)`,
        ['exe_path', exePath]
      )
      await db.execute(
        `INSERT INTO config (` + "`key`" + `, value) VALUES ($1, $2)`,
        ['initialized', 'true']
      )
      await db.execute(
        `INSERT INTO config (` + "`key`" + `, value) VALUES ($1, $2)`,
        ['language', language]
      )

      onComplete({ game_path: gamePath, exe_path: exePath, initialized: 'true', language })
    } catch (e) {
      setError(t('welcome.errSaveFailed') + ': ' + (e?.message || String(e)))
    }
  }

  const browseGameFolder = async () => {
    try {
      console.log('[WelcomeScreen] Opening folder dialog...')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('welcome.selectDialogTitle'),
      })
      console.log('[WelcomeScreen] Selected:', selected)
      if (selected) {
        setGamePath(selected)
        setError('')
      }
    } catch (e) {
      console.error('[WelcomeScreen] Dialog error:', e)
      setError(t('welcome.errDialogFailed', { msg: e?.message || String(e) }))
    }
  }

  const languageOptions = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
  ]

  const handleLanguageChange = (_e, data) => {
    const newLang = data.value
    setLanguage(newLang)
    i18n.changeLanguage(newLang)
  }

  return (
    <div className={styles.container}>
      <Settings24Regular className={styles.iconLarge} />

      <Text size={400} weight="semibold">
        {t('app.welcome')}
      </Text>

      <Card className={styles.card}>
        <CardHeader header={<Title2>{t('app.firstSetup')}</Title2>} />

        <div style={{ padding: '12px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>{t('welcome.languageLabel')}</Text>
            <Select value={language} onChange={(e) => handleLanguageChange(e, { value: e.target.value })}>
              {languageOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          </div>

          <div style={{ height: '12px' }} />

          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>{t('welcome.gameDir')}</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input
                size="small"
                value={gamePath}
                placeholder={t('welcome.selectFolder')}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button
                size="small"
                icon={<Folder24Regular />}
                onClick={browseGameFolder}
              />
            </div>
          </div>

          <Text className={styles.hintText}>
            {t('welcome.selectFolderHint')}
          </Text>

          {error && (
            <Text style={{ color: tokens.colorPaletteRedForeground1, marginTop: '8px' }}>
              {error}
            </Text>
          )}

          <div className={styles.buttonRow}>
            <Button
              appearance="primary"
              icon={<ArrowRight24Regular />}
              iconPosition="after"
              onClick={validateAndSave}
            >
              {t('app.getStarted')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}