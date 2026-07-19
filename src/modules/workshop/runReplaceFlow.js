import JSZip from 'jszip'
import { uploadModFile, deleteImgbedFile } from '../../services/workshopApi'

/**
 * 统一的"压缩 + 上传 + 删旧 + 进度 + 错误收集"流程。
 * 供 v1 / composite / dll / 等所有"保存即替换"语义的发布与更新复用。
 *
 * 约定：files 内每个条目形如
 *   { zipPath: string, data: Uint8Array, size: number, isDir?: boolean }
 * 压缩时：
 *   - isDir=true  → zip.folder(zipPath)（显式空目录条目）
 *   - 其它        → zip.file(zipPath, data)
 * manifest = JSON.stringify([
 *   ...非目录条目的 zipPath,
 *   ...目录条目的 zipPath + '/',  // 末尾 / 标识目录
 * ])
 *
 * @param {object}   opts
 * @param {string}   opts.authorId
 * @param {number}   opts.modId
 * @param {string}   opts.modKey
 * @param {Array<{lang:string, files:Array, version?:string, existing?:object}>} opts.langEntries
 * @param {number}   opts.maxZipSize
 * @param {boolean}  opts.r2Enabled
 * @param {function} opts.t                    i18n t 函数
 * @param {function} opts.onProgress          ({percent, step}) => void
 * @param {function} opts.onLangStart         (lang) => void
 * @param {function} opts.onLangUploaded      (lang, res) => void
 * @returns {Promise<{ ok: boolean, errors: Array<{lang:string,msg:string}>, abortedLang?: string }>}
 *   - ok=true 表示所有语言均成功
 *   - errors  收集每个语言的失败信息（含删除旧文件失败）
 *   - 遇到超大 zip 会立即返回 ok=false, abortedLang=当前 lang
 */
export async function runReplaceFlow({
  authorId,
  modId,
  modKey,
  langEntries,
  maxZipSize,
  r2Enabled,
  t,
  onProgress,
  onLangStart,
  onLangUploaded,
}) {
  const errors = []
  const total = langEntries.length

  for (let i = 0; i < langEntries.length; i++) {
    const { lang, files, version, existing } = langEntries[i]
    const langLabel = lang // 调用方可自行传入 label，这里保持兼容
    const updateProgress = (subProgress, stepText) => {
      if (onProgress) onProgress({ percent: Math.round(((i + subProgress) / total) * 100), step: stepText })
    }

    if (onLangStart) onLangStart(lang)
    updateProgress(0, t('workshop.compressingFile', { lang: langLabel }))

    // 压缩
    const zip = new JSZip()
    const fileZipPaths = []
    const dirZipPaths = []
    for (const file of files) {
      if (file.isDir) {
        zip.folder(file.zipPath)
        dirZipPaths.push(file.zipPath)
      } else {
        zip.file(file.zipPath || file.name, file.data)
        fileZipPaths.push(file.zipPath || file.name)
      }
    }
    const manifest = JSON.stringify([...fileZipPaths, ...dirZipPaths.map(d => d + '/')])
    const blob = await zip.generateAsync({ type: 'blob' })
    if (blob.size > maxZipSize) {
      errors.push({ lang: langLabel, msg: t('workshop.modFileSizeWarning', { size: (blob.size / 1024 / 1024).toFixed(1), max: (maxZipSize / 1024 / 1024) }) })
      return { ok: false, errors, abortedLang: lang }
    }

    // 上传
    const oldFile = existing
    const zipFileName = oldFile ? oldFile.file_name : `${modKey}_${lang}.zip`
    const zipFile = new File([blob], zipFileName, { type: 'application/zip' })

    const res = await uploadModFile({
      author_id: authorId,
      mod_id: modId,
      lang_code: lang,
      version,
      file: zipFile,
      manifest,
      r2_enabled: r2Enabled,
      onProgress: (loaded, total) => {
        const subProgress = total ? (loaded / total) * 0.8 : 0
        updateProgress(subProgress, t('workshop.uploadingLang', { lang: langLabel }))
      },
    })

    // 删旧
    updateProgress(0.9, t('workshop.deletingOldFile', { lang: langLabel }))
    if (oldFile?.file_url) {
      try {
        await deleteImgbedFile(oldFile.file_url)
      } catch (e) {
        console.warn(`删除旧文件失败: ${oldFile.file_url}`, e)
        errors.push({ lang: langLabel, msg: e.message })
      }
    }

    if (onLangUploaded) onLangUploaded(lang, res)
  }

  if (onProgress) onProgress({ percent: 100, step: t('workshop.updatingDatabase') })
  return { ok: errors.length === 0, errors }
}
