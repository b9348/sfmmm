import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Badge, Avatar,
  makeStyles, tokens,
  Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogTrigger, DialogActions, Textarea, Select,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular, ArrowDownload24Regular,
  Edit24Regular, Add24Regular, Delete24Regular,
} from '@fluentui/react-icons'
import { installMod, uninstallMod } from '../../services/installMod'
import { RichTextContent, MarkdownContent } from '../../components/common/RichTextEditor'
import { invoke } from '@tauri-apps/api/core'
import { useAuth } from '../../contexts/AuthContext'
import { submitApplication } from '../../services/workshopApi'
import CommentSection from './CommentSection'
import Database from '@tauri-apps/plugin-sql'

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

export default function ModDetailPage({ mod, onBack, onEdit, scrollToCommentId }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user } = useAuth()
  const perms = mod.user_permissions || {}
  const [installingLang, setInstallingLang] = useState('')
  const [installError, setInstallError] = useState('')
  const [installedDir, setInstalledDir] = useState('')
  const [isInstalled, setIsInstalled] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [uninstallError, setUninstallError] = useState('')
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  const [applyScope, setApplyScope] = useState('lang_all')
  const [applyReason, setApplyReason] = useState('')
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    const checkInstalled = async () => {
      try {
        const db = await Database.load('sqlite:config.db')
        const rows = await db.select(
          'SELECT id FROM installed_workshop_mods WHERE mod_key = $1',
          [mod.mod_key]
        )
        setIsInstalled(rows.length > 0)
      } catch (e) {
        console.warn('[ModDetailPage] 查询安装状态失败:', e)
      }
    }
    checkInstalled()
  }, [mod.mod_key])

  const handleApply = async () => {
    if (!user) return
    setApplying(true)
    try {
      await submitApplication({
        mod_id: mod.id,
        user_id: user.user_id,
        scope: applyScope,
        reason: applyReason || null,
      })
      setApplyOpen(false)
      setApplyReason('')
      setApplyScope('lang_all')
    } catch (e) {
      console.error('Apply failed', e)
    } finally {
      setApplying(false)
    }
  }

  const handleInstall = async (file) => {
    setInstallError('')
    setInstallingLang(file.lang_code)
    try {
      const result = await installMod({
        modKey: mod.mod_key,
        category: mod.category,
        fileUrl: file.file_url,
        version: file.version,
        fileHash: file.file_hash,
        langCode: file.lang_code,
        manifest: file.manifest,
      })
      setInstalledDir(result.targetDir)
      setIsInstalled(true)
    } catch (e) {
      setInstallError(e.message)
    } finally {
      setInstallingLang('')
    }
  }

  const handleUninstall = async () => {
    setUninstallError('')
    setUninstalling(true)
    try {
      await uninstallMod({ modKey: mod.mod_key })
      setIsInstalled(false)
      setConfirmUninstall(false)
      setInstalledDir('')
    } catch (e) {
      setUninstallError(e.message)
    } finally {
      setUninstalling(false)
    }
  }

  return (
    <div className={styles.root}>
        <div className={styles.toolbarRow}>
        <Button size="small" icon={<ArrowLeft24Regular />} appearance="subtle" onClick={onBack}>{t('workshop.back')}</Button>
        <Text weight="semibold">{mod.mod_key}</Text>
      </div>
      <div className={styles.detailSection}>
        <div className={styles.authorRow}>
          <Avatar name={mod.author_name} size={24} />
          <Text size="small">{mod.author_name}</Text>
          {mod.category && (
            <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
              {t(`workshop.category_${mod.category}`)}
            </Badge>
          )}
        </div>
        {user && (perms.can_edit_mod_info || perms.can_edit_all_langs || (perms.editable_langs && perms.editable_langs.length > 0)) && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button size="small" icon={<Edit24Regular />} appearance="primary" onClick={() => onEdit?.(mod)}>
              {t('workshop.edit')}
            </Button>
          </div>
        )}
        {user && (perms.can_apply_mod_info || perms.can_apply_lang) && (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button size="small" icon={<Add24Regular />} appearance="outline" onClick={() => setApplyOpen(true)}>
              {t('workshop.applyToEdit')}
            </Button>
          </div>
        )}
        {mod.description && (
          <Text size="small" style={{ lineHeight: '1.6' }}>{mod.description}</Text>
        )}
        {mod.instructions && (
          <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '8px' }}>
            <Text size="small" weight="semibold" block style={{ marginBottom: '8px' }}>{t('workshop.detailedDesc')}</Text>
            {(mod.instructions_format || 'markdown') === 'richtext'
              ? <RichTextContent html={mod.instructions} />
              : <MarkdownContent markdown={mod.instructions} />}
          </div>
        )}
        {mod.download_count > 0 && (
          <div className={styles.stats}>
            <ArrowDownload24Regular style={{ fontSize: '14px' }} />
            <Text size="small">{t('workshop.downloadCount', { count: mod.download_count })}</Text>
          </div>
        )}
        {mod.files && mod.files.length > 0 && (
          <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '8px' }}>
            <Text size="small" weight="semibold" block style={{ marginBottom: '8px' }}>{t('workshop.availableVersions')}</Text>
            {mod.files.map(f => {
              const langName = mod.translations?.[f.lang_code]?.name || mod.display_name
              return (
              <div key={f.lang_code} className={styles.fileRow}>
                <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>{LANG_LABELS[f.lang_code] || f.lang_code}</Badge>
                <Text size="small" truncate>{langName}</Text>
                {f.file_name && <Text size="small" truncate className={styles.meta} style={{ flex: '0 1 auto', maxWidth: '160px' }}>{f.file_name}</Text>}
                <Text size="small">v{f.version}</Text>
                <Text size="small" className={styles.meta}>{(f.file_size / 1024).toFixed(1)}KB</Text>
                <Button
                  size="small"
                  icon={<ArrowDownload24Regular />}
                  appearance={isInstalled ? 'outline' : 'primary'}
                  disabled={installingLang === f.lang_code}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleInstall(f)
                  }}
                >
{isInstalled ? t('workshop.reinstall') : installingLang === f.lang_code ? t('workshop.installing') : t('workshop.install')}
                </Button>
                {isInstalled && (
                  <Button
                    size="small"
                    icon={<Delete24Regular />}
                    appearance="subtle"
                    disabled={uninstalling}
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmUninstall(true)
                    }}
                  >
                    {t('workshop.uninstall')}
                  </Button>
                )}
                <Text size="small" className={styles.meta}>{f.file_hash?.slice(0, 8)}</Text>
                <div style={{ flex: 1 }} />
              </div>
            )})}
          </div>
        )}
        {installedDir && (
          <div style={{ padding: '8px', background: tokens.colorPaletteGreenBackground1, borderRadius: '4px' }}>
            <Text size="small" style={{ color: tokens.colorPaletteGreenForeground1 }}>
              {t('workshop.installSuccess')}{installedDir}
            </Text>
            <Button size="small" appearance="subtle" style={{ marginLeft: '8px' }} onClick={() => invoke('open_folder', { path: installedDir })}>
              {t('workshop.openDir')}
            </Button>
          </div>
        )}
        {installError && (
          <div style={{ padding: '8px', background: tokens.colorPaletteRedBackground1, borderRadius: '4px' }}>
            <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{installError}</Text>
          </div>
        )}
        {uninstallError && (
          <div style={{ padding: '8px', background: tokens.colorPaletteRedBackground1, borderRadius: '4px' }}>
            <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{uninstallError}</Text>
          </div>
        )}
        <CommentSection modId={mod.id} scrollToCommentId={scrollToCommentId} />
      </div>

      <Dialog open={applyOpen} onOpenChange={(_, { open }) => !open && setApplyOpen(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('workshop.applyToEdit')}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                <Select size="small" value={applyScope} onChange={(_, d) => setApplyScope(d.value)}>
                  <option value="mod_info">{t('workshop.scopeModInfo')}</option>
                  <option value="lang_all">{t('workshop.scopeLangAll')}</option>
                  <option value="lang_specific">{t('workshop.scopeLangSpecific')}</option>
                </Select>
                <Textarea
                  size="small"
                  placeholder={t('workshop.applyReasonPlaceholder')}
                  value={applyReason}
                  onChange={(_, d) => setApplyReason(d.value)}
                />
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button size="small" appearance="subtle">{t('workshop.cancel')}</Button>
              </DialogTrigger>
              <Button size="small" appearance="primary" onClick={handleApply} disabled={applying}>
                {applying ? t('workshop.processing') : t('workshop.submit')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={confirmUninstall} onOpenChange={(_, { open }) => !open && setConfirmUninstall(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('workshop.confirmUninstall')}</DialogTitle>
            <DialogContent>
              <Text size="small">{t('workshop.uninstallHint')}</Text>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button size="small" appearance="subtle">{t('workshop.cancel')}</Button>
              </DialogTrigger>
              <Button size="small" appearance="primary" onClick={handleUninstall} disabled={uninstalling}>
                {uninstalling ? t('workshop.processing') : t('workshop.uninstall')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
