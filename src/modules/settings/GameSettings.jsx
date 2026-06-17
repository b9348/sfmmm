import { useState } from 'react'
import {
  Card,
  CardHeader,
  Text,
  Title2,
  Button,
  Input,
  Spinner,
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
import { checkVersion } from '../../services/updateApi'

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

const CURRENT_VERSION = '0.1.0'

export function GameSettings({ config, onConfigChange }) {
  const styles = useStyles()
  const [gamePath, setGamePath] = useState(config?.game_path || '')
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState(null)

  const browseGameFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: '选择游戏目录',
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
      const info = await checkVersion(CURRENT_VERSION)
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Card appearance="outline">
        <CardHeader header={<Title2>游戏路径</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.formGrid}>
            <Text className={styles.formLabel}>游戏目录</Text>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Input
                size="small"
                value={gamePath}
                placeholder="请选择游戏目录"
                style={{ flex: 1 }}
              />
              <Button size="small" icon={<Folder24Regular />} onClick={browseGameFolder}>更改</Button>
              <Button size="small" icon={<Folder24Regular />} onClick={openGameFolder}>打开游戏目录</Button>
            </div>
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            可自行变更游戏目录位置
          </Text>
        </div>
      </Card>

      <Card appearance="outline">
        <CardHeader header={<Title2>检查更新</Title2>} />
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className={styles.updateRow}>
            <Button
              size="small"
              icon={checking ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
              onClick={handleCheckUpdate}
              disabled={checking}
            >
              {checking ? '检查中...' : '检测更新'}
            </Button>
            {updateInfo && (
              <div className={styles.updateInfo}>
                {updateInfo.hasUpdate ? (
                  <>
                    <span className={styles.currentTag}>v{CURRENT_VERSION}</span>
                    <Text>→</Text>
                    <span className={styles.newTag}>v{updateInfo.latestVersion}</span>
                    <Button
                      size="small"
                      appearance="primary"
                      icon={<ArrowDownload24Regular />}
                      onClick={handleDownloadUpdate}
                    >
                      下载更新
                    </Button>
                  </>
                ) : updateInfo.error ? (
                  <Text className={styles.noUpdate}>检测失败：{updateInfo.error}</Text>
                ) : (
                  <span className={styles.noUpdate}>当前已是最新版本</span>
                )}
              </div>
            )}
          </div>
          <Text size="small" style={{ color: tokens.colorNeutralForeground3 }}>
            当前版本：v{CURRENT_VERSION}，点击"检测更新"从服务器获取最新版本
          </Text>
        </div>
      </Card>
    </div>
  )
}
