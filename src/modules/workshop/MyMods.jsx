import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, CardHeader, Text, Button, Spinner,
  Input, Textarea, Select, makeStyles, tokens,
  Avatar, Badge, Dialog, DialogTrigger, DialogSurface,
  DialogBody, DialogTitle, DialogContent,
} from '@fluentui/react-components'
import {
  Add24Regular, Delete24Regular, Edit24Regular,
  ArrowClockwise24Regular, Cloud24Regular,
  ArrowUpload24Regular, Save24Regular,
  Heart24Regular, Heart24Filled,
} from '@fluentui/react-icons'
import { listMyMods, createMod, updateMod, uploadModFile, deleteModFile, login, register, getModForEdit, getModDetail, deleteModWithFiles, checkModKey, setModPermissions, getDeviceId } from '../../services/workshopApi'
import { resolveTranslationImages, extractImgbedUrls, deleteImageFromImgbed } from '../../services/imageApi'
import { useAuth } from '../../contexts/useAuth'
import { RichTextEditor, MarkdownEditor } from '../../components/common/RichTextEditor'
import JSZip from 'jszip'
import { open } from '@tauri-apps/plugin-dialog'
import { readFile, readDir } from '@tauri-apps/plugin-fs'
import ModDetailPage from './ModDetailPage'
import { ConfirmDialog } from '../../components'
import PermissionSettings from './PermissionSettings'

const LANGUAGES = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
]

const LANG_LABELS = { zh: '中文', en: 'English', ja: '日本語' }
const MAX_INSTRUCTIONS_LENGTH = 10000
const MAX_ZIP_SIZE = 20 * 1024 * 1024 // 20MB 限制

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
  authorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
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
  loginRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginBottom: '8px',
  },
  fab: {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: 1000,
    boxShadow: tokens.shadow8,
  },
})

function LoginForm() {
  const styles = useStyles()
  const { t } = useTranslation()
  const [isRegister, setIsRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { loginSuccess } = useAuth()

  const handleSubmit = async () => {
    setError('')
    setBusy(true)
    try {
      const fn = isRegister ? register : login
      const data = await fn(username, password)
      loginSuccess(data.data)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={styles.loginCard}>
      <div className={styles.loginTitle}>
        <Text weight="semibold">{isRegister ? t('workshop.register') : t('workshop.login')}</Text>
        <Text size="small" className={styles.meta} block>
          {t('workshop.loginHint')}
        </Text>
      </div>

      <div className={styles.loginRow}>
        <Input
          size="small"
          placeholder={t('workshop.username')}
          value={username}
          onChange={(_, d) => setUsername(d.value)}
        />
      </div>
      <div className={styles.loginRow}>
        <Input
          size="small"
          type="password"
          placeholder={t('workshop.password')}
          value={password}
          onChange={(_, d) => setPassword(d.value)}
        />
      </div>

      {error && <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}

      <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
        <Button size="small" appearance="primary" onClick={handleSubmit} disabled={busy}>
          {busy ? t('workshop.processing') : isRegister ? t('workshop.registerBtn') : t('workshop.login')}
        </Button>
        <Button size="small" appearance="subtle" onClick={() => { setIsRegister(!isRegister); setError('') }}>
          {isRegister ? t('workshop.hasAccount') : t('workshop.noAccount')}
        </Button>
      </div>
    </Card>
  )
}

export function CreateModPage({ onClose, onCreated }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user } = useAuth()
  const [modKey, setModKey] = useState('')
  const [modKeyValidated, setModKeyValidated] = useState(false)
  const [modKeyChecking, setModKeyChecking] = useState(false)
  const [modKeyChecked, setModKeyChecked] = useState(false)
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
  const [fileDialogLang, setFileDialogLang] = useState(null)
  const [permissions, setPermissions] = useState({ mode: 'author_only', open_langs: [], allow_mod_info: true, allow_lang: true, apply_langs: [] })

  const firstLang = Object.keys(translations)[0]
  const version = translations[firstLang]?.version || ''
  const canSelectFile = modKey.trim() && version.trim()

  const handleSelectFolders = async (lang) => {
    if (!canSelectFile) return
    try {
      const folders = await open({ directory: true, multiple: true })
      if (!folders || folders.length === 0) return
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
      for (const folder of folders) {
        const folderName = folder.split(/[/\\]/).pop()
        await collectDir(folder, folderName)
      }
      setModFiles(prev => {
        const existing = prev[lang] || []
        return { ...prev, [lang]: [...existing, ...files] }
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
        // 组合：多选文件
        const selected = await open({ multiple: true, filters: [{ name: 'All Files', extensions: ['*'] }] })
        if (!selected || selected.length === 0) return
        const files = []
        for (const filePath of selected) {
          try {
            const data = await readFile(filePath)
            const parts = filePath.split(/[/\\]/)
            const fileName = parts.pop()
            const parentDir = parts.pop() || ''
            const name = parentDir ? `${parentDir}/${fileName}` : fileName
            files.push({ name, data, size: data.byteLength })
          } catch (e) {
            console.warn(`[MyMods] 跳过无法读取的文件: ${filePath}`, e)
          }
        }
        if (files.length === 0) return
        setModFiles(prev => {
          const existing = prev[lang] || []
          return { ...prev, [lang]: [...existing, ...files] }
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
        for (const filePath of selected) {
          const data = await readFile(filePath)
          const name = filePath.split(/[/\\]/).pop()
          files.push({ name, data, size: data.byteLength })
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

  const handleCheckModKey = async () => {
    if (!modKey.trim()) return
    setModKeyChecking(true)
    setModKeyValidated(false)
    try {
      const res = await checkModKey(modKey.trim())
      setModKeyValidated(!res.exists)
      setModKeyChecked(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setModKeyChecking(false)
    }
  }

  const handleSubmit = async () => {
    if (!modKey.trim()) {
      setError(t('workshop.modIdEmpty'))
      return
    }
    if (!modKeyValidated) {
      setError('请先检查 Mod 标识名是否可用')
      return
    }
    setError('')
    setBusy(true)
    try {
      // 1. 先创建 mod 拿到 mod_id（instructions 先留空，避免图片上传失败时数据库残留占位符）
      const emptyInstructionsTranslations = {}
      for (const [lang, trans] of Object.entries(translations)) {
        emptyInstructionsTranslations[lang] = { ...trans, instructions: '' }
      }
      const createResult = await createMod({ author_id: user.user_id, mod_key: modKey.trim(), translations: emptyInstructionsTranslations, category })
      const newModId = createResult.data.mod_id

      // 2. 上传 mod 文件
      const fileLangs = Object.keys(modFiles).filter(lang => modFiles[lang] && modFiles[lang].length > 0)
      for (const lang of fileLangs) {
        setUploadingLang(lang)
        const files = modFiles[lang]
        const manifest = JSON.stringify(files.map(f => f.name))
        const zip = new JSZip()
        for (const file of files) {
          zip.file(file.name, file.data)
        }
        const blob = await zip.generateAsync({ type: 'blob' })
        if (blob.size > MAX_ZIP_SIZE) {
          setError(t('workshop.modFileSizeWarning', { size: (blob.size / 1024 / 1024).toFixed(1) }))
          setBusy(false)
          return
        }
        const zipFile = new File([blob], `${modKey}_${lang}.zip`, { type: 'application/zip' })
        await uploadModFile({ author_id: user.user_id, mod_id: newModId, lang_code: lang, version: translations[lang]?.version, file: zipFile, manifest })
      }
      setUploadingLang('')

      // 3. 上传说明中的图片并替换占位符
      const resolvedTranslations = await resolveTranslationImages(translations, newModId)
      await updateMod({ author_id: user.user_id, mod_id: newModId, category, translations: resolvedTranslations })

      // 4. 保存权限设置
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
        <Button size="small" appearance="subtle" onClick={onClose}>
          {t('workshop.back')}
        </Button>
        <Text weight="semibold">{t('workshop.publishMod')}</Text>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className={styles.formRow}>
          <Text className={styles.formLabel}>{t('workshop.modId')}</Text>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <Input
              size="small"
              placeholder={t('workshop.modIdCreatePlaceholder')}
              value={modKey}
              onChange={(_, d) => { setModKey(d.value); setModKeyValidated(false); setModKeyChecked(false) }}
              style={{ flex: 1 }}
            />
            <Button size="small" appearance="outline" onClick={handleCheckModKey} disabled={modKeyChecking || !modKey.trim()}>
              {modKeyChecking ? t('workshop.checking') : t('workshop.check')}
            </Button>
          </div>
          {modKeyChecked && modKeyValidated && <Text size="small" style={{ color: tokens.colorPaletteGreenForeground1 }}>可用</Text>}
          {modKeyChecked && !modKeyValidated && <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>已存在，请前往更新对应语言文件</Text>}
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
                  {t('workshop.uploadLimitWarning')}
                </Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {category === 'composite' ? (
                    <>
                      <Button size="small" icon={<ArrowUpload24Regular />} disabled={!canSelectFile} onClick={() => handleSelectFolders(lang)}>{t('workshop.hint_v2')}</Button>
                      <Button size="small" icon={<ArrowUpload24Regular />} disabled={!canSelectFile} onClick={() => handleSelectFiles(lang)}>{t('workshop.selectFile')}</Button>
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
                      <Text key={i} size="small" className={styles.meta}>
                        {f.name} ({(f.size / 1024).toFixed(1)}KB)
                      </Text>
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
          <Text size="small" className={styles.meta}>{t('workshop.uploadingLang', { lang: uploadingLang })}</Text>
        )}
        {error && <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '12px 8px', borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}>
        <Button size="small" appearance="subtle" onClick={onClose}>{t('workshop.cancel')}</Button>
        <Button size="small" appearance="primary" onClick={handleSubmit} disabled={busy}>
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
                    {f.name} ({(f.size / 1024).toFixed(1)}KB)
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

  // 权限设置
  const pc = initialMod.perm_config || { mode: 'author_only', open_langs: [], allow_mod_info: true, allow_lang: true, apply_langs: [] }
  const [permissions, setPermissions] = useState({ ...pc })
  const userPermissions = initialMod.user_permissions || {}
  const canEditModInfo = !!userPermissions?.can_edit_mod_info || !!userPermissions?.is_author
  const canEditAllLangs = !!userPermissions?.can_edit_all_langs || !!userPermissions?.is_author
  const editableLangs = userPermissions?.editable_langs || []
  const canEditLang = (lang) => canEditAllLangs || editableLangs.includes(lang)
  const hasAnyEditPermission = canEditModInfo || canEditAllLangs || editableLangs.length > 0

  const handleSelectFolders = async (lang) => {
    try {
      const folders = await open({ directory: true, multiple: true })
      if (!folders || folders.length === 0) return
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
      for (const folder of folders) {
        const folderName = folder.split(/[/\\]/).pop()
        await collectDir(folder, folderName)
      }
      setModFiles(prev => {
        const existing = prev[lang] || []
        return { ...prev, [lang]: [...existing, ...files] }
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
        // 组合：多选文件
        const selected = await open({ multiple: true, filters: [{ name: 'All Files', extensions: ['*'] }] })
        if (!selected || selected.length === 0) return
        const files = []
        for (const filePath of selected) {
          try {
            const data = await readFile(filePath)
            const parts = filePath.split(/[/\\]/)
            const fileName = parts.pop()
            const parentDir = parts.pop() || ''
            const name = parentDir ? `${parentDir}/${fileName}` : fileName
            files.push({ name, data, size: data.byteLength })
          } catch (e) {
            console.warn(`[MyMods] 跳过无法读取的文件: ${filePath}`, e)
          }
        }
        if (files.length === 0) return
        setModFiles(prev => {
          const existing = prev[lang] || []
          return { ...prev, [lang]: [...existing, ...files] }
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
        for (const filePath of selected) {
          const data = await readFile(filePath)
          const name = filePath.split(/[/\\]/).pop()
          files.push({ name, data, size: data.byteLength })
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
    try {
      // 先删旧文件
      if (existingFiles[lang]) {
        await deleteModFile({ author_id: user.user_id, mod_id: initialMod.id, lang_code: lang, fileUrl: existingFiles[lang].file_url })
      }
      const manifest = JSON.stringify(files.map(f => f.name))
      const zip = new JSZip()
      for (const file of files) {
        zip.file(file.name, file.data)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      if (blob.size > MAX_ZIP_SIZE) {
        setUploadError(t('workshop.modFileSizeWarning', { size: (blob.size / 1024 / 1024).toFixed(1) }))
        setUploadingLang('')
        return
      }
      const zipFile = new File([blob], `${modKey}_${lang}.zip`, { type: 'application/zip' })
      const res = await uploadModFile({ author_id: user.user_id, mod_id: initialMod.id, lang_code: lang, version: translations[lang]?.version, file: zipFile, manifest })
      setExistingFiles(prev => ({ ...prev, [lang]: res.data }))
      setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
      onUpdated()
    } catch (e) {
      setUploadError(e.message)
    } finally {
      setUploadingLang('')
    }
  }

  const handleSubmit = async () => {
    setError('')
    setBusy(true)
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

      // 处理所有有待上传文件的语言
      for (const lang of pendingLangs) {
        if (existingFiles[lang]) {
          await deleteModFile({ author_id: user.user_id, mod_id: initialMod.id, lang_code: lang, fileUrl: existingFiles[lang].file_url })
        }
        setUploadingLang(lang)
        const files = modFiles[lang]
        const manifest = JSON.stringify(files.map(f => f.name))
        const zip = new JSZip()
        for (const file of files) {
          zip.file(file.name, file.data)
        }
        const blob = await zip.generateAsync({ type: 'blob' })
        if (blob.size > MAX_ZIP_SIZE) {
          setError(t('workshop.modFileSizeWarning', { size: (blob.size / 1024 / 1024).toFixed(1) }))
          setBusy(false)
          return
        }
        const zipFile = new File([blob], `${modKey}_${lang}.zip`, { type: 'application/zip' })
        const res = await uploadModFile({ author_id: user.user_id, mod_id: initialMod.id, lang_code: lang, version: translations[lang]?.version, file: zipFile, manifest })
        setExistingFiles(prev => ({ ...prev, [lang]: res.data }))
      }
      // 清空待上传队列
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

      onUpdated()
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
        <Button size="small" appearance="subtle" onClick={onClose}>{t('workshop.back')}</Button>
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
                  {t('workshop.uploadLimitWarning')}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {category === 'composite' ? (
                    <>
                      <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => handleSelectFolders(lang)} disabled={!langEditable}>{t('workshop.hint_v2')}</Button>
                      <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => handleSelectFiles(lang)} disabled={!langEditable}>{t('workshop.selectFile')}</Button>
                    </>
                  ) : (
                    <Button size="small" icon={<ArrowUpload24Regular />} onClick={() => handleSelectFiles(lang)} disabled={!langEditable}>
                      {category === 'v2' ? t('workshop.hint_v2') : category === 'dll' ? t('workshop.hint_dll') : t('workshop.selectFile')}
                    </Button>
                  )}
                  {modFiles[lang] && (
                    <>
                      <Button size="small" appearance="primary" onClick={() => handleUploadFile(lang)} disabled={uploadingLang === lang || !langEditable}>
                        {uploadingLang === lang ? t('workshop.uploading') : t('workshop.upload')}
                      </Button>
                      <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={() => setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })} disabled={!langEditable} />
                    </>
                  )}
                </div>
                {modFiles[lang] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '4px' }}>
                    {modFiles[lang].slice(0, 5).map((f, i) => (
                      <Text key={i} size="small" className={styles.meta}>
                        {f.name} ({(f.size / 1024).toFixed(1)}KB)
                      </Text>
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
                    {f.name} ({(f.size / 1024).toFixed(1)}KB)
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

      <Button
        size="large"
        icon={<Save24Regular />}
        appearance="primary"
        className={styles.fab}
        onClick={handleSubmit}
        disabled={busy || !hasAnyEditPermission}
        title={t('workshop.save')}
      />
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
    try {
      const files = mods.find(m => m.id === confirmDeleteModId)?.files || []
      await deleteModWithFiles({ author_id: user.user_id, modId: confirmDeleteModId, files })
      setMods(prev => prev.filter(m => m.id !== confirmDeleteModId))
    } catch (e) {
      alert(t('workshop.deleteModFailed') + e.message)
    } finally {
      setConfirmDeleteModId(null)
    }
  }

  const handleCreated = () => {
    fetchMods()
  }

  if (!isLoggedIn) {
    return <LoginForm />
  }

  if (showCreatePage) {
    return (
      <CreateModPage
        onClose={() => setShowCreatePage(false)}
        onCreated={handleCreated}
      />
    )
  }

  if (editingMod) {
    return (
      <EditModPage
        mod={editingMod}
        onClose={() => setEditingMod(null)}
        onUpdated={handleCreated}
      />
    )
  }

  if (detailMod) {
    return <ModDetailPage mod={detailMod} onBack={() => setDetailMod(null)} />
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

      {loading && (
        <div className={styles.emptyState}>
          <Spinner size="small" label={t('workshop.loading')} />
        </div>
      )}

      {error && (
        <div className={styles.emptyState}>
          <Text weight="semibold">{t('workshop.loadFailed')}</Text>
          <Text size="small" className={styles.meta}>{error}</Text>
          <Button size="small" icon={<ArrowClockwise24Regular />} onClick={fetchMods}>{t('workshop.retry')}</Button>
        </div>
      )}

      {!loading && !error && mods.length === 0 && (
        <div className={styles.emptyState}>
          <Cloud24Regular style={{ fontSize: '32px' }} />
          <Text weight="semibold">{t('workshop.noModsYet')}</Text>
          <Text size="small" className={styles.meta}>{t('workshop.uploadHint')}</Text>
        </div>
      )}

      {!loading && !error && mods.length > 0 && (
        <div className={styles.list}>
          {mods.map(mod => (
            <Card key={mod.id} className={styles.card} appearance="outline" onClick={() => handleDetail(mod)} style={{ cursor: 'pointer' }}>
              <CardHeader
                header={
                  <Text size="small" className={styles.meta} truncate>{mod.mod_key}</Text>
                }
                description={
                  <div className={styles.authorRow}>
                    <Avatar name={user.username} size={20} />
                    <Text size="small" className={styles.meta}>{user.username}</Text>
                  </div>
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

      <ConfirmDialog
        open={!!confirmDeleteModId}
        onClose={() => setConfirmDeleteModId(null)}
        title={t('workshop.deleteMod')}
        onConfirm={handleConfirmDelete}
      >
        <Text>确定要删除这个模组吗？所有关联文件将从图床移除</Text>
      </ConfirmDialog>
    </div>
  )
}
