import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Badge, Avatar,
  makeStyles, tokens,
  Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogTrigger, DialogActions, Textarea, Select, Checkbox,
  Popover, PopoverTrigger, PopoverSurface,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular, ArrowDownload24Regular,
  Edit24Regular, Add24Regular, Delete24Regular,
  Heart24Regular, Heart24Filled,
  Folder24Regular, Document24Regular,
} from '@fluentui/react-icons'
import { installMod, uninstallMod } from '../../services/installMod'
import { RichTextContent, MarkdownContent } from '../../components/common/RichTextEditor'
import { invoke } from '@tauri-apps/api/core'
import { useAuth } from '../../contexts/useAuth'
import { submitApplication, likeMod, unlikeMod, getDeviceId } from '../../services/workshopApi'
import CommentSection from './CommentSection'
import Database from '@tauri-apps/plugin-sql'
import { BackButton } from '../../components'

const LANG_LABELS = { zh: '中文', en: 'English', ja: '日本語' }

function compareSemver(a, b) {
  const normalize = v => (v || '').replace(/^v/i, '')
  const pa = normalize(a).split('.').map(Number)
  const pb = normalize(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na !== nb) return na - nb
  }
  return 0
}

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
  const [installedFiles, setInstalledFiles] = useState([])
  const [installedByLang, setInstalledByLang] = useState({})
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
          'SELECT category, installed_version, lang_code, manifest FROM installed_workshop_mods WHERE mod_key = $1',
          [mod.mod_key]
        )
        let langRows = []
        try {
          langRows = await db.select(
            'SELECT lang_code, installed_version, file_hash, manifest FROM installed_workshop_mod_files WHERE mod_key = $1',
            [mod.mod_key]
          )
        } catch (newTableErr) {
          console.warn('[ModDetailPage] 查询 installed_workshop_mod_files 失败:', newTableErr)
        }
        const byLang = {}
        // 优先使用新表按语言记录
        for (const r of langRows) {
          byLang[r.lang_code] = r
        }
        // 兼容旧数据：旧表中有记录但新表中没有时，用旧表数据兜底
        if (rows.length > 0 && langRows.length === 0) {
          const old = rows[0]
          const fallback = {
            lang_code: old.lang_code || '',
            installed_version: old.installed_version || '',
            manifest: old.manifest || '',
          }
          if (old.lang_code) {
            byLang[old.lang_code] = fallback
          } else {
            // 旧数据没有记录 lang_code，给所有文件语言都加上兜底记录
            mod.files?.forEach(f => {
              byLang[f.lang_code] = { ...fallback, lang_code: f.lang_code }
            })
          }
        }
        setInstalledByLang(byLang)
        if (rows.length > 0 || langRows.length > 0) {
          setIsInstalled(true)
          let manifest = rows[0]?.manifest || ''
          if (!manifest && langRows.length > 0) {
            manifest = langRows[0].manifest || ''
          }
          try {
            setInstalledFiles(manifest ? JSON.parse(manifest) : [])
          } catch (parseErr) {
            console.warn('[ModDetailPage] 解析 manifest 失败:', parseErr)
            setInstalledFiles([])
          }
          const configRows = await db.select("SELECT value FROM config WHERE `key` = 'game_path'")
          const gamePath = configRows[0]?.value
          if (gamePath) {
            const base = gamePath.replace(/\/+$/, '')
            const category = rows[0]?.category || 'v1'
            let targetDir
            if (category === 'v2') {
              targetDir = `${base}\\CustomMissions2\\${mod.mod_key}`
            } else if (category === 'dll') {
              targetDir = `${base}\\BepInEx\\plugins`
            } else if (category === 'composite') {
              // composite：解压到游戏根目录，zip 内顶层文件夹才是真正的 mod 目录
              // 从 manifest 第一项推断顶层目录（如 "BepInEx/plugins/CosplayShop"）
              const fileList = manifest ? JSON.parse(manifest) : []
              const firstPath = fileList[0] || ''
              const segments = firstPath.split('/')
              const topDir = segments.length > 1 ? segments.slice(0, -1).join('\\') : firstPath
              targetDir = topDir ? `${base}\\${topDir}` : base
            } else {
              targetDir = `${base}\\CustomMissions`
            }
            setInstalledDir(targetDir)
          }
        }
      } catch (e) {
        console.warn('[ModDetailPage] 查询安装状态失败:', e)
      }
    }
    checkInstalled()
  }, [mod.mod_key, mod.files])

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
      setInstalledFiles(file.manifest ? JSON.parse(file.manifest) : [])
      setInstalledByLang(prev => ({
        ...prev,
        [file.lang_code]: {
          lang_code: file.lang_code,
          installed_version: file.version,
          file_hash: file.file_hash,
          manifest: file.manifest,
        },
      }))
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
      setInstalledByLang({})
      setInstalledFiles([])
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
        <BackButton onClick={onBack} />
        <Text weight="semibold">{mod.mod_key}</Text>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Text size="small">{t('workshop.displayLang')}</Text>
          {LANGUAGES.map(lang => {
            const hasTrans = !!mod.translations?.[lang.value]?.instructions
            if (!hasTrans) {
              return (
                <div key={lang.value} style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: 0.5 }}>
                  <div
                    style={{
                      width: '16px',
                      height: '16px',
                      border: `1px solid ${tokens.colorNeutralStroke1}`,
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '12px',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </div>
                  <Text size="small">{lang.label}</Text>
                </div>
              )
            }
            return (
              <Checkbox
                key={lang.value}
                size="small"
                label={lang.label}
                checked={selectedLangs.includes(lang.value)}
                onChange={() => handleLangToggle(lang.value)}
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
        {(mod.created_at || mod.updated_at) && (
          <div className={styles.meta} style={{ display: 'flex', gap: '12px' }}>
            {mod.created_at && <Text size="small">{t('workshop.createdAt')}: {new Date(mod.created_at).toLocaleString()}</Text>}
            {mod.updated_at && mod.updated_at !== mod.created_at && <Text size="small">{t('workshop.updatedAt')}: {new Date(mod.updated_at).toLocaleString()}</Text>}
          </div>
        )}
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
                <div
                  key={langCode}
                  style={{
                    border: `1px solid ${tokens.colorNeutralStroke2}`,
                    borderRadius: '8px',
                    padding: '12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <Badge appearance="outline" size="small">
                      {LANG_LABELS[langCode] || langCode}
                    </Badge>
                    {trans.name && <Text size="small" weight="semibold">{trans.name}</Text>}
                  </div>
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
              return (
              <div key={f.lang_code} className={styles.fileRow}>
                <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>{LANG_LABELS[f.lang_code] || f.lang_code}</Badge>
                {f.file_name && <Text size="small" truncate>{f.file_name}</Text>}
                <Text size="small">v{f.version}</Text>
                {installedByLang[f.lang_code] && (
                  <Text size="small" className={styles.meta}>
                    {t('workshop.localVersion', { version: installedByLang[f.lang_code].installed_version })}
                  </Text>
                )}
                <Text size="small" className={styles.meta}>
                  {f.file_size >= 1024 * 1024
                    ? `${(f.file_size / (1024 * 1024)).toFixed(2)}MB`
                    : `${(f.file_size / 1024).toFixed(1)}KB`}
                </Text>
                <Button
                  size="small"
                  icon={<ArrowDownload24Regular />}
                  appearance={
                    installingLang === f.lang_code
                      ? 'outline'
                      : installedByLang[f.lang_code]
                        ? compareSemver(installedByLang[f.lang_code].installed_version, f.version) < 0
                          ? 'primary'
                          : 'outline'
                        : 'primary'
                  }
                  disabled={installingLang === f.lang_code}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleInstall(f)
                  }}
                >
                  {installingLang === f.lang_code
                    ? t('workshop.installing')
                    : installedByLang[f.lang_code]
                      ? compareSemver(installedByLang[f.lang_code].installed_version, f.version) < 0
                        ? t('workshop.update')
                        : t('workshop.reinstall')
                      : t('workshop.install')}
                </Button>
                {isInstalled && (
                  <>
                    <Button
                      size="small"
                      icon={<Folder24Regular />}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (installedDir) {
                          invoke('open_folder', { path: installedDir, selected_items: installedFiles })
                        }
                      }}
                    >
                      {t('workshop.openDir')}
                    </Button>
                    <Popover withArrow positioning="below-start">
                      <PopoverTrigger>
                        <Button
                          size="small"
                          icon={<Document24Regular />}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {t('workshop.viewFileList')}
                        </Button>
                      </PopoverTrigger>
                      <PopoverSurface style={{ maxHeight: '300px', overflow: 'auto', minWidth: '240px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {installedFiles.length === 0 ? (
                            <Text size="small">{t('workshop.noFiles')}</Text>
                          ) : (
                            installedFiles.map((filePath, idx) => (
                              <Text key={idx} size="small" block>{filePath}</Text>
                            ))
                          )}
                        </div>
                      </PopoverSurface>
                    </Popover>
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
                  </>
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
            <Button size="small" appearance="subtle" style={{ marginLeft: '8px' }} onClick={() => invoke('open_folder', { path: installedDir, selected_items: installedFiles })}>
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
            icon={<ArrowLeft24Regular />}
            appearance="outline"
            shape="circular"
            onClick={onBack}
            title={t('workshop.back')}
          />
        </div>
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
