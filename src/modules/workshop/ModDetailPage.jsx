import { useState } from 'react'
import {
  Card, CardHeader, Text, Button, Badge, Avatar,
  makeStyles, tokens, Spinner,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular, ArrowDownload24Regular,
} from '@fluentui/react-icons'
import { installMod } from '../../services/installMod'
import { RichTextContent, MarkdownContent } from '../../components/common/RichTextEditor'
import { invoke } from '@tauri-apps/api/core'
import CommentSection from './CommentSection'

const CATEGORIES = [
  { value: 'v1', label: 'v1 任务' },
  { value: 'v2', label: 'v2 任务' },
  { value: 'dll', label: 'DLL 模组' },
  { value: 'folder', label: '文件夹模组' },
]

const LANG_LABELS = { zh: '中文', en: 'English', ja: '日本語' }

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    height: '100%',
    overflow: 'auto',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  detailSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  authorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  stats: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  fileRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 0',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export default function ModDetailPage({ mod, onBack }) {
  const styles = useStyles()
  const [installingLang, setInstallingLang] = useState('')
  const [installError, setInstallError] = useState('')
  const [installedDir, setInstalledDir] = useState('')

  const handleInstall = async (file) => {
    setInstallError('')
    setInstallingLang(file.lang_code)
    try {
      const result = await installMod({
        modKey: mod.mod_key,
        category: mod.category,
        fileUrl: file.file_url,
        version: file.version || mod.version,
        fileHash: file.file_hash,
      })
      setInstalledDir(result.targetDir)
    } catch (e) {
      setInstallError(e.message)
    } finally {
      setInstallingLang('')
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbarRow}>
        <Button size="small" icon={<ArrowLeft24Regular />} appearance="subtle" onClick={onBack}>返回</Button>
        <Text weight="semibold">{mod.display_name}</Text>
      </div>
      <div className={styles.detailSection}>
        <div className={styles.authorRow}>
          <Avatar name={mod.author_name} size={24} />
          <Text size="small">{mod.author_name}</Text>
          {mod.category && (
            <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
              {CATEGORIES.find(c => c.value === mod.category)?.label || mod.category}
            </Badge>
          )}
        </div>
        {mod.description && (
          <Text size="small" style={{ lineHeight: '1.6' }}>{mod.description}</Text>
        )}
        {mod.instructions && (
          <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '8px' }}>
            <Text size="small" weight="semibold" block style={{ marginBottom: '8px' }}>详细说明</Text>
            {(mod.instructions_format || 'markdown') === 'richtext'
              ? <RichTextContent html={mod.instructions} />
              : <MarkdownContent markdown={mod.instructions} />}
          </div>
        )}
        {mod.download_count > 0 && (
          <div className={styles.stats}>
            <ArrowDownload24Regular style={{ fontSize: '14px' }} />
            <Text size="small">{mod.download_count} 次下载</Text>
          </div>
        )}
        {mod.files && mod.files.length > 0 && (
          <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '8px' }}>
            <Text size="small" weight="semibold" block style={{ marginBottom: '8px' }}>可用版本</Text>
            {mod.files.map(f => (
              <div key={f.lang_code} className={styles.fileRow}>
                <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>{LANG_LABELS[f.lang_code] || f.lang_code}</Badge>
                <Text size="small">v{f.version}</Text>
                <Text size="small" className={styles.meta}>{(f.file_size / 1024).toFixed(1)}KB</Text>
                <Button
                  size="small"
                  icon={<ArrowDownload24Regular />}
                  appearance="primary"
                  disabled={installingLang === f.lang_code}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleInstall(f)
                  }}
                >
                  {installingLang === f.lang_code ? '安装中...' : '安装'}
                </Button>
                <Text size="small" className={styles.meta}>{f.file_hash?.slice(0, 8)}</Text>
                <div style={{ flex: 1 }} />
              </div>
            ))}
          </div>
        )}
        {installedDir && (
          <div style={{ padding: '8px', background: tokens.colorPaletteGreenBackground1, borderRadius: '4px' }}>
            <Text size="small" style={{ color: tokens.colorPaletteGreenForeground1 }}>
              安装成功！位置：{installedDir}
            </Text>
            <Button size="small" appearance="subtle" style={{ marginLeft: '8px' }} onClick={() => invoke('open_folder', { path: installedDir })}>
              打开目录
            </Button>
          </div>
        )}
        {installError && (
          <div style={{ padding: '8px', background: tokens.colorPaletteRedBackground1, borderRadius: '4px' }}>
            <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{installError}</Text>
          </div>
        )}
        <CommentSection modId={mod.id} />
      </div>
    </div>
  )
}
