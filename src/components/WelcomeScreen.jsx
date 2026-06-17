import { useState } from 'react'
import {
  Card,
  CardHeader,
  Text,
  Title2,
  Button,
  Input,
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
  const styles = useStyles()
  const [gamePath, setGamePath] = useState('')
  const [error, setError] = useState('')

  const validateAndSave = async () => {
    if (!gamePath) {
      setError('请选择游戏目录')
      return
    }

    const exePath = gamePath.replace(/\\+$/, '') + '\\SecretFlasherManaka.exe'

    const exeExists = await exists(exePath)
    if (!exeExists) {
      setError('未找到 SecretFlasherManaka.exe，请确认选择的是游戏根目录')
      return
    }

    try {
      const db = await Database.load('sqlite:config.db')

      await db.execute(
        `DELETE FROM config WHERE ` + "`key`" + ` IN ('game_path', 'exe_path', 'initialized')`
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

      onComplete({ game_path: gamePath, exe_path: exePath, initialized: 'true' })
    } catch (e) {
      setError('保存配置失败: ' + (e?.message || String(e)))
    }
  }

  const browseGameFolder = async () => {
    try {
      console.log('[WelcomeScreen] Opening folder dialog...')
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择包含 SecretFlasherManaka.exe 的游戏目录',
      })
      console.log('[WelcomeScreen] Selected:', selected)
      if (selected) {
        setGamePath(selected)
        setError('')
      }
    } catch (e) {
      console.error('[WelcomeScreen] Dialog error:', e)
      setError('打开文件夹选择器失败: ' + (e?.message || String(e)))
    }
  }

  return (
    <div className={styles.container}>
      <Settings24Regular className={styles.iconLarge} />

      <Text size={400} weight="semibold">
        欢迎使用 SFMMM
      </Text>

      <Card className={styles.card}>
        <CardHeader header={<Title2>首次设置</Title2>} />

        <div style={{ padding: '12px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>游戏目录</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input
                size="small"
                value={gamePath}
                placeholder="选择游戏文件夹"
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
            请选择包含 SecretFlasherManaka.exe 的文件夹
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
              开始使用
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}