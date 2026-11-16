import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { listen } from '@tauri-apps/api/event'
import { createMod, updateMod, uploadModFile, deleteModFile, checkModKey, setModPermissions, publishModEditPackage, modEditWorkspaceKey, openModEditWorkspace, buildModEditPackage, discardModEditWorkspace } from '../../../services/workshopApi'
import { resolveTranslationImages, extractImgbedUrls, cleanupImagesFromImgbed, deleteUploadedImages } from '../../../services/imageApi'
import { useAuth } from '../../../contexts/useAuth'
import { selectModFiles, selectModFolders } from '../../../hooks/useFileSelection'
import { runReplaceFlow } from '../runReplaceFlow'
import { compareSemver, applyPublishedVersions } from '../modDetail/modFileUtils'
import { getGamePath } from '../../../services/dbHelper'
import { localizeError } from '../../../utils/localizeError'
import { LANGUAGES } from '../../../i18n/languages'
import JSZip from 'jszip'

// 与 Rust 端 is_valid_version 同一口径（版本号会拼进远端对象路径）
const VERSION_PATTERN = /^[0-9A-Za-z._-]{1,64}$/

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

const MAX_ZIP_SIZE = 20 * 1024 * 1024 // 20MB（与服务端上传上限一致，仅走 Telegram 图床）

// 选择阶段就把超限文件剔除：等压缩完再报错会让用户白等一次上传。
function summarizeOversizedFiles(entries) {
  const names = entries.slice(0, 3).map(e => e.zipPath || e.name || '').filter(Boolean)
  const suffix = entries.length > names.length ? ` +${entries.length - names.length}` : ''
  return `${names.join(', ')}${suffix}`
}

const DEFAULT_PERMISSIONS = { mode: 'author_only', open_langs: [], allow_mod_info: true, allow_lang: true, apply_langs: [] }

function defaultTranslation() {
  return { name: '', description: '', instructions: '', instructions_format: 'markdown', changelog: '', version: '1.0.0' }
}

// 详情/编辑接口的 translations 可能是数组或对象，统一成 lang → translation
function normalizeTranslations(raw) {
  const map = {}
  if (Array.isArray(raw)) {
    raw.forEach(item => {
      map[item.lang] = {
        name: item.name || '',
        description: item.description || '',
        instructions: item.instructions || '',
        instructions_format: item.instructions_format || 'markdown',
        changelog: item.changelog || '',
        version: item.version || '1.0.0',
      }
    })
  } else {
    Object.entries(raw || {}).forEach(([lang, item]) => {
      map[lang] = {
        name: item.name || '',
        description: item.description || '',
        instructions: item.instructions || '',
        instructions_format: item.instructions_format || 'markdown',
        changelog: item.changelog || '',
        version: item.version || '1.0.0',
      }
    })
  }
  if (!map.zh) map.zh = defaultTranslation()
  return map
}

function existingFilesFromMod(mod) {
  const map = {}
  if (mod?.files && mod.files.length) {
    mod.files.forEach(f => { map[f.lang_code] = f })
  }
  return map
}

export function useModEditor({ mode, initialMod, onClose, onCreated, onUpdated, onRefresh }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const isEdit = mode === 'edit'

  const allLangs = LANGUAGES.map(l => l.value)

  // 初始数据只取一次：编辑页的语言/已装文件/权限/原始说明都是进入编辑器时的快照
  const initial = useMemo(() => {
    const baseTranslations = isEdit ? normalizeTranslations(initialMod?.translations) : { zh: defaultTranslation() }
    return {
      translations: baseTranslations,
      existingFiles: isEdit ? existingFilesFromMod(initialMod) : {},
      permissions: isEdit ? { ...(initialMod?.perm_config || DEFAULT_PERMISSIONS) } : { ...DEFAULT_PERMISSIONS },
      originalInstructions: Object.fromEntries(
        Object.entries(baseTranslations).map(([lang, trans]) => [lang, trans.instructions || ''])
      ),
    }
  }, [isEdit, initialMod])

  const [modKey, setModKey] = useState(isEdit ? (initialMod.mod_key || '') : '')
  const [category, setCategory] = useState(isEdit ? (initialMod.category || 'v1') : 'v1')
  const [isOriginal, setIsOriginal] = useState(isEdit ? !!initialMod.is_original : false)
  const [translations, setTranslations] = useState(() => initial.translations)
  // 异步构建回调里判断语言是否已被删除；直接读 state 会拿到闭包旧值。
  const translationsRef = useRef(translations)
  useEffect(() => {
    translationsRef.current = translations
  }, [translations])
  const [permissions, setPermissions] = useState(() => initial.permissions)
  const [existingFiles, setExistingFiles] = useState(() => initial.existingFiles)
  // useRef 不执行函数参数：必须显式赋值，否则 current 是函数本身、取不到初始说明
  const originalInstructionsRef = useRef(initial.originalInstructions)

  const langList = Object.keys(translations)
  const availableLangs = allLangs.filter(l => !langList.includes(l))
  const [addLang, setAddLang] = useState(() =>
    allLangs.find(l => !Object.keys(initial.translations).includes(l)) || ''
  )

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uploadError, setUploadError] = useState('')
  const [modFiles, setModFiles] = useState({})
  // 已构建但尚未保存的补丁包：lang → { workspace_id, built }。
  // 面板只负责构建；页面「保存」时统一按这里的数据上传与写库。
  const [builtPatches, setBuiltPatches] = useState({})
  const [uploadingLang, setUploadingLang] = useState('')
  const [fileDialogLang, setFileDialogLang] = useState(null)
  const [confirmRemoveLang, setConfirmRemoveLang] = useState(null)
  const [progressOpen, setProgressOpen] = useState(false)
  const [progressPercent, setProgressPercent] = useState(0)
  const [progressStep, setProgressStep] = useState('')
  const [progressSpeed, setProgressSpeed] = useState(0)
  const [progressError, setProgressError] = useState('')
  // 保存完成后的非错误提示（幂等发布/清单修正）：必须在弹窗里等用户确认后再关页面，
  // 不能像普通进度步骤那样被下一句「更新数据库」覆盖掉。
  const [progressNotice, setProgressNotice] = useState('')
  // 清单自愈失败的语言：元数据已保存，但旧清单还没修好。编辑页顶部给非阻断提示 +
  // 手动重试入口；失败时不能自动关页，否则作者永远看不到「清单还是旧的」。
  const [manifestRepairLangs, setManifestRepairLangs] = useState([])
  const [manifestRepairBusy, setManifestRepairBusy] = useState(false)
  const [manifestRepairError, setManifestRepairError] = useState('')
  const [replaceErrors, setReplaceErrors] = useState([])
  const cancelRef = useRef(null)
  const [gamePath, setGamePath] = useState('')

  useEffect(() => {
    let cancelled = false
    const loadGamePath = async () => {
      try {
        const path = await getGamePath()
        if (!cancelled) setGamePath(path || '')
      } catch (e) {
        console.warn('[ModEditor] 读取游戏路径失败:', e)
      }
    }
    loadGamePath()
    return () => { cancelled = true }
  }, [])

  const maxZipSize = MAX_ZIP_SIZE
  const setFileSelectError = isEdit ? setUploadError : setError

  const rejectOversizedEntries = (entries) => {
    const oversized = entries.filter(e => !e.isDir && Number(e.size) > maxZipSize)
    if (oversized.length === 0) return entries
    setFileSelectError(t('workshop.modSelectedFileTooLarge', {
      max: maxZipSize / 1024 / 1024,
      files: summarizeOversizedFiles(oversized),
    }))
    return entries.filter(e => e.isDir || Number(e.size) <= maxZipSize)
  }

  // 新建：文件选择需要 mod_key 和版本号都已填写
  const version = translations[langList[0]]?.version || ''
  const canSelectFile = !!(modKey.trim() && version.trim())
  const isFormValid = !!(modKey.trim() && Object.values(translations).every(
    trans => trans.name.trim() && trans.version.trim() && trans.description.trim()
  ))

  // 编辑：按后端下发的权限决定哪些字段/语言可改
  const userPermissions = isEdit ? (initialMod.user_permissions || {}) : {}
  const canEditModInfo = !isEdit || !!userPermissions?.can_edit_mod_info || !!userPermissions?.is_author
  const canEditAllLangs = !isEdit || !!userPermissions?.can_edit_all_langs || !!userPermissions?.is_author
  const editableLangs = userPermissions?.editable_langs || []
  const canEditLang = (lang) => !isEdit || canEditAllLangs || editableLangs.includes(lang)
  const canDeleteFile = (lang) => canEditLang(lang) && (!existingFiles[lang] || !!userPermissions?.is_author || existingFiles[lang].can_delete === true)
  const hasAnyEditPermission = !isEdit || canEditModInfo || canEditAllLangs || editableLangs.length > 0

  // 同一语言改走「整包」路径后，之前构建的补丁包必须作废：
  // 保存阶段 patchLangs 与整包路径互斥，残留的待发布包会让保存被
  // patchWholeArchiveConflict 永久阻断（只能回面板点「放弃」才能解除）。
  const clearBuiltPatchForLang = (lang) => {
    setBuiltPatches(prev => {
      if (!prev[lang]) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
  }

  const handleSelectFolders = async (lang) => {
    if (!isEdit && !canSelectFile) return
    try {
      const entries = await selectModFolders({ gamePath, category, modKey })
      if (entries.length === 0) return
      const accepted = rejectOversizedEntries(entries)
      if (accepted.length === 0) return
      clearBuiltPatchForLang(lang)
      setModFiles(prev => {
        const existing = prev[lang] || []
        return { ...prev, [lang]: mergeEntries(existing, accepted) }
      })
    } catch (e) {
      setFileSelectError(t('workshop.selectFolderErr', { msg: e.message || t('mods.unknownError') }))
    }
  }

  const handleSelectFiles = async (lang) => {
    if (!isEdit && !canSelectFile) return
    try {
      const files = await selectModFiles({ category, gamePath })
      if (files.length === 0) return
      const accepted = rejectOversizedEntries(files)
      if (accepted.length === 0) return
      clearBuiltPatchForLang(lang)
      setModFiles(prev => {
        const existing = prev[lang] || []
        return { ...prev, [lang]: mergeEntries(existing, accepted) }
      })
    } catch (e) {
      setFileSelectError(t('workshop.selectFileErr', { msg: e.message || t('mods.unknownError') }))
    }
  }

  const handleAddLang = () => {
    if (!addLang || translations[addLang]) return
    setTranslations(prev => {
      const next = { ...prev, [addLang]: defaultTranslation() }
      const remaining = allLangs.filter(l => !Object.keys(next).includes(l))
      setAddLang(remaining[0] || '')
      return next
    })
  }

  const removeLangFromState = (lang) => {
    setPatchDrafts(prev => {
      if (!(lang in prev)) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
    setDraftDirtyLangs(prev => {
      if (!(lang in prev)) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
    setEmptyPatchLangs(prev => {
      if (!(lang in prev)) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
    setBuiltPatches(prev => {
      if (!prev[lang]) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
    setTranslations(prev => {
      const next = { ...prev }
      delete next[lang]
      const remaining = allLangs.filter(l => !Object.keys(next).includes(l))
      setAddLang(remaining[0] || '')
      return next
    })
  }

  // 新建：直接移除语言；编辑：先弹确认（可能存在已上传文件）
  const handleRemoveLang = (lang) => {
    if (isEdit) {
      setConfirmRemoveLang(lang)
    } else {
      removeLangFromState(lang)
    }
  }

  const handleConfirmRemoveLang = async () => {
    const lang = confirmRemoveLang
    if (!lang) return
    if (!canDeleteFile(lang)) {
      setUploadError(t('workshop.onlyDeleteOwnUpload'))
      setConfirmRemoveLang(null)
      return
    }
    if (existingFiles[lang]) {
      try {
        await deleteModFile({ author_id: user?.user_id || 0, mod_id: initialMod.id, lang_code: lang, fileUrl: existingFiles[lang].file_url })
        setExistingFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
      } catch (e) {
        setUploadError(localizeError(e))
        setConfirmRemoveLang(null)
        return
      }
    }
    removeLangFromState(lang)
    setConfirmRemoveLang(null)
  }

  const handleTransChange = (lang, field, value) => {
    setTranslations(prev => ({
      ...prev,
      [lang]: { ...prev[lang], [field]: value },
    }))
  }

  const handleRemoveFile = (lang, index) => {
    if (index === -1) {
      setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
    } else {
      setModFiles(prev => {
        const next = { ...prev }
        next[lang] = (next[lang] || []).filter((_, idx) => idx !== index)
        if (next[lang].length === 0) delete next[lang]
        return next
      })
    }
  }

  const handleUploadFile = async (lang) => {
    const files = modFiles[lang]
    if (!files || files.length === 0) return
    // 选择整包即改走整包路径：作废同语言已构建的补丁包，避免保存被冲突守卫阻断
    clearBuiltPatchForLang(lang)
    const controller = new AbortController()
    cancelRef.current = controller
    setUploadError('')
    setProgressError('')
    setProgressSpeed(0)
    setUploadingLang(lang)
    setProgressOpen(true)
    setProgressPercent(0)
    setProgressStep(t('workshop.compressingFile', { lang }))
    let keepOpen = false
    try {
      const manifest = JSON.stringify(files.map(f => f.zipPath || f.name))
      const zip = new JSZip()
      for (const file of files) {
        zip.file(file.zipPath || file.name, file.data)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      if (controller.signal.aborted) throw new Error('上传已取消')
      if (blob.size > maxZipSize) {
        setUploadError(t('workshop.modFileSizeWarning', { size: (blob.size / 1024 / 1024).toFixed(1), max: (maxZipSize / 1024 / 1024) }))
        setUploadingLang('')
        setProgressOpen(false)
        return
      }
      const zipFile = new File([blob], `${modKey}_${lang}.zip`, { type: 'application/zip' })
      setProgressStep(t('workshop.uploadingLang', { lang }))
      const res = await uploadModFile({
        author_id: user?.user_id || 0,
        mod_id: initialMod.id,
        lang_code: lang,
        version: translations[lang]?.version,
        file: zipFile,
        manifest,
        signal: controller.signal,
        onProgress: (loaded, total, speed) => {
          if (total) setProgressPercent(Math.round((loaded / total) * 90))
          setProgressSpeed(speed || 0)
        },
      })
      setExistingFiles(prev => ({ ...prev, [lang]: res.data }))
      setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
      setProgressPercent(100)
      setProgressStep(t('workshop.updatingDatabase'))
      // 不调 onUpdated()——让用户继续编辑其他语言/字段，由「保存」btn 统一收尾
    } catch (e) {
      if (controller.signal.aborted) {
        setUploadError(t('workshop.uploadCancelled'))
      } else {
        // 网络/上传错误：错误显示在弹窗内，等用户手动关闭
        setProgressError(e.message)
        keepOpen = true
      }
    } finally {
      cancelRef.current = null
      setUploadingLang('')
      setProgressSpeed(0)
      if (!keepOpen) setProgressOpen(false)
    }
  }

  const handleReplaceErrorClose = () => {
    setReplaceErrors([])
    setProgressOpen(false)
    onUpdated()
    onClose()
  }

  // 面板构建完成/失效时同步待发布状态（只记录，不发布）
  const handlePatchBuilt = useCallback((lang, payload) => {
    // 构建期间该语言被删除：异步结果已失去归属，直接丢弃，避免 builtPatches
    // 里残留一个不存在的语言（保存时会因 translations[lang] 缺失报版本错误）。
    if (!translationsRef.current[lang]) return
    setBuiltPatches(prev => {
      const next = { ...prev }
      if (payload?.workspace_id && payload.built) next[lang] = payload
      else delete next[lang]
      return next
    })
  }, [])

  // 保存时自动构建用的本地草稿（面板尚未点「构建」时由面板实时同步）。
  // 必须跨「收起面板 / 切换语言」保留：收起只是卸载面板 UI，改动仍要在保存时生效。
  const [patchDrafts, setPatchDrafts] = useState({})
  // 有未构建改动的语言：用于离开页面二次确认，避免静默丢弃用户选择。
  const [draftDirtyLangs, setDraftDirtyLangs] = useState({})
  // 文件列表被删空的语言：用于禁用页面「保存」并给出原因。
  const [emptyPatchLangs, setEmptyPatchLangs] = useState({})
  const getPatchDraft = useCallback((lang) => patchDrafts[lang], [patchDrafts])
  const handlePatchDraft = useCallback((lang, draft, remaining, dirty = false) => {
    // remaining === -2：面板卸载（收起/切语言/删除语言）。只清「空清单」标记，
    // 草稿必须原样保留——收起面板不等于放弃改动，保存时仍要按草稿构建；
    // 反过来也不能在这里写回草稿，否则删除语言后卸载会把已删除语言的草稿复活。
    if (remaining === -2) {
      setEmptyPatchLangs(prev => {
        if (!(lang in prev)) return prev
        const next = { ...prev }
        delete next[lang]
        return next
      })
      return
    }
    setPatchDrafts(prev => {
      if (draft) {
        if (prev[lang] === draft) return prev
        return { ...prev, [lang]: draft }
      }
      if (!(lang in prev)) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
    setDraftDirtyLangs(prev => {
      const hasDirty = !!draft && !!dirty
      if (!!prev[lang] === hasDirty) return prev
      const next = { ...prev }
      if (hasDirty) next[lang] = true
      else delete next[lang]
      return next
    })
    setEmptyPatchLangs(prev => {
      // remaining < 0 表示面板切换语言/显式丢弃，连空清单标记一起清掉
      if (remaining == null || remaining < 0) {
        if (!(lang in prev)) return prev
        const next = { ...prev }
        delete next[lang]
        return next
      }
      const isEmpty = remaining === 0
      if (!!prev[lang] === isEmpty) return prev
      const next = { ...prev }
      if (isEmpty) next[lang] = true
      else delete next[lang]
      return next
    })
  }, [])

  // 类型切换会改变条目路径的归一规则与安装端落盘方式：
  // 已构建产物与本地草稿都作废，强制作者重新选择并重新构建。
  const handleSetCategory = useCallback((next) => {
    if (next === category) return
    setPatchDrafts({})
    setDraftDirtyLangs({})
    setEmptyPatchLangs({})
    setBuiltPatches({})
    setCategory(next)
  }, [category])
  const hasUnsavedDraft = Object.keys(draftDirtyLangs).length > 0

  // 补丁包发布成功后：更新本地已有文件快照，让后续保存/渲染看到新版本
  const applyPublishedFile = (lang, res) => {
    if (!res) return
    // 工作区已随发布删除：对应草稿与未保存标记一并清掉
    setPatchDrafts(prev => {
      if (!(lang in prev)) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
    setDraftDirtyLangs(prev => {
      if (!(lang in prev)) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
    setEmptyPatchLangs(prev => {
      if (!(lang in prev)) return prev
      const next = { ...prev }
      delete next[lang]
      return next
    })
    setExistingFiles(prev => ({
      ...prev,
      [lang]: {
        lang_code: lang,
        file_url: res.file_url,
        file_name: res.file_name,
        file_size: res.file_size,
        file_hash: res.file_hash,
        file_hashes: res.file_hashes,
        version: res.version,
        manifest: res.manifest,
        can_delete: res.changed || res.repacked ? true : prev[lang]?.can_delete,
      },
    }))
    // 面板内可能改过版本号：始终把表单版本同步为实际生效的版本。
    // 幂等发布（内容未变化）时 res.version 就是原版本。
    if (res.version != null) {
      setTranslations(prev => {
        const cur = prev[lang]
        if (!cur || cur.version === res.version) return prev
        return { ...prev, [lang]: { ...cur, version: res.version } }
      })
    }
  }

  // 进度弹窗「取消」：上传中则真正中断（Rust 侧结束请求）；已出错则仅关闭弹窗并把错误保留在页面；
  // 幂等/清单修正提示的「关闭」则是确认，随后刷新父页面并退出编辑页。
  const handleProgressCancel = () => {
    if (cancelRef.current) {
      cancelRef.current.abort()
      setProgressStep(t('workshop.cancellingUpload'))
      return
    }
    if (progressNotice) {
      setProgressNotice('')
      setProgressOpen(false)
      setProgressError('')
      setProgressSpeed(0)
      // 还有清单没修好：留在编辑页显示顶部提示，不能顺手关页
      if (manifestRepairLangs.length > 0) {
        onRefresh?.()
        return
      }
      onUpdated()
      onClose()
      return
    }
    if (progressError) setError(progressError)
    setProgressOpen(false)
    setProgressError('')
    setProgressSpeed(0)
  }

  const handleSubmit = async () => {
    if (!isEdit && !modKey.trim()) {
      setError(t('workshop.modIdEmpty'))
      return
    }
    setError('')
    setProgressNotice('')
    setManifestRepairError('')
    setBusy(true)
    if (isEdit) setReplaceErrors([])
    try {
      const newModKey = modKey.trim()

      if (!isEdit) {
        // 1. 先检查 mod_key 是否可用
        const keyCheck = await checkModKey(newModKey)
        if (keyCheck.exists) {
          setError('已存在，请前往更新对应语言文件')
          return
        }

        // 2. 先创建 mod 拿到 mod_id（instructions 先留空，避免图片上传失败时数据库残留占位符）
        const emptyInstructionsTranslations = {}
        for (const [lang, trans] of Object.entries(translations)) {
          emptyInstructionsTranslations[lang] = { ...trans, instructions: '' }
        }
        const createResult = await createMod({ author_id: user.user_id, mod_key: newModKey, translations: emptyInstructionsTranslations, category, is_original: isOriginal })
        const newModId = createResult.data.mod_id

        // 3. 上传 mod 文件（所有 category 统一走 runReplaceFlow 的"压缩+上传+进度+错误收集"流程）
        const fileLangs = Object.keys(modFiles).filter(lang => modFiles[lang] && modFiles[lang].length > 0)
        if (fileLangs.length > 0) {
          const controller = new AbortController()
          cancelRef.current = controller
          setProgressOpen(true)
          setProgressPercent(0)
          setProgressSpeed(0)
          setProgressError('')
          setProgressStep(t('workshop.updatingFiles'))
          const langEntries = fileLangs.map(lang => ({
            lang,
            files: modFiles[lang],
            version: translations[lang]?.version,
            existing: null, // 新发布没有旧文件
          }))
          let result
          try {
            result = await runReplaceFlow({
              authorId: user.user_id,
              modId: newModId,
              modKey: newModKey,
              langEntries,
              maxZipSize,
              t,
              signal: controller.signal,
              onProgress: ({ percent, step, speed }) => {
                setProgressPercent(percent)
                setProgressStep(step)
                setProgressSpeed(speed || 0)
              },
              onLangStart: (lang) => setUploadingLang(lang),
              onLangUploaded: (lang) => {
                setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
              },
            })
          } catch (e) {
            cancelRef.current = null
            setProgressSpeed(0)
            setUploadingLang('')
            if (controller.signal.aborted) {
              // 用户主动取消
              setProgressOpen(false)
              setError(t('workshop.uploadCancelled'))
            } else {
              // 网络/上传错误：保留弹窗并把错误显示在弹窗内，等待用户手动关闭
              setProgressError(e.message)
            }
            setBusy(false)
            return
          }
          cancelRef.current = null
          if (!result.ok) {
            // 超大 zip 或用户取消：保留已生成的 mod 记录，提示用户
            setProgressOpen(false)
            setProgressSpeed(0)
            setUploadingLang('')
            setError(result.cancelled
              ? t('workshop.uploadCancelled')
              : (result.errors[0]?.msg || t('workshop.modFileSizeWarning', { size: 0, max: (maxZipSize / 1024 / 1024) })))
            setBusy(false)
            return
          }
          setProgressSpeed(0)
          setProgressStep(t('workshop.updatingDatabase'))
          setProgressPercent(100)
        }
        setUploadingLang('')
        setProgressOpen(false)

        // 4. 上传说明中的图片并替换占位符
        const { translations: resolvedTranslations, uploaded } = await resolveTranslationImages(translations, newModId)
        try {
          await updateMod({ author_id: user.user_id, mod_id: newModId, category, translations: resolvedTranslations, is_original: isOriginal })
        } catch (e) {
          // 内容没落库：清掉刚上传的图片，避免成为无人引用的孤儿
          deleteUploadedImages(uploaded)
          throw e
        }

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
        return
      }

      // ===== 编辑 =====
      // 0. mod_key 变更校验：非空、长度（后端按 64 字符限制）、值变化时查重
      if (!newModKey) {
        setError(t('workshop.modIdEmpty'))
        return
      }
      if (newModKey !== (initialMod.mod_key || '').trim()) {
        const keyCheck = await checkModKey(newModKey)
        if (keyCheck.exists) {
          setError('已存在，请前往更新对应语言文件')
          return
        }
      }

      // 1. 收集需要处理的语言
      const pendingLangs = Object.keys(modFiles).filter(lang => modFiles[lang] && modFiles[lang].length > 0)

      // 已构建的待发布补丁包：保存时统一发布。
      // 同一语言只能走一条发布路径，整包与补丁包不能同时进入本次保存。
      const builtPatchLangs = Object.keys(builtPatches).filter(lang => builtPatches[lang]?.built)
      const conflictLang = builtPatchLangs.find(lang => modFiles[lang] && modFiles[lang].length > 0)
      if (conflictLang) {
        setError(t('workshop.patchWholeArchiveConflict', { lang: conflictLang }))
        setBusy(false)
        return
      }

      // 关键：本地 diff 必须先构建再发布。
      // 只要该语言有工作区草稿（localStorage 指针）或本次已有 draft，且不是
      // 明确走「整包替换」（modFiles[lang] 非空，那条路径自己会重新打包整包），
      // 保存时就在发布前自动构建；构建失败立即中止，绝不发布旧产物。
      // 只处理「有编辑权限 + 库记录完整（有 file_hash）」的语言：
      // 无权限或旧数据的语言跳过，不能因为它的打开失败拖垮整次保存。
      const canSaveLang = (lang) => canEditLang(lang) && !!existingFiles[lang]?.file_hash
      // 收集候选：本次会话已构建的 + 存在工作区指针的语言。
      const pointerLangs = Object.keys(existingFiles).filter(lang => {
        if (!isEdit) return false
        if (!canSaveLang(lang)) return false
        if (modFiles[lang] && modFiles[lang].length > 0) return false
        return !!localStorage.getItem(modEditWorkspaceKey(user?.user_id || 0, initialMod.id, lang))
      })
      // 即使没有工作区指针，也要逐语言打开一次工作区：打开动作会按当前分类
      // 归一库里的 manifest（删目录条目），并由 manifest_dirty 标出「需要写回」。
      // 这样作者不打开补丁面板、直接再保存一次也能纠正旧清单。
      const manifestLangs = Object.keys(existingFiles).filter(lang => {
        if (!isEdit) return false
        if (!canSaveLang(lang)) return false
        return !(modFiles[lang] && modFiles[lang].length > 0)
      })
      const autoBuildLangs = [...new Set([...builtPatchLangs, ...pointerLangs, ...manifestLangs])]
        .filter(lang => !(modFiles[lang] && modFiles[lang].length > 0))
        .filter(lang => !builtPatches[lang]?.built)
      const resolvedPatches = { ...builtPatches }
      // 「只做清单自愈」的语言：本次没有任何文件改动，构建只为把归一后的旧清单写回。
      // 这类语言的构建/发布失败只能降级为提示，不能阻断元数据保存（旧清单留待下次保存重试）。
      const repairOnlyLangs = new Set()
      // 清单自愈这次没修好的语言（打开/构建/发布任一步失败）：元数据照样保存，
      // 但要把编辑页留在前台显示提示，并提供手动重试入口。
      const repairFailedLangs = new Set()
      // 幂等发布（内容未变化，版本保持不变）与清单修正的提示，最后统一展示并等用户确认
      const idempotentNotices = []
      // 本次真正发布出去的语言版本：幂等/清单自愈/历史包重打时后端保持基线版本，
      // 写库时必须按这里覆盖作者输入，否则会出现「提示版本没变、库里却变了」。
      const publishedVersions = {}
      // 这些语言有本次会话的构建产物或工作区指针：打开/构建失败必须中止保存。
      // 其余语言只是「顺手重新打开归一清单」，失败可以跳过。
      const strictLangs = new Set([...builtPatchLangs, ...pointerLangs])
      if (autoBuildLangs.length > 0) {
        setProgressOpen(true)
        setProgressPercent(0)
        setProgressSpeed(0)
        setProgressError('')
        cancelRef.current = null
        for (const lang of autoBuildLangs) {
          const pointer = localStorage.getItem(modEditWorkspaceKey(user?.user_id || 0, initialMod.id, lang))
          setProgressStep(t('workshop.patchBuildingOnSave', { lang }))
          let view
          try {
            // 复用既有工作区：默认不下载底包，只读取草稿状态
            view = await openModEditWorkspace({
              mod_id: initialMod.id,
              user_id: user?.user_id || 0,
              lang_code: lang,
              workspace_id: pointer,
              force: false,
              // 用编辑表单当前分类归一：分类决定条目路径的安装根
              category,
            })
          } catch (e) {
            // 无权限/旧数据（缺 file_hash）的语言已在候选阶段过滤；这里再兜底：
            // 非用户实际改动的语言打开失败时跳过，不让它拖垮整次保存。
            if (!strictLangs.has(lang)) {
              console.warn(`[ModEditor] 跳过语言 ${lang} 的清单归一：`, e)
              repairFailedLangs.add(lang)
              continue
            }
            setProgressError(localizeError(t, e?.message || String(e)))
            setBusy(false)
            return
          }
          // 基线已变化时草稿会被后端丢弃：此时继续用内存 draft 构建会基于旧底包，必须中止
          if (view?.staleDraftDiscarded) {
            setProgressError(t('workshop.patchStaleDraft'))
            setBusy(false)
            return
          }
          const draft = patchDrafts[lang]
          // 面板只要打开就会同步一份结构化的空 draft，不能把「空数组」当成有 diff。
          const draftHasChanges = !!draft && (
            (draft.selected || []).length > 0
            || (draft.excluded || []).length > 0
            || (draft.added || []).length > 0
            || (draft.replaced || []).length > 0
          )
          // 是否有真正需要重传内容的改动。manifest_dirty 不算：清单归一本身不改变
          // 文件内容，只由发布阶段的 manifest-only 分支条件更新。
          const contentHasDiff = !!view?.built
            || Object.keys(view?.staged || {}).length > 0
            || (view?.added || []).length > 0
            || (view?.excluded || []).length > 0
            || draftHasChanges
          // 只有清单需要自愈（旧清单含目录条目/历史前缀）的语言：尽力修，失败不阻断保存
          const manifestOnly = !!view?.manifest_dirty && !contentHasDiff
          if (!contentHasDiff && !manifestOnly) {
            // 指针存在但没有本地 diff（例如只打开过面板）：不构建、不发布。
            // 后端工作区一并丢弃，避免频繁保存时在磁盘上累积无主工作区
            //（有 TTL 兜底，尽早回收配额）；丢弃失败不阻断保存。
            const staleWsId = view?.workspace_id || pointer
            if (staleWsId) {
              try {
                await discardModEditWorkspace({ workspace_id: staleWsId, user_id: user?.user_id || 0 })
              } catch (discardErr) {
                console.warn(`[ModEditor] 丢弃语言 ${lang} 的空工作区失败（TTL 会兜底清理）：`, discardErr)
              }
            }
            localStorage.removeItem(modEditWorkspaceKey(user?.user_id || 0, initialMod.id, lang))
            continue
          }
          // 空清单前端拦截（后端构建与发布还有两道校验）。
          // 口径与后端 build_package_inner 一致：清单条目只有「删除」时不写入，
          // 未勾选只是保留基线；新增条目未勾选不写入；同路径只算一次。
          // 草稿是面板最后一次上报的完整快照，有草稿时以草稿为准：不能再与后端
          // meta.excluded 取并集，否则「构建后撤销删除」会被后端旧快照重新排掉。
          const excludedSet = new Set(draft ? (draft.excluded || []) : (view?.excluded || []))
          const selectedSet = new Set(draft ? (draft.selected || []) : (view?.selected || []))
          const backendAdded = new Set(view?.added || [])
          const kept = new Set()
          for (const entry of view?.entries || []) {
            if (excludedSet.has(entry.path)) continue
            if (backendAdded.has(entry.path) && !selectedSet.has(entry.path)) continue
            kept.add(entry.path)
          }
          for (const add of draft?.added || []) {
            if (excludedSet.has(add.path) || !selectedSet.has(add.path)) continue
            kept.add(add.path)
          }
          if (kept.size === 0 && !manifestOnly) {
            setProgressError(t('workshop.patchEmptyManifestRejected'))
            setBusy(false)
            return
          }
          try {
            const res = await buildModEditPackage({
              workspace_id: view?.workspace_id || pointer,
              user_id: user?.user_id || 0,
              draft,
              category,
            })
            // 只为清单自愈而构建时，若构建结果其实有内容变化（例如历史包路径归一
            // 造成的差异），不在此静默发布：那需要作者升版本，留给下次带改动的保存处理。
            if (manifestOnly && res.built?.changed) {
              console.warn(`[ModEditor] 语言 ${lang} 清单自愈构建出现内容变化，本次跳过自愈`)
              repairFailedLangs.add(lang)
              continue
            }
            if (manifestOnly) repairOnlyLangs.add(lang)
            resolvedPatches[lang] = {
              workspace_id: view?.workspace_id || pointer,
              built: res.built,
            }
            // 面板里显示的待发布状态同步更新（若面板仍开着）
            handlePatchBuilt(lang, resolvedPatches[lang])
          } catch (e) {
            // 清单自愈失败不影响元数据保存：保留工作区指针，下次保存继续重试
            if (manifestOnly) {
              console.warn(`[ModEditor] 语言 ${lang} 清单自愈失败，跳过：`, e)
              repairFailedLangs.add(lang)
              continue
            }
            setProgressError(localizeError(t, e?.message || String(e)))
            setBusy(false)
            return
          }
        }
      }
      // 无权限语言不参与发布：跳过而不是让整次保存失败
      const patchLangs = Object.keys(resolvedPatches).filter(lang => resolvedPatches[lang]?.built && canEditLang(lang))

      // 版本号会拼进远端对象路径：内容有变化时必须高于基线，且字符集与后端一致
      for (const lang of patchLangs) {
        if (!resolvedPatches[lang].built.changed) continue
        const target = (translations[lang]?.version || '').trim()
        if (!VERSION_PATTERN.test(target)) {
          // 自动构建可能刚打开了进度弹窗：这里中止必须把它关掉，否则会停在「构建中」
          setProgressOpen(false)
          setError(t('workshop.patchVersionInvalid'))
          return
        }
        const baseVersion = existingFiles[lang]?.version || '0.0.0'
        if (compareSemver(target || '0.0.0', baseVersion) <= 0) {
          setProgressOpen(false)
          setError(t('workshop.patchVersionRequired', { version: baseVersion }))
          return
        }
      }

      // 检查版本变更但没有新文件的语言（用户需要重新选文件）；补丁包语言由补丁发布消化
      const versionChangedOnly = Object.keys(existingFiles).filter(lang => {
        const ef = existingFiles[lang]
        return ef && translations[lang] && translations[lang].version !== ef.version
          && (!modFiles[lang] || modFiles[lang].length === 0)
          && !patchLangs.includes(lang)
      })
      if (versionChangedOnly.length > 0) {
        setProgressOpen(false)
        setError(t('workshop.versionChangedHint', { lang: versionChangedOnly[0] }))
        return
      }

      // 其余 language 统一走"保存即替换"的整包流程（v1 / composite / dll / v2）
      const replaceLangs = pendingLangs.filter(lang => !patchLangs.includes(lang))

      let replaceErrorList = []
      let patchFailed = false

      // 保存阶段先发布补丁包：上传 → 事务条件更新 → 清理旧对象 → 乐观锁
      if (patchLangs.length > 0) {
        setProgressOpen(true)
        setProgressPercent(0)
        setProgressSpeed(0)
        setProgressError('')
        // 补丁发布没有可中断的上传句柄：不设置 cancelRef，避免「取消」误报已中断
        cancelRef.current = null
        for (const lang of patchLangs) {
          const wsId = resolvedPatches[lang].workspace_id
          setProgressStep(t('workshop.patchUploadingOnSave', { lang }))
          setProgressPercent(0)
          const unlisten = await listen('mod-edit-publish-progress', (event) => {
            const p = event.payload || {}
            if (p.workspace_id !== wsId) return
            if (p.stage === 'uploading' && p.total) {
              setProgressPercent(Math.min(99, Math.round((p.loaded / p.total) * 100)))
            } else if (p.stage === 'committing') {
              setProgressPercent(100)
              setProgressStep(t('workshop.patchCommitProgress'))
            } else if (p.stage === 'retrying') {
              // 后端遇到池忙/超时/连接被断开/死锁时的自动重试进度
              setProgressStep(t('workshop.patchDbRetrying', {
                n: p.attempt || p.loaded || 0,
                total: p.max_attempts || p.total || 0,
              }))
            }
          })
          try {
            const res = await publishModEditPackage({
              workspace_id: wsId,
              author_id: user?.user_id || 0,
              version: (translations[lang]?.version || '').trim(),
              force: !!import.meta.env.DEV,
            })
            // 发布成功后后端已删除工作区，前端指针与待发布状态一并清掉
            localStorage.removeItem(modEditWorkspaceKey(user?.user_id || 0, initialMod.id, lang))
            applyPublishedFile(lang, res)
            if (res?.version != null) publishedVersions[lang] = res.version
            setBuiltPatches(prev => {
              const next = { ...prev }
              delete next[lang]
              return next
            })
            if (res.idempotent) {
              // 内容未变化：后端按幂等成功处理，版本保持基线，这里如实提示。
              // 提示先收集，等所有语言发布完、元数据也保存后再展示，避免被
              // 紧接着的「更新数据库」覆盖而一闪而过。
              // 历史包条目未归一时会连包一起重打（repacked），提示要说明这一点，
              // 不能让人误以为「什么都没重新上传」。
              const noticeKey = res.repacked
                ? 'workshop.patchManifestRepacked'
                : (res.manifestFixed ? 'workshop.patchManifestFixed' : 'workshop.patchIdempotent')
              idempotentNotices.push(t('workshop.noticeLangLine', { lang, message: t(noticeKey, { version: res.version }) }))
            }
          } catch (e) {
            // 清单自愈的发布失败不上抛：内容与元数据都已经确定，旧清单留待下次保存重试
            if (repairOnlyLangs.has(lang)) {
              console.warn(`[ModEditor] 语言 ${lang} 清单自愈发布失败，跳过：`, e)
              repairFailedLangs.add(lang)
              delete resolvedPatches[lang]
              continue
            }
            // 失败保留工作区与待发布状态，便于用户修正后重试
            setProgressError(localizeError(t, e?.message || String(e)))
            setUploadingLang('')
            patchFailed = true
            break
          } finally {
            unlisten()
          }
        }
        cancelRef.current = null
        if (patchFailed) {
          setBusy(false)
          return
        }
        setProgressPercent(100)
        setProgressStep(t('workshop.updatingDatabase'))
      }

      if (replaceLangs.length > 0) {
        const controller = new AbortController()
        cancelRef.current = controller
        setProgressOpen(true)
        setProgressPercent(0)
        setProgressSpeed(0)
        setProgressError('')
        setProgressStep(t('workshop.updatingFiles'))

        const langEntries = replaceLangs.map(lang => ({
          lang,
          files: modFiles[lang],
          version: translations[lang]?.version,
          existing: existingFiles[lang],
        }))

        let result
        try {
          result = await runReplaceFlow({
            authorId: user?.user_id || 0,
            modId: initialMod.id,
            modKey,
            langEntries,
            maxZipSize,
            t,
            signal: controller.signal,
            onProgress: ({ percent, step, speed }) => {
              setProgressPercent(percent)
              setProgressStep(step)
              setProgressSpeed(speed || 0)
            },
            onLangStart: (lang) => setUploadingLang(lang),
            onLangUploaded: (lang, res) => {
              setExistingFiles(prev => ({ ...prev, [lang]: res.data }))
              setModFiles(prev => { const n = { ...prev }; delete n[lang]; return n })
            },
          })
        } catch (e) {
          cancelRef.current = null
          setProgressSpeed(0)
          setUploadingLang('')
          if (controller.signal.aborted) {
            setProgressOpen(false)
            setError(t('workshop.uploadCancelled'))
          } else {
            // 网络/上传错误：保留弹窗并把错误显示在弹窗内，等待用户手动关闭
            setProgressError(e.message)
          }
          setBusy(false)
          return
        }
        cancelRef.current = null

        if (result.cancelled) {
          setProgressOpen(false)
          setProgressSpeed(0)
          setUploadingLang('')
          setError(t('workshop.uploadCancelled'))
          setBusy(false)
          return
        }

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
        setProgressSpeed(0)
        setProgressStep(t('workshop.updatingDatabase'))
        setProgressPercent(100)
      }
      setReplaceErrors(replaceErrorList)

      // 清空待上传队列（runReplaceFlow 的 onLangUploaded 已逐语言清空，这里保险再清一次）
      setModFiles({})
      setUploadingLang('')

      // 2. 上传说明中的图片并替换占位符
      // 版本号以本次实际发布的版本为准（幂等/清单自愈/重打都保持基线版本），
      // 避免出现「提示版本没变，updateMod 却把表单里的版本写进库里」的静默降级。
      const writeTranslations = applyPublishedVersions(translations, publishedVersions)
      const { translations: resolvedTranslations, uploaded } = await resolveTranslationImages(writeTranslations, initialMod.id)

      // 3. 清理被删除的图片（updateMod 成功后异步处理，不阻塞 UI）
      // 跨语言汇总后再比对：同一张图可能被多个语言共用，只要还有引用就不能删。
      const cleanupImages = () => {
        const oldUrls = new Set(
          Object.values(originalInstructionsRef.current).flatMap(extractImgbedUrls),
        )
        const newUrls = new Set(
          Object.values(resolvedTranslations).flatMap(tr => extractImgbedUrls(tr?.instructions || '')),
        )
        const removed = [...oldUrls].filter(url => !newUrls.has(url))
        if (removed.length === 0) return
        cleanupImagesFromImgbed(removed).catch(e => console.warn('删除 mod 图片失败:', e))
      }

      // 4. 更新翻译信息（含 mod_key 变更；dev 下 force 跳过后端权限校验）
      try {
        await updateMod({ author_id: user?.user_id || 0, mod_id: initialMod.id, category, translations: resolvedTranslations, is_original: isOriginal, mod_key: newModKey, force: !!import.meta.env.DEV })
      } catch (e) {
        // 内容没落库：清掉刚上传的图片，避免成为无人引用的孤儿
        deleteUploadedImages(uploaded)
        throw e
      }
      cleanupImages()

      // 5. 保存权限设置
      if (userPermissions?.is_author && permissions.mode !== 'author_only') {
        try {
          await setModPermissions({ author_id: user?.user_id || 0, mod_id: initialMod.id, ...permissions })
        } catch (e) {
          console.warn('Failed to save permissions:', e)
        }
      } else if (userPermissions?.is_author) {
        // 切回仅作者时，更新权限
        try {
          await setModPermissions({ author_id: user?.user_id || 0, mod_id: initialMod.id, mode: 'author_only', open_langs: null, allow_mod_info: true, allow_lang: true, apply_langs: null })
        } catch (e) {
          console.warn('Failed to reset permissions:', e)
        }
      }

      // 清单自愈的结果如实反映到编辑页顶部：修好了就消失，没修好就留着并给重试入口。
      setManifestRepairLangs([...repairFailedLangs])
      if (replaceErrorList.length > 0) {
        setProgressOpen(false)
      } else if (idempotentNotices.length > 0) {
        // 幂等/清单修正必须让作者看到并确认：停在完成态，等点「关闭」后再刷新并退出编辑页。
        // 否则版本保持不变却自动关页，作者会误以为新内容已经发布。
        const notice = idempotentNotices.join('\n')
        setProgressPercent(100)
        setProgressSpeed(0)
        setProgressError('')
        setProgressStep(notice)
        setProgressNotice(notice)
      } else if (repairFailedLangs.size > 0) {
        // 元数据已保存，只是旧清单没修好：不自动关页（否则提示没人看得到），
        // 顶部横幅提示 + 「重试修复」入口，且不影响作者继续编辑/关闭。
        setProgressOpen(false)
        onRefresh?.()
      } else {
        setProgressOpen(false)
        onUpdated()
        onClose()
      }
    } catch (e) {
      setError(e.message)
      if (isEdit) setProgressOpen(false)
    } finally {
      setBusy(false)
    }
  }

  // 清单自愈手动重试：只处理「清单待修复且没有内容改动」的语言。
  // 成功一门就从未修复列表移除；仍有内容改动的语言不能借清单修复免升版本发布，
  // 保留在列表里并提示走正常保存。
  const handleManifestRepairRetry = async () => {
    // 保存进行中不允许并发重试：两边都会写同一行 mod_files
    if (busy || manifestRepairBusy || manifestRepairLangs.length === 0) return
    setManifestRepairBusy(true)
    setManifestRepairError('')
    const remaining = []
    try {
      for (const lang of manifestRepairLangs) {
        // 语言已被作者删掉：不再修复（下一次正常保存会把该行一起处理）
        if (!translations[lang]) continue
        const pointerKey = modEditWorkspaceKey(user?.user_id || 0, initialMod.id, lang)
        const pointer = localStorage.getItem(pointerKey)
        try {
          const view = await openModEditWorkspace({
            mod_id: initialMod.id,
            user_id: user?.user_id || 0,
            lang_code: lang,
            workspace_id: pointer,
            force: false,
            category,
          })
          if (view?.staleDraftDiscarded) {
            remaining.push(lang)
            setManifestRepairError(t('workshop.patchStaleDraft'))
            continue
          }
          // 只认「真的会改变文件内容」的痕迹：上一次清单自愈的成功构建
          //（built.changed=false）不能把重试挡在门外；草稿是否真的动过
          // 由面板上报的 dirty 标记判断（payload.selected 默认就含基线条目，不能用它判断）。
          const draftDirty = !!draftDirtyLangs[lang]
          const contentHasDiff = !!view?.built?.changed
            || Object.keys(view?.staged || {}).length > 0
            || (view?.added || []).length > 0
            || (view?.excluded || []).length > 0
            || draftDirty
          if (contentHasDiff) {
            remaining.push(lang)
            setManifestRepairError(t('workshop.patchManifestRepairNeedsSave'))
            continue
          }
          if (!view?.manifest_dirty) {
            // 已经被其他保存路径修好了：直接从待修复列表移除
            localStorage.removeItem(pointerKey)
            continue
          }
          const res = await buildModEditPackage({
            workspace_id: view?.workspace_id || pointer,
            user_id: user?.user_id || 0,
            draft: null,
            category,
          })
          if (!res?.built || res.built.changed) {
            // 构建结果带内容变化：不能按「清单修复」发布，需要正常保存并升版本
            remaining.push(lang)
            setManifestRepairError(t('workshop.patchManifestRepairNeedsSave'))
            continue
          }
          const pubRes = await publishModEditPackage({
            workspace_id: view?.workspace_id || pointer,
            author_id: user?.user_id || 0,
            version: (translations[lang]?.version || '').trim(),
            force: !!import.meta.env.DEV,
          })
          localStorage.removeItem(pointerKey)
          applyPublishedFile(lang, pubRes)
          setBuiltPatches(prev => {
            if (!(lang in prev)) return prev
            const next = { ...prev }
            delete next[lang]
            return next
          })
        } catch (e) {
          remaining.push(lang)
          setManifestRepairError(
            t('workshop.patchManifestRepairRetryFailed', {
              error: localizeError(t, e?.message || String(e)),
            })
          )
        }
      }
    } finally {
      setManifestRepairLangs(remaining)
      setManifestRepairBusy(false)
    }
  }

  return {
    isEdit,
    modId: initialMod?.id || 0,
    modKey, setModKey,
    category, setCategory: handleSetCategory,
    isOriginal, setIsOriginal,
    translations, langList, availableLangs,
    addLang, setAddLang,
    permissions, setPermissions,
    existingFiles,
    busy, error, uploadError,
    modFiles, uploadingLang,
    fileDialogLang, setFileDialogLang,
    confirmRemoveLang, setConfirmRemoveLang,
    replaceErrors,
    progressOpen, progressPercent, progressStep, progressSpeed, progressError, progressNotice,
    manifestRepairLangs, manifestRepairBusy, manifestRepairError, handleManifestRepairRetry,
    maxZipSize,
    canSelectFile,
    isFormValid,
    canEditModInfo,
    canEditAllLangs,
    canEditLang,
    canDeleteFile,
    hasAnyEditPermission,
    userPermissions,
    handleSelectFolders,
    handleSelectFiles,
    handleAddLang,
    handleRemoveLang,
    handleConfirmRemoveLang,
    handleTransChange,
    handleRemoveFile,
    handleUploadFile,
    builtPatches,
    emptyPatchLangs,
    hasUnsavedDraft,
    getPatchDraft,
    handlePatchBuilt,
    handlePatchDraft,
    handleReplaceErrorClose,
    handleProgressCancel,
    handleSubmit,
  }
}
