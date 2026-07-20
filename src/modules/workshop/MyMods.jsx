import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, CardHeader, Text, Button, Spinner,
  Input, Textarea, Select, makeStyles, tokens,
  Badge, Dialog, DialogTrigger, DialogSurface,
  DialogBody, DialogTitle, DialogContent,
} from '@fluentui/react-components'
import {
  Add24Regular, Delete24Regular, Edit24Regular,
  ArrowClockwise24Regular, Cloud24Regular,
  ArrowUpload24Regular, Save24Regular,
  Heart24Regular, Heart24Filled,
  ArrowLeft24Regular,
} from '@fluentui/react-icons'
import { listMyMods, createMod, updateMod, uploadModFile, deleteModFile, deleteImgbedFile, getModForEdit, getModDetail, deleteMod, checkModKey, setModPermissions, getDeviceId } from '../../services/workshopApi'
import { resolveTranslationImages, extractImgbedUrls, deleteImageFromImgbed } from '../../services/imageApi'
import { useAuth } from '../../contexts/useAuth'
import { RichTextEditor, MarkdownEditor } from '../../components/common/RichTextEditor'
import JSZip from 'jszip'
import { open } from '@tauri-apps/plugin-dialog'
import { readFile, readDir } from '@tauri-apps/plugin-fs'
import Database from '@tauri-apps/plugin-sql'
import { collectSelection } from './collectSelection'
import { runReplaceFlow } from './runReplaceFlow'
import ModDetailPage from './ModDetailPage'
import { ConfirmDialog, BackButton, ProgressModal, AsyncView, LoginForm } from '../../components'
import PermissionSettings from './PermissionSettings'

const LANGUAGES = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
]

const LANG_LABELS = { zh: '中文', en: 'English', ja: '日本語' }
const MAX_INSTRUCTIONS_LENGTH = 10000

function getRelativePath(filePath, baseDir) {
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedBase || !normalizedFile.startsWith(normalizedBase + '/')) {
    return filePath.split(/[/\\]/).pop()
  }
  return normalizedFile.substring(normalizedBase.length + 1)
}

// 追加去重：按 zipPath（缺失时回退 name）合并条目，新条目覆盖同 key 旧条目
function mergeEntries(existing, incoming) {
  const keyOf = (e) => e.zipPath || e.name || ''
  const map = new Map()
  for (const e of existing) {
    const k = keyOf(e)
    if (k) map.set(k, e)
  }
  for (const e of incoming) {
    const k = keyOf(e)
    if (k) map.set(k, e)
  }
  return [...map.values()]
}
const MAX_ZIP_SIZE_BASE = 20 * 1024 * 1024 // 20MB 限制
const MAX_ZIP_SIZE_R2 = 100 * 1024 * 1024 // 100MB 限制（R2 权限）

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  list: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '12px',
  },
  card: {
    padding: '12px',
    height: '100%',
    minHeight: '220px',
    transition: 'box-shadow 0.2s ease',
    '&:hover': {
      boxShadow: tokens.shadow4,
    },
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
    padding: '32px',
    textAlign: 'center',
  },

  description: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
  },
  formRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '8px',
    flexShrink: 0,
  },
  expandableFormRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '8px',
    flex: 1,
    minHeight: '160px',
  },
  formLabel: {
    fontSize: tokens.fontSizeSmall,
    fontWeight: '600',
  },
  langHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '8px',
    marginBottom: '4px',
  },
  loginCard: {
    maxWidth: '360px',
    margin: '0 auto',
    padding: '16px',
  },
  loginTitle: {
    textAlign: 'center',
    marginBottom: '12px',
  },
  fab: {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: 1000,
    boxShadow: tokens.shadow8,
  },
  fabContainer: {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    alignItems: 'flex-end',
  },
  stickyToolbar: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground1,
    paddingTop: '8px',
    paddingBottom: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
})

function LoginPage() {
  const styles = useStyles()
  const { t } = useTranslation()

  return (
    <Card className={styles.loginCard}>
      <div className={styles.loginTitle}>
        <Text weight="semibold">{t('workshop.login')}</Text>
        <Text size="small" className={styles.meta} block>
          {t('workshop.loginHint')}
        </Text>
      </div>
      <LoginForm />
    </Card>
  )
}

export function CreateModPage({ onClose, onCreated }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user } = useAuth()
  const [modKey, setModKey] = useState('')
  const [category, setCategory] = useState('v1')
  const [translations, setTranslations] = useState({ zh: { name: '', description: '', instructions: '', instructions_format: 'markdown', changelog: '', version: '1.0.0' } })
  const allLangs = LANGUAGES.map(l => l.value)
  const langList = Object.keys(translations)
  const availableLangs = allLangs.filter(l => !langList.includes(l))
  const [addLang, setAddLang] = useState(availableLangs[0] || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [modFiles, setModFiles] = useState({})
  const [uploadingLang, setUploadingLang] = useState('')
  const [progressOpen, setProgressOpen] = useState(false)
  const [progressPercent, setProgressPercent] = useState(0)
  const [progressStep, setProgressStep] = useState('')
  const [fileDialogLang, setFileDialogLang] = useState(null)
  const [permissions, setPermissions] = useState({ mode: 'author_only', open_langs: [], allow_mod_info: true, allow_lang: true, apply_langs: [] })
  const [gamePath, setGamePath] = useState('')

  useEffect(() => {
    const loadGamePath = async () => {
      const db = await Database.load('sqlite:config.db')
      const rows = await db.select("SELECT value FROM config WHERE `key` = 'game_path'")
      setGamePath(rows[0]?.value || '')
    }
    loadGamePath()
  }, [])

  const maxZipSize = user?.r2_enabled ? MAX_ZIP_SIZE_R2 : MAX_ZIP_SIZE_BASE

  const firstLang = Object.keys(translations)[0]
  const version = translations[firstLang]?.version || ''
  const canSelectFile = modKey.trim() && version.trim()

  const isFormValid = modKey.trim() && Object.values(translations).every(
    trans => trans.name.trim() && trans.version.trim() && trans.description.trim()
  )

  const handleSelectFolders = async (lang) => {
    if (!canSelectFile) return
    try {
      const folders = await open({ directory: true, multiple: true })
      if (!folders || folders.length === 0) return
      const selections = folders.map(p => ({ path: p, isDirectory: true }))
      const { files, dirs } = await collectSelection({ selections, gamePath })
      const entries = [
        ...files.map(f => ({ zipPath: f.zipPath, data: f.data, size: f.size, isDir: false })),
        ...dirs.map(d => ({ zipPath: d, isDir: true, size: 0 })),
      ]
      if (entries.length === 0) return
      setModFiles(prev => {
        const existing = prev[lang] || []
        return { ...prev, [lang]: mergeEntries(existing, entries) }
      })
    } catch (e) {
      const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e)) || t('mods.unknownError')
      setError(t('workshop.selectFolderErr', { msg }))
    }
  }

  const handleSelectFiles = async (lang) => {
    if (!canSelectFile) return
    try {
      if (category === 'v2') {
        const folder = await open({ directory: true, multiple: false })
        if (!folder) return
        const files = []
        const collectDir = async (dirPath, prefix) => {
          const entries = await readDir(dirPath)
          for (const entry of entries) {
            const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
            if (entry.isDirectory) {
              await collectDir(`${dirPath}/${entry.name}`, fullPath)
            } else if (entry.isFile) {
              const data = await readFile(`${dirPath}/${entry.name}`)
              files.push({ name: fullPath, data, size: data.byteLength })
            }
          }
        }
        await collectDir(folder, '')
        setModFiles(prev => ({ ...prev, [lang]: files }))
      } else if (category === 'composite') {
        // 组合：多选文件，忠实保留相对游戏根目录的路径
        const selected = await open({ multiple: true, filters: [{ name: 'All Files', extensions: ['*'] }] })
        if (!selected || selected.length === 0) return
        const selections = selected.map(p => ({ path: p, isDirectory: false }))
        const { files } = await collectSelection({ selections, gamePath })
        if (files.length === 0) return
        const entries = files.map(f => ({ zipPath: f.zipPath, data: f.data, size: f.size, isDir: false }))
        setModFiles(prev => {
          const existing = prev[lang] || []
          return { ...prev, [lang]: mergeEntries(existing, entries) }
        })
      } else if (category === 'dll') {
        const selected = await open({ multiple: false, filters: [{ name: 'DLL 文件', extensions: ['dll'] }] })
        if (!selected) return
        const files = []
        for (const filePath of [selected].flat()) {
          const data = await readFile(filePath)
          const name = filePath.split(/[/\\]/).pop()
          files.push({ name, data, size: data.byteLength })
        }
        setModFiles(prev => ({ ...prev, [lang]: files }))
      } else {
        const selected = await open({ multiple: true, filters: [{ name: 'Mod Files', extensions: ['json', 'code', 'txt', 'zip'] }] })
        if (!selected || selected.length === 0) return
        const files = []
        const baseDir = category === 'v1' && gamePath ? `${gamePath}\\CustomMissions` : null
        for (const filePath of selected) {
          const data = await readFile(filePath)
          const name = filePath.split(/[/\\]/).pop()
          const zipPath = baseDir ? getRelativePath(filePath, baseDir) : name
          files.push({ name, zipPath, data, size: data.byteLength })
        }
        setModFiles(prev => ({ ...prev, [lang]: files }))
      }
    } catch (e) {
      const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e)) || t('mods.unknownError')
      setError(t('workshop.selectFileErr', { msg }))
    }
  }

  const handleAddLang = () => {
    if (translations[addLang]) return
    setTranslations(prev => {
      const next = { ...prev, [addLang]: { name: '', description: '', instructions: '', instructions_format: 'markdown', changelog: '', version: '1.0.0' } }
      const remaining = allLangs.filter(l => !Object.keys(next).includes(l))
      setAddLang(remaining[0] || '')
      return next
    })
  }

  const handleRemoveLang = (lang) => {
    setTranslations(prev => {
      const next = { ...prev }
      delete next[lang]
      const remaining = allLangs.filter(l => !Object.keys(next).includes(l))
      setAddLang(remaining[0] || '')
      return next
    })
  }

  const handleTransChange = (lang, field, value) => {
    setTranslations(prev => ({
      ...prev,
      [lang]: { ...prev[lang], [field]: value },
    }))
  }

  const handleSubmit = async () => {
    if (!modKey.trim()) {
      setError(t('workshop.modIdEmpty'))
      return
    }
    setError('')
    setBusy(true)
    try {
      // 1. 先检查 mod_key 是否可用
      const keyCheck = await checkModKey(modKey.trim())
      if (keyCheck.exists) {
        setError('已存在，请前往更新对应语言文件')
        return
      }

      // 2. 先创建 mod 拿到 mod_id（instructions 先留空，避免图片上传失败时数据库残留占位符）
      const emptyInstructionsTranslations = {}
      for (const [lang, trans] of Object.entries(translations)) {
        emptyInstructionsTranslations[lang] = { ...trans, instructions: '' }
      }
      const createResult = await createMod({ author_id: user.user_id, mod_key: modKey.trim(), translations: emptyInstructionsTranslations, category })
      const newModId = createResult.data.mod_id

      // 3. 上传 mod 文件（所有 category 统一走 runReplaceFlow 的"压缩+上传+进度+错误收集"流程）
      const fileLangs = Object.keys(modFiles).filter(lang => modFiles[lang] && modFiles[lang].length > 0)
      if (fileLangs.length > 0) {
        setProgressOpen(true)
        setProgressPercent(0)
        setProgressStep(t('workshop.updatingFiles'))
        const langEntries = fileLangs.map(lang => ({
          lang,
          files: modFiles[lang],
          version: translations[lang]?.version,
          existing: null, // 新发布没有旧文件
        }))
        const result = await runReplaceFlow({
          authorId: user.user_id,
          modId: newModId,
          modKey: modKey.trim(),
          langEntries,
          maxZipSize,
          r2Enabled: user?.r2_enabled,
          t,
          onProgress: ({ percent, step }) => {
            setProgressPercent(percent)
            setProgressStep(step)
          },
          onLangStart: (lang) => setUploadingLang(lang),
          onLangUploaded: (lang) => {
            setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
          },
        })
        if (!result.ok) {
          // 超大 zip 或上传失败：保留已生成的 mod 记录，提示用户
          setProgressOpen(false)
          setError(result.errors[0]?.msg || t('workshop.modFileSizeWarning', { size: 0, max: (maxZipSize / 1024 / 1024) }))
          setBusy(false)
          return
        }
        setProgressStep(t('workshop.updatingDatabase'))
        setProgressPercent(100)
      }
      setUploadingLang('')
      setProgressOpen(false)

      // 4. 上传说明中的图片并替换占位符
      const resolvedTranslations = await resolveTranslationImages(translations, newModId)
      await updateMod({ author_id: user.user_id, mod_id: newModId, category, translations: resolvedTranslations })

      // 5. 保存权限设置
      if (permissions.mode !== 'author_only') {
        try {
          await setModPermissions({ author_id: user.user_id, mod_id: newModId, ...permissions })
        } catch (e) {
          console.warn('Failed to save permissions:', e)
        }
      }

      onCreated()
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbarRow}>
        <BackButton onClick={onClose} />
        <Text weight="semibold">{t('workshop.publishMod')}</Text>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className={styles.formRow}>
          <Text className={styles.formLabel}>{t('workshop.modId')}</Text>
          <Input
            size="small"
            placeholder={t('workshop.modIdCreatePlaceholder')}
            value={modKey}
            onChange={(_, d) => setModKey(d.value)}
          />
        </div>

        <div className={styles.formRow}>
          <Text className={styles.formLabel}>{t('workshop.type')}</Text>
          <Select size="small" value={category} onChange={(_, d) => setCategory(d.value)}>
            <option value="v1">{t('workshop.category_v1')}</option>
            <option value="v2">{t('workshop.category_v2')}</option>
            <option value="dll">{t('workshop.category_dll')}</option>
            <option value="composite">{t('workshop.category_composite')}</option>
          </Select>
        </div>

        <PermissionSettings value={permissions} onChange={setPermissions} disabled={busy} />

        <div className={styles.langHeader}>
          <Text weight="semibold" size="small">{t('workshop.multiLang')}</Text>
              <Select size="small" value={addLang} onChange={(_, d) => setAddLang(d.value)}>
                {availableLangs.map(l => {
                  const lang = LANGUAGES.find(ll => ll.value === l)
                  return <option key={l} value={l}>{lang?.label || l}</option>
                })}
              </Select>
              <Button size="small" onClick={handleAddLang} disabled={!addLang || translations[addLang]}>
            {t('workshop.addLang')}
          </Button>
        </div>

        {langList.map(lang => {
          const langLabel = LANGUAGES.find(l => l.value === lang)?.label || lang
          const trans = translations[lang]
          return (
            <div key={lang} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px', padding: '8px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <Text weight="semibold" size="small">{langLabel} ({lang})</Text>
                <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={() => handleRemoveLang(lang)} />
              </div>
              <div className={styles.formRow}>
                <Text className={styles.formLabel}>{t('workshop.name')}</Text>
                <Input size="small" placeholder={t('workshop.modName')} value={trans.name} onChange={(_, d) => handleTransChange(lang, 'name', d.value)} />
              </div>
              <div className={styles.formRow}>
                <Text className={styles.formLabel}>{t('workshop.version')}</Text>
                <Input size="small" placeholder="1.0.0" value={trans.version || '1.0.0'} onChange={(_, d) => handleTransChange(lang, 'version', d.value)} style={{ width: '100px' }} />
              </div>
              <div className={styles.formRow}>
                <Text className={styles.formLabel}>{t('workshop.desc')}</Text>
                <Textarea size="small" placeholder={t('workshop.briefDesc')} value={trans.description} onChange={(_, d) => handleTransChange(lang, 'description', d.value)} />
              </div>
              <div className={styles.expandableFormRow}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Text className={styles.formLabel}>{t('workshop.detailedDesc')}</Text>
                  <Select
                    size="small"
                    value={trans.instructions_format || 'markdown'}
                    onChange={(_, d) => handleTransChange(lang, 'instructions_format', d.value)}
                  >
                    <option value="markdown">{t('workshop.markdown')}</option>
                    <option value="richtext">{t('workshop.richtext')}</option>
                  </Select>
                </div>
                {(trans.instructions_format || 'markdown') === 'richtext' ? (
                  <RichTextEditor value={trans.instructions} onChange={(html) => handleTransChange(lang, 'instructions', html)} placeholder={t('workshop.instructions') + '（' + t('workshop.richtext') + '；' + t('workshop.lineBreakOnce') + '）'} maxLength={MAX_INSTRUCTIONS_LENGTH} />
                ) : (
                  <MarkdownEditor value={trans.instructions} onChange={(md) => handleTransChange(lang, 'instructions', md)} placeholder={t('workshop.instructions') + '（' + t('workshop.markdown') + '；' + t('workshop.lineBreakTwice') + '）'} maxLength={MAX_INSTRUCTIONS_LENGTH} />
                )}
              </div>
              <div className={styles.formRow}>
                <Text className={styles.formLabel}>{t('workshop.modFile')} {category === 'v2' ? `(${t('workshop.hint_v2')})` : category === 'composite' ? `(${t('workshop.hint_composite')})` : category === 'dll' ? `(${t('workshop.hint_dll')})` : `(${t('workshop.hint_v1')})`}</Text>
                <Text size="small" style={{ color: tokens.colorNeutralForeground3, lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
                  <span style={{ textDecoration: user?.r2_enabled ? 'line-through' : 'none' }}>
                    {t('workshop.uploadLimitWarning', { max: (maxZipSize / 1024 / 1024) })}
                  </span>
                  {user?.r2_enabled && (
                    <>
                      <br />
                      {t('workshop.uploadLimitR2Enabled', { max: (maxZipSize / 1024 / 1024) })}
                    </>
                  )}
                </Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {category === 'composite' ? (
                    <>
                      <Button size="small" icon={<ArrowUpload24Regular />} disabled={!canSelectFile} onClick={() => handleSelectFolders(lang)}>{modFiles[lang]?.length > 0 ? t('workshop.appendFolder') : t('workshop.updateFolder')}</Button>
                      <Button size="small" icon={<ArrowUpload24Regular />} disabled={!canSelectFile} onClick={() => handleSelectFiles(lang)}>{modFiles[lang]?.length > 0 ? t('workshop.appendFile') : t('workshop.updateFile')}</Button>
                    </>
                  ) : (
                    <Button size="small" icon={<ArrowUpload24Regular />} disabled={!canSelectFile} onClick={() => handleSelectFiles(lang)}>
                      {category === 'v2' ? t('workshop.hint_v2') : category === 'dll' ? t('workshop.hint_dll') : t('workshop.selectFile')}
                    </Button>
                  )}
                  {modFiles[lang] && (
                    <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={() => setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })} />
                  )}
                </div>
                {modFiles[lang] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
                    {modFiles[lang].slice(0, 5).map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Text size="small" className={styles.meta} style={{ flex: 1 }}>
                          {f.isDir
                            ? `${t('workshop.dirLabel')} ${f.zipPath}/`
                            : `${f.zipPath || f.name} (${(f.size / 1024).toFixed(1)}KB)`}
                        </Text>
                        <Button
                          size="small"
                          icon={<Delete24Regular />}
                          appearance="subtle"
                          onClick={() => setModFiles(prev => {
                            const next = { ...prev }
                            next[lang] = (next[lang] || []).filter((_, idx) => idx !== i)
                            if (next[lang].length === 0) delete next[lang]
                            return next
                          })}
                        />
                      </div>
                    ))}
                    {modFiles[lang].length > 5 && (
                      <Text size="small" className={styles.meta} style={{ cursor: 'pointer', textDecoration: 'underline', color: tokens.colorBrandForeground1 }} onClick={() => setFileDialogLang(lang)}>
                        {t('workshop.moreFilesCount', { count: modFiles[lang].length - 5 })}
                      </Text>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {uploadingLang && (
          <Text size="small" className={styles.meta}>
            {t('workshop.uploadingLang', { lang: uploadingLang })}
          </Text>
        )}
        {error && <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '12px 8px', borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
        <Button size="small" appearance="subtle" onClick={onClose}>{t('workshop.cancel')}</Button>
        <Button size="small" appearance="primary" onClick={handleSubmit} disabled={busy || !isFormValid}>
          {busy ? t('workshop.publishing') : t('workshop.publish')}
        </Button>
      </div>

      <Dialog open={!!fileDialogLang} onOpenChange={(_, { open }) => !open && setFileDialogLang(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('workshop.fileListTitle', { count: fileDialogLang && modFiles[fileDialogLang]?.length || 0 })}</DialogTitle>
            <DialogContent>
              <div style={{ maxHeight: '60vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {fileDialogLang && modFiles[fileDialogLang]?.map((f, i) => (
                  <Text key={i} size="small" className={styles.meta}>
                    {f.isDir ? `[${t('workshop.dirLabel')}] ` : ''}{f.zipPath || f.name} ({(f.size / 1024).toFixed(1)}KB)
                  </Text>
                ))}
              </div>
            </DialogContent>
            <DialogTrigger>
              <Button size="small">{t('window.close')}</Button>
            </DialogTrigger>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <ProgressModal
        open={progressOpen}
        title={t('workshop.publishing')}
        percent={progressPercent}
        stepText={progressStep}
      />
    </div>
  )
}

export function EditModPage({ mod: initialMod, onClose, onUpdated }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user } = useAuth()
  const [modKey] = useState(initialMod.mod_key || '')
  const [category, setCategory] = useState(initialMod.category || 'v1')

  const initTrans = () => {
    const raw = initialMod.translations || {}
    const t = {}
    if (Array.isArray(raw)) {
      raw.forEach(item => {
        t[item.lang] = {
          name: item.name || '',
          description: item.description || '',
          instructions: item.instructions || '',
          instructions_format: item.instructions_format || 'markdown',
          changelog: item.changelog || '',
          version: item.version || '1.0.0',
        }
      })
    } else {
      Object.entries(raw).forEach(([lang, item]) => {
        t[lang] = {
          name: item.name || '',
          description: item.description || '',
          instructions: item.instructions || '',
          instructions_format: item.instructions_format || 'markdown',
          changelog: item.changelog || '',
          version: item.version || '1.0.0',
        }
      })
    }
    if (!t.zh) {
      t.zh = { name: '', description: '', instructions: '', instructions_format: 'markdown', changelog: '', version: '1.0.0' }
    }
    return t
  }

  const initFiles = () => {
    const ef = {}
    if (initialMod.files && initialMod.files.length) {
      initialMod.files.forEach(f => { ef[f.lang_code] = f })
    }
    return ef
  }

  const [translations, setTranslations] = useState(initTrans)
  const originalInstructionsRef = useRef(() => {
    const map = {}
    for (const [lang, trans] of Object.entries(initTrans())) {
      map[lang] = trans.instructions || ''
    }
    return map
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const allLangs = LANGUAGES.map(l => l.value)
  const langList = Object.keys(translations)
  const availableLangs = allLangs.filter(l => !langList.includes(l))
  const [addLang, setAddLang] = useState(availableLangs[0] || '')
  const [modFiles, setModFiles] = useState({})
  const [existingFiles, setExistingFiles] = useState(initFiles)
  const [uploadingLang, setUploadingLang] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [fileDialogLang, setFileDialogLang] = useState(null)
  const [confirmRemoveLang, setConfirmRemoveLang] = useState(null)
  const [progressOpen, setProgressOpen] = useState(false)
  const [progressPercent, setProgressPercent] = useState(0)
  const [progressStep, setProgressStep] = useState('')
  const [replaceErrors, setReplaceErrors] = useState([])
  const [gamePath, setGamePath] = useState('')

  useEffect(() => {
    const loadGamePath = async () => {
      const db = await Database.load('sqlite:config.db')
      const rows = await db.select("SELECT value FROM config WHERE `key` = 'game_path'")
      setGamePath(rows[0]?.value || '')
    }
    loadGamePath()
  }, [])

  // 权限设置
  const pc = initialMod.perm_config || { mode: 'author_only', open_langs: [], allow_mod_info: true, allow_lang: true, apply_langs: [] }
  const [permissions, setPermissions] = useState({ ...pc })
  const userPermissions = initialMod.user_permissions || {}
  const canEditModInfo = !!userPermissions?.can_edit_mod_info || !!userPermissions?.is_author
  const canEditAllLangs = !!userPermissions?.can_edit_all_langs || !!userPermissions?.is_author
  const editableLangs = userPermissions?.editable_langs || []
  const canEditLang = (lang) => canEditAllLangs || editableLangs.includes(lang)
  const hasAnyEditPermission = canEditModInfo || canEditAllLangs || editableLangs.length > 0

  const maxZipSize = user?.r2_enabled ? MAX_ZIP_SIZE_R2 : MAX_ZIP_SIZE_BASE

  const handleSelectFolders = async (lang) => {
    try {
      const folders = await open({ directory: true, multiple: true })
      if (!folders || folders.length === 0) return
      const selections = folders.map(p => ({ path: p, isDirectory: true }))
      const { files, dirs } = await collectSelection({ selections, gamePath })
      const entries = [
        ...files.map(f => ({ zipPath: f.zipPath, data: f.data, size: f.size, isDir: false })),
        ...dirs.map(d => ({ zipPath: d, isDir: true, size: 0 })),
      ]
      if (entries.length === 0) return
      setModFiles(prev => {
        const existing = prev[lang] || []
        return { ...prev, [lang]: mergeEntries(existing, entries) }
      })
    } catch (e) {
      const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e)) || t('mods.unknownError')
      setUploadError(t('workshop.selectFolderErr', { msg }))
    }
  }

  const handleSelectFiles = async (lang) => {
    try {
      if (category === 'v2') {
        const folder = await open({ directory: true, multiple: false })
        if (!folder) return
        const files = []
        const collectDir = async (dirPath, prefix) => {
          const entries = await readDir(dirPath)
          for (const entry of entries) {
            const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name
            if (entry.isDirectory) {
              await collectDir(`${dirPath}/${entry.name}`, fullPath)
            } else if (entry.isFile) {
              const data = await readFile(`${dirPath}/${entry.name}`)
              files.push({ name: fullPath, data, size: data.byteLength })
            }
          }
        }
        await collectDir(folder, '')
        setModFiles(prev => ({ ...prev, [lang]: files }))
      } else if (category === 'composite') {
        // 组合：多选文件，忠实保留相对游戏根目录的路径
        const selected = await open({ multiple: true, filters: [{ name: 'All Files', extensions: ['*'] }] })
        if (!selected || selected.length === 0) return
        const selections = selected.map(p => ({ path: p, isDirectory: false }))
        const { files } = await collectSelection({ selections, gamePath })
        if (files.length === 0) return
        const entries = files.map(f => ({ zipPath: f.zipPath, data: f.data, size: f.size, isDir: false }))
        setModFiles(prev => {
          const existing = prev[lang] || []
          return { ...prev, [lang]: mergeEntries(existing, entries) }
        })
      } else if (category === 'dll') {
        const selected = await open({ multiple: false, filters: [{ name: 'DLL 文件', extensions: ['dll'] }] })
        if (!selected) return
        const files = []
        for (const filePath of [selected].flat()) {
          const data = await readFile(filePath)
          const name = filePath.split(/[/\\]/).pop()
          files.push({ name, data, size: data.byteLength })
        }
        setModFiles(prev => ({ ...prev, [lang]: files }))
      } else {
        const selected = await open({ multiple: true, filters: [{ name: 'Mod Files', extensions: ['json', 'code', 'txt', 'zip'] }] })
        if (!selected || selected.length === 0) return
        const files = []
        const baseDir = category === 'v1' && gamePath ? `${gamePath}\\CustomMissions` : null
        for (const filePath of selected) {
          const data = await readFile(filePath)
          const name = filePath.split(/[/\\]/).pop()
          const zipPath = baseDir ? getRelativePath(filePath, baseDir) : name
          files.push({ name, zipPath, data, size: data.byteLength })
        }
        setModFiles(prev => ({ ...prev, [lang]: files }))
      }
    } catch (e) {
      const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e)) || t('mods.unknownError')
      setUploadError(t('workshop.selectFileErr', { msg }))
    }
  }

  const handleAddLang = () => {
    if (!addLang || translations[addLang]) return
    setTranslations(prev => {
      const next = { ...prev, [addLang]: { name: '', description: '', instructions: '', instructions_format: 'markdown', changelog: '', version: '1.0.0' } }
      const remaining = allLangs.filter(l => !Object.keys(next).includes(l))
      setAddLang(remaining[0] || '')
      return next
    })
  }
  const handleConfirmRemoveLang = async () => {
    const lang = confirmRemoveLang
    if (!lang) return
    // 如果有已上传的文件，从图床和 DB 删除
    if (existingFiles[lang]) {
      try {
        await deleteModFile({ author_id: user.user_id, mod_id: initialMod.id, lang_code: lang, fileUrl: existingFiles[lang].file_url })
        setExistingFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
      } catch (e) {
        console.warn('删除语言文件失败:', e)
      }
    }
    setTranslations(prev => {
      const next = { ...prev }
      delete next[lang]
      const remaining = allLangs.filter(l => !Object.keys(next).includes(l))
      setAddLang(remaining[0] || '')
      return next
    })
    setConfirmRemoveLang(null)
  }

  const handleTransChange = (lang, field, value) => {
    setTranslations(prev => ({
      ...prev,
      [lang]: { ...prev[lang], [field]: value },
    }))
  }

  const handleUploadFile = async (lang) => {
    const files = modFiles[lang]
    if (!files || files.length === 0) return
    setUploadError('')
    setUploadingLang(lang)
    setProgressOpen(true)
    setProgressPercent(0)
    setProgressStep(t('workshop.compressingFile', { lang }))
    try {
      // 先删旧文件
      if (existingFiles[lang]) {
        setProgressStep(t('workshop.deletingOldFile', { lang }))
        await deleteModFile({ author_id: user.user_id, mod_id: initialMod.id, lang_code: lang, fileUrl: existingFiles[lang].file_url })
      }
      const manifest = JSON.stringify(files.map(f => f.zipPath || f.name))
      const zip = new JSZip()
      for (const file of files) {
        zip.file(file.zipPath || file.name, file.data)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      if (blob.size > maxZipSize) {
        setUploadError(t('workshop.modFileSizeWarning', { size: (blob.size / 1024 / 1024).toFixed(1), max: (maxZipSize / 1024 / 1024) }))
        setUploadingLang('')
        setProgressOpen(false)
        return
      }
      const zipFile = new File([blob], `${modKey}_${lang}.zip`, { type: 'application/zip' })
      setProgressStep(t('workshop.uploadingLang', { lang }))
      const res = await uploadModFile({
        author_id: user.user_id,
        mod_id: initialMod.id,
        lang_code: lang,
        version: translations[lang]?.version,
        file: zipFile,
        manifest,
        r2_enabled: user?.r2_enabled,
        onProgress: (loaded, total) => {
          if (total) setProgressPercent(Math.round((loaded / total) * 90))
        },
      })
      setExistingFiles(prev => ({ ...prev, [lang]: res.data }))
      setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
      setProgressPercent(100)
      setProgressStep(t('workshop.updatingDatabase'))
      // 不调 onUpdated()——让用户继续编辑其他语言/字段，由「保存」btn 统一收尾
    } catch (e) {
      setUploadError(e.message)
    } finally {
      setUploadingLang('')
      setProgressOpen(false)
    }
  }

  const handleReplaceErrorClose = () => {
    setReplaceErrors([])
    setProgressOpen(false)
    onUpdated()
    onClose()
  }

  const handleSubmit = async () => {
    setError('')
    setBusy(true)
    setReplaceErrors([])
    try {
      // 1. 收集需要处理的语言
      const pendingLangs = Object.keys(modFiles).filter(lang => modFiles[lang] && modFiles[lang].length > 0)

      // 检查版本变更但没有新文件的语言（用户需要重新选文件）
      const versionChangedOnly = Object.keys(existingFiles).filter(lang => {
        const ef = existingFiles[lang]
        return ef && translations[lang] && translations[lang].version !== ef.version && (!modFiles[lang] || modFiles[lang].length === 0)
      })
      if (versionChangedOnly.length > 0) {
        setError(t('workshop.versionChangedHint', { lang: versionChangedOnly[0] }))
        setBusy(false)
        return
      }

      // 所有 category 统一走"保存即替换"的进度流程（v1 / composite / dll / v2）
      const replaceLangs = pendingLangs

      let replaceErrorList = []
      if (replaceLangs.length > 0) {
        setProgressOpen(true)
        setProgressPercent(0)
        setProgressStep(t('workshop.updatingFiles'))

        const langEntries = replaceLangs.map(lang => ({
          lang,
          files: modFiles[lang],
          version: translations[lang]?.version,
          existing: existingFiles[lang],
        }))

        const result = await runReplaceFlow({
          authorId: user.user_id,
          modId: initialMod.id,
          modKey,
          langEntries,
          maxZipSize,
          r2Enabled: user?.r2_enabled,
          t,
          onProgress: ({ percent, step }) => {
            setProgressPercent(percent)
            setProgressStep(step)
          },
          onLangStart: (lang) => setUploadingLang(lang),
          onLangUploaded: (lang, res) => {
            setExistingFiles(prev => ({ ...prev, [lang]: res.data }))
            setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
          },
        })

        if (!result.ok && result.abortedLang) {
          // 超大 zip：清理已成功上传的语言的待上传队列
          setProgressOpen(false)
          setError(result.errors[0]?.msg || t('workshop.modFileSizeWarning', { size: 0, max: (maxZipSize / 1024 / 1024) }))
          setModFiles(prev => {
            const next = { ...prev }
            const abortedIdx = replaceLangs.indexOf(result.abortedLang)
            for (let j = 0; j <= abortedIdx && j < replaceLangs.length; j++) {
              delete next[replaceLangs[j]]
            }
            return next
          })
          setBusy(false)
          return
        }

        replaceErrorList = result.errors || []
        setProgressStep(t('workshop.updatingDatabase'))
        setProgressPercent(100)
      }
      setReplaceErrors(replaceErrorList)

      // 清空待上传队列（runReplaceFlow 的 onLangUploaded 已逐语言清空，这里保险再清一次）
      setModFiles({})
      setUploadingLang('')

      // 2. 上传说明中的图片并替换占位符
      const resolvedTranslations = await resolveTranslationImages(translations, initialMod.id)

      // 3. 清理被删除的图片（updateMod 成功后异步处理，不阻塞 UI）
      const cleanupImages = () => {
        const originalInstructions = originalInstructionsRef.current
        const allLangs = new Set([
          ...Object.keys(originalInstructions),
          ...Object.keys(resolvedTranslations),
        ])
        for (const lang of allLangs) {
          const oldUrls = extractImgbedUrls(originalInstructions[lang] || '')
          const newUrls = extractImgbedUrls(resolvedTranslations[lang]?.instructions || '')
          const removedUrls = oldUrls.filter(url => !newUrls.includes(url))
          for (const url of removedUrls) {
            deleteImageFromImgbed(url).catch(e => console.warn('删除 mod 图片失败:', e))
          }
        }
      }

      // 4. 更新翻译信息
      await updateMod({ author_id: user.user_id, mod_id: initialMod.id, category, translations: resolvedTranslations })
      cleanupImages()

      // 5. 保存权限设置
      if (userPermissions?.is_author && permissions.mode !== 'author_only') {
        try {
          await setModPermissions({ author_id: user.user_id, mod_id: initialMod.id, ...permissions })
        } catch (e) {
          console.warn('Failed to save permissions:', e)
        }
      } else if (userPermissions?.is_author) {
        // 切回仅作者时，更新权限
        try {
          await setModPermissions({ author_id: user.user_id, mod_id: initialMod.id, mode: 'author_only', open_langs: null, allow_mod_info: true, allow_lang: true, apply_langs: null })
        } catch (e) {
          console.warn('Failed to reset permissions:', e)
        }
      }

      if (replaceErrorList.length > 0) {
        setProgressOpen(false)
      } else {
        setProgressOpen(false)
        onUpdated()
        onClose()
      }
    } catch (e) {
      setError(e.message)
      setProgressOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.root}>
      <div className={`${styles.toolbarRow} ${styles.stickyToolbar}`}>
        <BackButton onClick={onClose} />
        <Text weight="semibold">{t('workshop.editMod')}</Text>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className={styles.formRow}>
          <Text className={styles.formLabel}>{t('workshop.modId')}</Text>
          <Input size="small" value={modKey} disabled />
        </div>

        <div className={styles.formRow}>
          <Text className={styles.formLabel}>{t('workshop.type')}</Text>
          <Select size="small" value={category} onChange={(_, d) => setCategory(d.value)} disabled={!canEditModInfo}>
            <option value="v1">{t('workshop.category_v1')}</option>
            <option value="v2">{t('workshop.category_v2')}</option>
            <option value="dll">{t('workshop.category_dll')}</option>
            <option value="composite">{t('workshop.category_composite')}</option>
          </Select>
        </div>

        <PermissionSettings value={permissions} onChange={setPermissions} disabled={busy || !userPermissions?.is_author} />

        <div className={styles.langHeader}>
          <Text weight="semibold" size="small">{t('workshop.multiLang')}</Text>
          <Select size="small" value={addLang} onChange={(_, d) => setAddLang(d.value)}>
            {availableLangs.map(l => {
              const lang = LANGUAGES.find(ll => ll.value === l)
              return <option key={l} value={l}>{lang?.label || l}</option>
            })}
          </Select>
          <Button size="small" onClick={handleAddLang} disabled={!addLang || translations[addLang] || !canEditAllLangs}>{t('workshop.addLang')}</Button>
        </div>

        {langList.map(lang => {
          const langLabel = LANGUAGES.find(l => l.value === lang)?.label || lang
          const trans = translations[lang]
          const langEditable = canEditLang(lang)
          return (
            <div key={lang} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px', padding: '8px', marginBottom: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <Text weight="semibold" size="small">{langLabel} ({lang})</Text>
                {canEditAllLangs && (
                  <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={() => setConfirmRemoveLang(lang)} />
                )}
              </div>
              <div className={styles.formRow}>
                <Text className={styles.formLabel}>{t('workshop.name')}</Text>
                <Input size="small" placeholder={t('workshop.modName')} value={trans.name} onChange={(_, d) => handleTransChange(lang, 'name', d.value)} disabled={!langEditable} />
              </div>
              <div className={styles.formRow}>
                <Text className={styles.formLabel}>{t('workshop.version')}</Text>
                <Input size="small" placeholder="1.0.0" value={trans.version || '1.0.0'} onChange={(_, d) => handleTransChange(lang, 'version', d.value)} style={{ width: '100px' }} disabled={!langEditable} />
              </div>
              <div className={styles.formRow}>
                <Text className={styles.formLabel}>{t('workshop.desc')}</Text>
                <Textarea size="small" placeholder={t('workshop.briefDesc')} value={trans.description} onChange={(_, d) => handleTransChange(lang, 'description', d.value)} disabled={!langEditable} />
              </div>
              <div className={styles.expandableFormRow}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Text className={styles.formLabel}>{t('workshop.detailedDesc')}</Text>
                  <Select
                    size="small"
                    value={trans.instructions_format || 'markdown'}
                    onChange={(_, d) => handleTransChange(lang, 'instructions_format', d.value)}
                    disabled={!langEditable}
                  >
                    <option value="markdown">{t('workshop.markdown')}</option>
                    <option value="richtext">{t('workshop.richtext')}</option>
                  </Select>
                </div>
                {(trans.instructions_format || 'markdown') === 'richtext' ? (
                  <RichTextEditor value={trans.instructions} onChange={(html) => handleTransChange(lang, 'instructions', html)} placeholder={t('workshop.instructions') + '（' + t('workshop.richtext') + '；' + t('workshop.lineBreakOnce') + '）'} maxLength={MAX_INSTRUCTIONS_LENGTH} disabled={!langEditable} />
                ) : (
                  <MarkdownEditor value={trans.instructions} onChange={(md) => handleTransChange(lang, 'instructions', md)} placeholder={t('workshop.instructions') + '（' + t('workshop.markdown') + '；' + t('workshop.lineBreakTwice') + '）'} maxLength={MAX_INSTRUCTIONS_LENGTH} disabled={!langEditable} />
                )}
              </div>
              <div className={styles.formRow}>
                <Text className={styles.formLabel}>{t('workshop.modFile')} {category === 'v2' ? `(${t('workshop.hint_v2')})` : category === 'composite' ? `(${t('workshop.hint_composite')})` : category === 'dll' ? `(${t('workshop.hint_dll')})` : `(${t('workshop.hint_v1')})`}</Text>
                <Text size="small" style={{ color: tokens.colorNeutralForeground3, lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
                  <span style={{ textDecoration: user?.r2_enabled ? 'line-through' : 'none' }}>
                    {t('workshop.uploadLimitWarning', { max: (maxZipSize / 1024 / 1024) })}
                  </span>
                  {user?.r2_enabled && (
                    <>
                      <br />
                      {t('workshop.uploadLimitR2Enabled', { max: (maxZipSize / 1024 / 1024) })}
                    </>
                  )}
                </Text>
                {existingFiles[lang] && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
                    <Text size="small" className={styles.meta}>
                      {t('workshop.alreadyUploaded')}：{existingFiles[lang].file_name} ({(existingFiles[lang].file_size / 1024).toFixed(1)}KB)
                    </Text>
                    <Text size="small" className={styles.meta}>v{existingFiles[lang].version}</Text>
                    {existingFiles[lang].file_url && (
                      <a href={existingFiles[lang].file_url} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: tokens.colorBrandForeground1 }}>
                        {existingFiles[lang].file_url}
                      </a>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  {category === 'composite' ? (
                    <>
                      <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => handleSelectFolders(lang)} disabled={!langEditable}>{modFiles[lang]?.length > 0 ? t('workshop.appendFolder') : t('workshop.updateFolder')}</Button>
                      <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => handleSelectFiles(lang)} disabled={!langEditable}>{modFiles[lang]?.length > 0 ? t('workshop.appendFile') : t('workshop.updateFile')}</Button>
                    </>
                  ) : (
                    <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => handleSelectFiles(lang)} disabled={!langEditable}>
                      {category === 'v2' ? t('workshop.hint_v2') : category === 'dll' ? t('workshop.hint_dll') : category === 'v1' ? t('workshop.updateFile') : t('workshop.selectFile')}
                    </Button>
                  )}
                  {modFiles[lang] && (
                    <>
                      {category !== 'v1' && category !== 'composite' && (
                        <Button size="small" appearance="primary" onClick={() => handleUploadFile(lang)} disabled={uploadingLang === lang || !langEditable}>
                          {uploadingLang === lang ? t('workshop.uploading') : t('workshop.upload')}
                        </Button>
                      )}
                      {(category === 'v1' || category === 'composite') ? (
                        <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={() => setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })} disabled={!langEditable}>
                          {t('workshop.cancelSelection')}
                        </Button>
                      ) : (
                        <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={() => setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })} disabled={!langEditable} />
                      )}
                      {(category === 'v1' || category === 'composite') && existingFiles[lang] && (
                        <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{t('workshop.replaceFileHint')}</Text>
                      )}
                    </>
                  )}
                </div>
                {modFiles[lang] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
                    {modFiles[lang].slice(0, 5).map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Text size="small" className={styles.meta} style={{ flex: 1 }}>
                          {f.isDir
                            ? `${t('workshop.dirLabel')} ${f.zipPath}/`
                            : `${f.zipPath || f.name} (${(f.size / 1024).toFixed(1)}KB)`}
                        </Text>
                        <Button
                          size="small"
                          icon={<Delete24Regular />}
                          appearance="subtle"
                          onClick={() => setModFiles(prev => {
                            const next = { ...prev }
                            next[lang] = (next[lang] || []).filter((_, idx) => idx !== i)
                            if (next[lang].length === 0) delete next[lang]
                            return next
                          })}
                        />
                      </div>
                    ))}
                    {modFiles[lang].length > 5 && (
                      <Text size="small" className={styles.meta} style={{ cursor: 'pointer', textDecoration: 'underline', color: tokens.colorBrandForeground1 }} onClick={() => setFileDialogLang(lang)}>
                        {t('workshop.moreFilesCount', { count: modFiles[lang].length - 5 })}
                      </Text>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {uploadingLang && (
          <Text size="small" className={styles.meta}>
            {t('workshop.uploadingLang', { lang: uploadingLang })}
          </Text>
        )}
        {uploadError && <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{uploadError}</Text>}
        {error && <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '12px 8px', borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
        <Button size="small" appearance="subtle" onClick={onClose}>{t('workshop.cancel')}</Button>
        <Button size="small" appearance="primary" onClick={handleSubmit} disabled={busy || !hasAnyEditPermission}>
          {busy ? t('workshop.saving') : t('workshop.save')}
        </Button>
      </div>

      <Dialog open={!!fileDialogLang} onOpenChange={(_, { open }) => !open && setFileDialogLang(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('workshop.fileListTitle', { count: fileDialogLang && modFiles[fileDialogLang]?.length || 0 })}</DialogTitle>
            <DialogContent>
              <div style={{ maxHeight: '60vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {fileDialogLang && modFiles[fileDialogLang]?.map((f, i) => (
                  <Text key={i} size="small" className={styles.meta}>
                    {f.isDir ? `[${t('workshop.dirLabel')}] ` : ''}{f.zipPath || f.name} ({(f.size / 1024).toFixed(1)}KB)
                  </Text>
                ))}
              </div>
            </DialogContent>
            <DialogTrigger>
              <Button size="small">{t('window.close')}</Button>
            </DialogTrigger>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <ProgressModal
        open={progressOpen}
        title={t('workshop.updatingFiles')}
        percent={progressPercent}
        stepText={progressStep}
      />

      <ConfirmDialog
        open={replaceErrors.length > 0}
        onClose={handleReplaceErrorClose}
        title={t('workshop.replaceFileWarning')}
        onConfirm={handleReplaceErrorClose}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {replaceErrors.map((e, i) => (
            <Text key={i} size="small">{e.lang}: {e.msg}</Text>
          ))}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!confirmRemoveLang}
        onClose={() => setConfirmRemoveLang(null)}
        title={t('workshop.removeLang')}
        onConfirm={handleConfirmRemoveLang}
      >
        <Text>{t('workshop.confirmRemoveLang', { lang: confirmRemoveLang })}</Text>
        {confirmRemoveLang && existingFiles[confirmRemoveLang] && (
          <Text as="p" size="small" style={{ color: tokens.colorPaletteRedForeground1, marginTop: '8px' }}>
            {t('workshop.removeLangFileHint')}
          </Text>
        )}
      </ConfirmDialog>

      <div className={styles.fabContainer}>
        <Button
          size="large"
          icon={<ArrowLeft24Regular />}
          appearance="outline"
          shape="circular"
          onClick={onClose}
          title={t('workshop.back')}
        />
        <Button
          size="large"
          icon={<Save24Regular />}
          appearance="primary"
          shape="circular"
          onClick={handleSubmit}
          disabled={busy || !hasAnyEditPermission}
          title={t('workshop.save')}
        />
      </div>
    </div>
  )
}

export function MyMods() {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user, isLoggedIn } = useAuth()
  const deviceIdRef = useRef(getDeviceId())
  const [mods, setMods] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showCreatePage, setShowCreatePage] = useState(false)
  const [editingMod, setEditingMod] = useState(null)
  const [detailMod, setDetailMod] = useState(null)
  const [confirmDeleteModId, setConfirmDeleteModId] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deletePercent, setDeletePercent] = useState(0)
  const [deleteStep, setDeleteStep] = useState('')
  const initialFetch = useRef(false)

  const fetchMods = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listMyMods({ author_id: user.user_id, lang: 'zh', device_id: deviceIdRef.current })
      setMods(data.mods || [])
    } catch (e) {
      setError(e.message)
      setMods([])
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (isLoggedIn && !initialFetch.current) {
      initialFetch.current = true
      fetchMods()
    }
  }, [isLoggedIn, fetchMods])

  const handleEdit = async (mod) => {
    try {
      const res = await getModForEdit(mod.id, user.user_id)
      setEditingMod(res.data || mod)
    } catch (e) {
      alert(t('workshop.getEditDataFailed') + e.message)
    }
  }

  const handleDetail = async (mod) => {
    try {
      const res = await getModDetail(mod.id, 'zh', user?.user_id, deviceIdRef.current)
      setDetailMod(res.data?.mod || mod)
    } catch {
      setDetailMod(mod)
    }
  }

  const handleDelete = (modId) => setConfirmDeleteModId(modId)

  const handleConfirmDelete = async () => {
    setDeleting(true)
    setDeletePercent(0)
    setDeleteStep(t('workshop.deletingModFiles', { done: 0, total: 0 }))
    try {
      const files = mods.find(m => m.id === confirmDeleteModId)?.files || []
      const total = files.length
      // 1. 逐个删除模组文件（带进度上报）
      for (let i = 0; i < total; i++) {
        const f = files[i]
        setDeleteStep(t('workshop.deletingModFiles', { done: i + 1, total }))
        await deleteModFile({ author_id: user.user_id, mod_id: Number(confirmDeleteModId), lang_code: f.lang_code, fileUrl: f.file_url })
        setDeletePercent(Math.round(((i + 1) / (total + 1)) * 90))
      }
      // 2. 删除模组数据库记录
      setDeleteStep(t('workshop.updatingDatabase'))
      await deleteMod({ author_id: user.user_id, modId: confirmDeleteModId })
      setDeletePercent(100)
      setMods(prev => prev.filter(m => m.id !== confirmDeleteModId))
    } catch (e) {
      alert(t('workshop.deleteModFailed') + e.message)
    } finally {
      setDeleting(false)
      setConfirmDeleteModId(null)
    }
  }

  if (showCreatePage) {
    return <CreateModPage onClose={() => setShowCreatePage(false)} onCreated={() => { setShowCreatePage(false); fetchMods() }} />
  }

  if (!isLoggedIn) {
    return <LoginPage />
  }

  if (editingMod) {
    return <EditModPage mod={editingMod} onClose={() => setEditingMod(null)} onUpdated={() => { setEditingMod(null); fetchMods() }} />
  }

  if (detailMod) {
    return <ModDetailPage key={detailMod.id} mod={detailMod} onBack={() => setDetailMod(null)} onEdit={handleEdit} />
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbarRow}>
        <Text size="small" className={styles.meta} style={{ flex: 1 }}>
          {t('workshop.modCount', { username: user.username, count: mods.length })}
        </Text>
        <Button size="small" icon={<Add24Regular />} appearance="primary" onClick={() => setShowCreatePage(true)}>
          {t('workshop.publishMod')}
        </Button>
        <Button size="small" icon={<ArrowClockwise24Regular />} onClick={fetchMods} disabled={loading}>
          {t('workshop.refresh')}
        </Button>
      </div>

      <AsyncView loading={loading} error={error} onRetry={fetchMods} loadingLabel={t('workshop.loading')}>
        {mods.length === 0 ? (
          <div className={styles.emptyState}>
            <Cloud24Regular style={{ fontSize: '32px' }} />
            <Text weight="semibold">{t('workshop.noModsYet')}</Text>
            <Text size="small" className={styles.meta}>{t('workshop.uploadHint')}</Text>
          </div>
        ) : (
        <div className={styles.list}>
          {mods.map(mod => (
            <Card key={mod.id} className={styles.card} appearance="outline" onClick={() => handleDetail(mod)} style={{ cursor: 'pointer' }}>
              <CardHeader
                header={
                  <Text size="small" className={styles.meta} truncate>{mod.mod_key}</Text>
                }
                description={
                  <Text size="small" className={styles.meta}>{user.username}</Text>
                }
                action={
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }} title={mod.is_liked ? t('workshop.likedHint') : t('workshop.unlikedHint')}>
                      {mod.is_liked ? (
                        <Heart24Filled style={{ color: tokens.colorPaletteRedForeground1, fontSize: '16px' }} />
                      ) : (
                        <Heart24Regular style={{ fontSize: '16px', color: tokens.colorNeutralForeground3 }} />
                      )}
                      <Text size="small">{mod.like_count || 0}</Text>
                    </div>
                    <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
                      {mod.category ? t(`workshop.category_${mod.category}`) : t('workshop.uncategorized')}
                    </Badge>
                    <Button size="small" icon={<Edit24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); handleEdit(mod) }} />
                    <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); handleDelete(mod.id) }} />
                  </div>
                }
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                {mod.description && (
                  <Text size="small" className={styles.description}>{mod.description}</Text>
                )}
                {mod.files && mod.files.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {mod.files.map(f => {
                      const langName = mod.translations?.[f.lang_code]?.name || mod.display_name
                      return (
                        <div key={f.lang_code} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px' }}>
                          <Badge appearance="outline" size="small" style={{ minWidth: '36px', textAlign: 'center' }}>
                            {LANG_LABELS[f.lang_code] || f.lang_code}
                          </Badge>
                          <Text size="small" truncate style={{ flex: 1 }}>{langName}</Text>
                          <Text size="small">v{f.version}</Text>
                          <Text size="small" className={styles.meta}>{(f.file_size / 1024).toFixed(1)}KB</Text>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      </AsyncView>

      <ConfirmDialog
        open={!!confirmDeleteModId}
        onClose={() => setConfirmDeleteModId(null)}
        title={t('workshop.deleteMod')}
        onConfirm={handleConfirmDelete}
      >
        <Text>确定要删除这个模组吗？所有关联文件将从图床移除</Text>
      </ConfirmDialog>

      <ProgressModal
        open={deleting}
        title={t('workshop.deleteMod')}
        percent={deletePercent}
        stepText={deleteStep}
      />
    </div>
  )
}
