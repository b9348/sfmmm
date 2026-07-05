import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Badge, Avatar,
  makeStyles, tokens,
  Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogTrigger, DialogActions, Textarea, Select, Checkbox,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular, ArrowDownload24Regular,
  Edit24Regular, Add24Regular, Delete24Regular,
  Heart24Regular, Heart24Filled,
} from '@fluentui/react-icons'
import { installMod, uninstallMod } from '../../services/installMod'
import { RichTextContent, MarkdownContent } from '../../components/common/RichTextEditor'
import { invoke } from '@tauri-apps/api/core'
import { useAuth } from '../../contexts/useAuth'
import { submitApplication, likeMod, unlikeMod, getDeviceId } from '../../services/workshopApi'
import CommentSection from './CommentSection'
import Database from '@tauri-apps/plugin-sql'

const LANG_LABELS = { zh: '中文', en: 'English', ja: '日本語' }

const LANGUAGES = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
]

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
  fabContainer: {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    alignItems: 'center',
  },
  fabItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
  fabLabel: {
    fontSize: tokens.fontSizeSmall,
    color: tokens.colorNeutralForeground2,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '2px 6px',
    borderRadius: '4px',
    boxShadow: tokens.shadow4,
    whiteSpace: 'nowrap',
  },
})

export default function ModDetailPage({ mod, onBack, onEdit, scrollToCommentId }) {
  const styles = useStyles()
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const deviceIdRef = useRef(getDeviceId())
  const perms = mod.user_permissions || {}
  const canEdit = perms.is_author || perms.can_edit_mod_info || perms.can_edit_all_langs || (perms.editable_langs && perms.editable_langs.length > 0)
  const canApply = perms.can_apply_mod_info || perms.can_apply_lang
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
  const [likeCount, setLikeCount] = useState(mod.like_count || 0)
  const [isLiked, setIsLiked] = useState(!!mod.is_liked)
  const [likeBusy, setLikeBusy] = useState(false)

  useEffect(() => {
    setLikeCount(mod.like_count || 0)
    setIsLiked(!!mod.is_liked)
  }, [mod.id, mod.like_count, mod.is_liked])

  const handleLikeToggle = async () => {
    if (likeBusy) return
    setLikeBusy(true)
    try {
      if (isLiked) {
        const res = await unlikeMod(mod.id, deviceIdRef.current)
        setLikeCount(res.like_count || Math.max((likeCount) - 1, 0))
        setIsLiked(false)
      } else {
        const res = await likeMod(mod.id, deviceIdRef.current)
        setLikeCount(res.like_count || (likeCount + 1))
        setIsLiked(true)
      }
    } catch (e) {
      console.error('Like toggle failed', e)
    } finally {
      setLikeBusy(false)
    }
  }

  const userLang = (i18n.language || 'en').split('-')[0]
  const availableLangs = LANGUAGES.filter(l => mod.translations?.[l.value]?.instructions)
  const defaultLang = availableLangs.find(l => l.value === userLang)?.value || availableLangs[0]?.value
  const [selectedLangs, setSelectedLangs] = useState(defaultLang ? [defaultLang] : [])

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

  const handleLangToggle = (lang) => {
    setSelectedLangs(prev => prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang])
  }

  const sortedSelectedLangs = [...selectedLangs].sort((a, b) => {
    if (a === userLang) return -1
    if (b === userLang) return 1
    return 0
  })

  return (
    <div className={styles.root}>
        <div className={styles.toolbarRow}>
        <Button size="small" icon={<ArrowLeft24Regular />} appearance="subtle" onClick={onBack}>{t('workshop.back')}</Button>
        <Text weight="semibold">{mod.mod_key}</Text>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Text size="small">{t('workshop.displayLang')}</Text>
          {LANGUAGES.map(lang => {
            const hasTrans = !!mod.translations?.[lang.value]?.instructions
            return (
              <Checkbox
                key={lang.value}
                size="small"
                label={lang.label}
                checked={selectedLangs.includes(lang.value)}
                onChange={() => handleLangToggle(lang.value)}
                disabled={!hasTrans}
              />
            )
          })}
        </div>
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
        {mod.description && (
          <Text size="small" style={{ lineHeight: '1.6' }}>{mod.description}</Text>
        )}
        {(sortedSelectedLangs.length > 0 || mod.instructions) && (
          <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <Text size="small" weight="semibold" block>{t('workshop.detailedDesc')}</Text>
            {sortedSelectedLangs.length > 0 ? sortedSelectedLangs.map(langCode => {
              const trans = mod.translations?.[langCode]
              if (!trans?.instructions) return null
              return (
                <div key={langCode}>
                  <Badge appearance="outline" size="small" style={{ marginBottom: '8px' }}>
                    {LANG_LABELS[langCode] || langCode}
                  </Badge>
                  {(trans.instructions_format || 'markdown') === 'richtext'
                    ? <RichTextContent html={trans.instructions} />
                    : <MarkdownContent markdown={trans.instructions} />}
                </div>
              )
            }) : (
              <>
                {(mod.instructions_format || 'markdown') === 'richtext'
                  ? <RichTextContent html={mod.instructions} />
                  : <MarkdownContent markdown={mod.instructions} />}
              </>
            )}
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

      <div className={styles.fabContainer}>
        <div className={styles.fabItem}>
          <Button
            size="large"
            icon={isLiked ? <Heart24Filled /> : <Heart24Regular />}
            appearance={isLiked ? 'primary' : 'outline'}
            shape="circular"
            onClick={handleLikeToggle}
            disabled={likeBusy}
            title={t('workshop.likeCount', { count: likeCount })}
            style={isLiked ? { color: tokens.colorPaletteRedForeground1 } : undefined}
          />
          <Text className={styles.fabLabel}>{likeCount}</Text>
        </div>
        {user && canEdit && (
          <div className={styles.fabItem}>
            <Button
              size="large"
              icon={<Edit24Regular />}
              appearance="primary"
              shape="circular"
              onClick={() => onEdit?.(mod)}
              title={t('workshop.edit')}
            />
          </div>
        )}
        {user && canApply && (
          <div className={styles.fabItem}>
            <Button
              size="large"
              icon={<Add24Regular />}
              appearance="primary"
              shape="circular"
              onClick={() => setApplyOpen(true)}
              title={t('workshop.applyToEdit')}
            />
            <Text className={styles.fabLabel}>{t('workshop.applyToEdit')}</Text>
          </div>
        )}
      </div>
    </div>
  )
}
