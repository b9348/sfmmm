import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  CardHeader,
  Text,
  Title2,
  Button,
  Input,
  Spinner,
  Select,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  ArrowSync24Regular,
  ArrowDownload24Regular,
} from '@fluentui/react-icons'
import { makeStyles, tokens } from '@fluentui/react-components'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import Database from '@tauri-apps/plugin-sql'
import i18n from '../../i18n'
import { checkVersion } from '../../services/updateApi'
import APP_VERSION from '../../version.js'

const useStyles = makeStyles({
  formGrid: {
    display: 'grid',
    gridTemplateColumns: '100px 1fr',
    gap: '6px 12px',
    alignItems: 'center',
  },
  formLabel: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  updateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '4px 0',
  },
  updateInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  currentTag: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '2px 8px',
    borderRadius: '4px',
  },
  newTag: {
    fontSize: '12px',
    fontWeight: '600',
    color: tokens.colorPaletteRedForeground1,
    backgroundColor: tokens.colorPaletteRedBackground1,
    padding: '2px 8px',
    borderRadius: '4px',
  },
  noUpdate: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
})

export function GameSettings({ config, onConfigChange }) {
  const { t, i18n: i18nInstance } = useTranslation()
  const styles = useStyles()
  const [gamePath, setGamePath] = useState(config?.game_path || '')
  const [language, setLanguage] = useState(config?.language || i18nInstance.language || 'zh')
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState(null)

  const browseGameFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t('settings.selectDialogTitle'),
    })
    if (selected) {
      setGamePath(selected)
      await saveConfig({ game_path: selected })
    }
  }

  const openGameFolder = async () => {
    if (gamePath) {
      await invoke('open_folder', { path: gamePath })
    }
  }

  const saveConfig = async (updates) => {
    try {
      const db = await Database.load('sqlite:config.db')
      for (const [key, value] of Object.entries(updates)) {
        await db.execute(
          `INSERT OR REPLACE INTO config (id, ` + "`key`" + `, value) VALUES (
            (SELECT id FROM config WHERE ` + "`key`" + ` = $1),
            $1, $2
          )`,
          [key, String(value)]
        )
      }
      onConfigChange?.(updates)
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }

  const handleCheckUpdate = async () => {
    setChecking(true)
    setUpdateInfo(null)
    try {
      const info = await checkVersion(APP_VERSION)
      setUpdateInfo(info)
    } catch (e) {
      console.error('[Update] 检测失败:', e)
      setUpdateInfo({ hasUpdate: false, error: e.message })
    } finally {
      setChecking(false)
    }
  }

  const handleDownloadUpdate = () => {
    if (updateInfo?.updateUrl) {
      openUrl(updateInfo.updateUrl)
    }
  }

  const languageOptions = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Card appearance="outline">
        <CardHeader header={<Title2>{t('settings.language')}</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>{t('settings.language')}</Text>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <Select value={language} onChange={(e) => {
                const newLang = e.target.value
                setLanguage(newLang)
                i18n.changeLanguage(newLang)
                saveConfig({ language: newLang })
              }} style={{ flex: 1 }}>
                {languageOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </Select>
            </div>
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            {t('settings.languageDesc')}
          </Text>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>{t('settings.gamePath')}</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>{t('settings.gameDir')}</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input
                size="small"
                value={gamePath}
                placeholder={t('settings.selectGameDir')}
                style={{ flex: 1 }}
              />
              <Button size="small" icon={<Folder24Regular />} onClick={browseGameFolder}>{t('settings.change')}</Button>
              <Button size="small" icon={<Folder24Regular />} onClick={openGameFolder}>{t('settings.openGameDir')}</Button>
            </div>
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
          {t('settings.changeHint')}
          </Text>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>{t('settings.updateTitle')}</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.updateRow}>
            <Button
              size="small"
              icon={checking ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
              onClick={handleCheckUpdate}
              disabled={checking}
            >
{checking ? t('settings.checking') : t('settings.checkUpdateBtn')}
            </Button>
            {updateInfo && (
              <div className={styles.updateInfo}>
                {updateInfo.hasUpdate ? (
                  <>
                    <span className={styles.currentTag}>v{APP_VERSION}</span>
                    <Text>→</Text>
                    <span className={styles.newTag}>v{updateInfo.latestVersion}</span>
                    <Button
                      size="small"
                      appearance="primary"
                      icon={<ArrowDownload24Regular />}
                      onClick={handleDownloadUpdate}
                    >
                      {t('settings.downloadUpdate')}
                    </Button>
                  </>
                ) : updateInfo.error ? (
                  <Text className={styles.noUpdate}>{t('settings.checkFailed', { msg: updateInfo.error })}</Text>
                ) : (
                  <span className={styles.noUpdate}>{t('settings.alreadyLatest')}</span>
                )}
              </div>
            )}
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            {t('settings.currentVersion', { version: APP_VERSION })}
          </Text>
        </div>
      </Card>
    </div>
  )
}
