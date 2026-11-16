import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Badge,
  makeStyles, tokens,
  Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogTrigger, DialogActions, Textarea, Select, Checkbox,
  Menu, MenuTrigger, MenuList, MenuItem, MenuPopover,
  Toast, ToastBody, ToastTitle, useToastController,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  Edit24Regular, Add24Regular, Delete24Regular,
  Heart24Regular, Heart24Filled,
} from '@fluentui/react-icons'
import { installMod, uninstallMod, downloadModArchive, checkModOverwrite } from '../../services/installMod'
import { sendToNdm, copyText } from '../../services/ndmApi'
import { useDownloadCenter } from '../../contexts/useDownloadCenter'
import { RichTextContent, MarkdownContent } from '../../components/common/RichTextEditor'
import { Lightbox } from '../../components/common/Lightbox'
import { useImageLightbox } from '../../components/common/useImageLightbox'
import { invoke } from '@tauri-apps/api/core'
import { useAuth } from '../../contexts/useAuth'
import { submitApplication, likeMod, unlikeMod, getDeviceId, rateMod, unrateMod, addComment, getComments, getCommentReplies, deleteComment, editComment, locateModComment, forceDeleteMod } from '../../services/workshopApi'
import { upsertLikedModToCache, removeLikedModFromCache } from '../../services/likedModsCache'
import { upsertRatedModToCache, removeRatedModFromCache } from '../../services/ratingCache'
import CommentSection from './CommentSection'
import { getDb, getGamePath } from '../../services/dbHelper'
import { BackButton, CategoryBadge, FloatingActions, UserLink, OfflineCacheNotice, GameVersionBanner } from '../../components'
import { NoticeBar } from '../../components/common/NoticeBar'
import { BOTTOM_TOASTER_ID } from '../../components/common/BottomToaster'
import { RatingStarsInteractiveDisplay } from '../../components/common/RatingStars'
import { LANGUAGES, LANG_LABELS } from '../../i18n/languages'
import { localizeError } from '../../utils/localizeError'
import { useMouseBackButton } from '../../hooks/useMouseBackButton'
import { ModFileRow } from './modDetail/ModFileRow'
import { useUserNav } from '../../contexts/useUserNav'
import { useV2PrereqNotice } from '../../contexts/useV2PrereqNotice'
import { useOverwriteConfirm } from '../../contexts/useOverwriteConfirm'
import { useGameVersionGuard } from '../../components/common/useGameVersionGuard'
import { normalizeManifestFiles, openDirHighlightItems } from './modDetail/modFileUtils'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    height: '100%',
    overflow: 'auto',
    padding: '8px 20px 32px',
    boxSizing: 'border-box',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    position: 'sticky',
    top: 0,
    zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: '10px 0',
  },
  detailSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  authorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  ratingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
  },
  description: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: '1.8',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'pre-wrap',
  },
  section: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    display: 'block',
  },
  langCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '16px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  })

export default function ModDetailPage({ mod, onBack, onEdit, onDeleted, scrollToCommentId, offlineCachedAt = null, offlinePartial = false, navActive = true }) {
  const styles = useStyles()
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { openSettings } = useUserNav()
  // v2 前置版本提醒（点击「安装」时触发，见 V2PrereqNoticeProvider）
  const v2Notice = useV2PrereqNotice()
  const overwriteConfirm = useOverwriteConfirm()
  const gate = useGameVersionGuard()
  // 开发模式（pnpm tauri dev）专属：详情页显示强制删除/强制编辑入口，跳过权限校验
  const isDev = import.meta.env.DEV
  const deviceIdRef = useRef(getDeviceId())
  const perms = mod.user_permissions || {}
  const canEdit = perms.is_author || perms.can_edit_mod_info || perms.can_edit_all_langs || (perms.editable_langs && perms.editable_langs.length > 0)
  const canApply = perms.can_apply_mod_info || perms.can_apply_lang
  // 评论 API 适配器：mod 评论 → CommentSection 统一签名；useMemo 保持引用稳定，
  // 避免 CommentSection 的 fetchComments useCallback 在每次父级渲染时重建
  const modCommentApi = useMemo(() => ({
    list: (args) => getComments({ mod_id: args.targetId, page: args.page, page_size: args.page_size, sort_order: args.sort_order, reply_order: args.reply_order }),
    add: (args) => addComment({ mod_id: args.targetId, author_id: args.author_id, content: args.content, parent_id: args.parent_id, reply_to_id: args.reply_to_id }),
    replies: (args) => getCommentReplies({ comment_id: args.comment_id, page: args.page, page_size: args.page_size, sort_order: args.sort_order }),
    locate: (args) => locateModComment({ comment_id: args.comment_id, top_sort_order: args.top_sort_order, reply_sort_order: args.reply_order }),
    edit: (args) => editComment({ comment_id: args.comment_id, author_id: args.author_id, content: args.content }),
    del: (args) => deleteComment({ comment_id: args.comment_id, author_id: args.author_id }),
  }), [])
  const [installingLang, setInstallingLang] = useState('')
  // 本页自己发起的调用失败（IPC 报错：开工前就失败，不会有任务事件）
  const [installError, setInstallError] = useState('')
  // 无冲突但含嵌套 zip 时，在安装区做内联提示（不再弹确认框）
  const [nestedZipHint, setNestedZipHint] = useState(false)
  // 进度数据源统一来自全局下载中心（App 级），本页不再自己 listen、不再维护
  // lang→taskId 映射：那样离开页面就全丢，回来只能靠"重新点按钮"才显示进度。
  // installByLang / archiveByLang 按 lang_code 索引，与本页文件行的粒度一致。
  const downloadCenter = useDownloadCenter()
  const subscribeProgress = downloadCenter.installByLang(mod.mod_key)
  const archiveProgress = downloadCenter.archiveByLang(mod.mod_key)
  // 仅下载：同 handleInstall，只留"文件已存在"这类不产生任务的一次性提示
  // 仅下载的一次性提示：{ text, path?, tone? }。path 存在时额外给「打开目录」入口
  const [archiveInfo, setArchiveInfo] = useState(null)
  const [installedDir, setInstalledDir] = useState('')
  const [installedFiles, setInstalledFiles] = useState([])
  const [installedByLang, setInstalledByLang] = useState({})
  const [isInstalled, setIsInstalled] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [uninstallError, setUninstallError] = useState('')
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  // 强制删除（dev）：确认弹窗 + 删除中状态 + 错误提示
  const [confirmForceDelete, setConfirmForceDelete] = useState(false)
  const [forceDeleting, setForceDeleting] = useState(false)
  // 强制删除结果提示：与讨论区/我的模组一致的全局右下角 Toaster
  const { dispatchToast } = useToastController(BOTTOM_TOASTER_ID)
  const [applyOpen, setApplyOpen] = useState(false)
  const [applyScope, setApplyScope] = useState('lang_all')
  const [applyReason, setApplyReason] = useState('')
  const [applying, setApplying] = useState(false)
  const [likeCount, setLikeCount] = useState(mod.like_count || 0)
  const [isLiked, setIsLiked] = useState(!!mod.is_liked)
  const [likeBusy, setLikeBusy] = useState(false)
  // 灯箱预览：点击「详细说明」内嵌图片查看大图（与讨论区/评论区同模式）
  const lightbox = useImageLightbox()
  const [ratingAvg, setRatingAvg] = useState(mod.rating_avg || 0)
  const [ratingCount, setRatingCount] = useState(mod.rating_count || 0)
  const [myRating, setMyRating] = useState(mod.my_rating || 0)
  const [ratingBusy, setRatingBusy] = useState(false)

  // 侧键返回：由 App 顶层的唯一监听分发过来，这里只声明「看不见时不接管」
  useMouseBackButton(onBack, { active: navActive })

  // 列表页点开时先渲染列表数据（不含 my_rating），异步详情数据到达后同步评分/点赞状态。
  // 用 ref 记录已同步的 mod 引用，避免用户交互后的状态被旧 props 覆盖。
  const syncedModRef = useRef(null)
  useEffect(() => {
    if (syncedModRef.current === mod) return
    syncedModRef.current = mod
    setLikeCount(mod.like_count || 0)
    setIsLiked(!!mod.is_liked)
    setRatingAvg(mod.rating_avg || 0)
    setRatingCount(mod.rating_count || 0)
    setMyRating(mod.my_rating || 0)
  }, [mod])

  const handleLikeToggle = async () => {
    if (likeBusy) return
    setLikeBusy(true)
    try {
      if (isLiked) {
        const res = await unlikeMod(mod.id, deviceIdRef.current)
        setLikeCount(res.like_count || Math.max((likeCount) - 1, 0))
        setIsLiked(false)
        removeLikedModFromCache(mod.id)
      } else {
        const res = await likeMod(mod.id, deviceIdRef.current)
        setLikeCount(res.like_count || (likeCount + 1))
        setIsLiked(true)
        upsertLikedModToCache(mod)
      }
    } catch (e) {
      console.error('Like toggle failed', e)
    } finally {
      setLikeBusy(false)
    }
  }

  const handleRate = async (rating) => {
    if (!user || ratingBusy || rating === myRating) return
    setRatingBusy(true)
    try {
      const res = await rateMod(mod.id, user.user_id, rating)
      setMyRating(res.my_rating || rating)
      setRatingAvg(res.rating_avg ?? ratingAvg)
      setRatingCount(res.rating_count ?? ratingCount)
      upsertRatedModToCache({
        ...mod,
        mod_id: mod.id,
        mod_key: mod.mod_key,
        my_rating: res.my_rating || rating,
        rating_avg: res.rating_avg ?? ratingAvg,
        rating_count: res.rating_count ?? ratingCount,
      }, user.user_id)
    } catch (e) {
      console.error('Rate failed', e)
    } finally {
      setRatingBusy(false)
    }
  }

  const handleUnrate = async () => {
    if (!user || ratingBusy) return
    setRatingBusy(true)
    try {
      const res = await unrateMod(mod.id, user.user_id)
      setMyRating(0)
      setRatingAvg(res.rating_avg ?? ratingAvg)
      setRatingCount(res.rating_count ?? ratingCount)
      // 撤评后与线上一致：从「评分记录」里移除，避免离线面板仍列出这个 mod
      removeRatedModFromCache(mod.id, user.user_id)
    } catch (e) {
      console.error('Unrate failed', e)
    } finally {
      setRatingBusy(false)
    }
  }

  const userLang = (i18n.language || 'en').split('-')[0]
  const availableLangs = LANGUAGES.filter(l => mod.translations?.[l.value]?.instructions)
  const defaultLang = availableLangs.find(l => l.value === userLang)?.value || availableLangs[0]?.value
  const [selectedLangs, setSelectedLangs] = useState(defaultLang ? [defaultLang] : [])

  // 重查 SQLite 安装记录刷 installedByLang/isInstalled/installedDir/installedFiles——
  // 切屏回来走 effect 调它；下载 done 时也调它复用既有已安装态显示（打开目录按钮等），
  // 避免另写旁路显示导致样式不一致
  const checkInstalled = useCallback(async () => {
    try {
      const db = await getDb()
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
        // 安装记录只是缓存：用当前游戏目录校验 manifest 中的文件是否仍在磁盘上。
        // 切换游戏目录、手动删除或改名后，详情页不能再误报「安装成功」。
        // 路径规则（v1/v2/dll/composite）统一交给后端 install_files_present 处理。
        const gamePath = await getGamePath()
        const base = gamePath ? gamePath.replace(/[\\/]+$/, '') : ''
        const category = rows[0]?.category || 'v1'
        const verifiedByLang = {}
        for (const [lang, rec] of Object.entries(byLang)) {
          try {
            const present = await invoke('db_install_files_present', {
              mod_key: mod.mod_key,
              category,
              manifest: rec.manifest || '',
            })
            if (present) verifiedByLang[lang] = rec
          } catch (e) {
            // 游戏目录缺失/无权限时无法判定，保留记录，避免误报已卸载
            console.warn('[ModDetailPage] 校验安装文件失败:', e)
            verifiedByLang[lang] = rec
          }
        }
        setInstalledByLang(verifiedByLang)
        const verified = Object.values(verifiedByLang)
        if (verified.length > 0) {
          setIsInstalled(true)
          const manifest = verified[0].manifest || rows[0]?.manifest || ''
          // 与工坊预览同一套归一化口径：剥安装根前缀、丢目录条目。历史记录带
          // 前缀（如 "CustomMissions/xxx.json"）时也能显示相对安装根的路径，
          // 高亮项基于归一化后的列表计算，不会指向不存在的首段子项。
          const fileList = normalizeManifestFiles(manifest, category, mod.mod_key)
          setInstalledFiles(fileList)
          if (base) {
            const category = rows[0]?.category || 'v1'
            let targetDir
            if (category === 'v2') {
              targetDir = `${base}\\CustomMissions2\\${mod.mod_key}`
            } else if (category === 'dll') {
              targetDir = `${base}\\BepInEx\\plugins`
            } else if (category === 'composite') {
              // composite：解压到游戏根目录，zip 内顶层文件夹才是真正的 mod 目录
              // 从 manifest 第一项推断顶层目录（如 "BepInEx/plugins/CosplayShop"）
              const firstPath = fileList[0] || ''
              const segments = firstPath.split('/')
              if (segments.length > 1) {
                const topDirSegs = segments.slice(0, -1)
                targetDir = `${base}\\${topDirSegs.join('\\')}`
                // installedFiles（manifest 是相对游戏根的路径）需转换为相对收窄后
                // targetDir 的路径，使 open_folder 的 path.join(item) 解析到真实文件
                setInstalledFiles(fileList.map(f => {
                  const segs = f.split('/')
                  return segs.length > topDirSegs.length
                    ? segs.slice(topDirSegs.length).join('\\')
                    : f.replace(/\//g, '\\')
                }))
              } else {
                // 第一项是根级文件（单段路径）：targetDir 保持游戏根，files 保持相对游戏根
                targetDir = base
              }
            } else {
              targetDir = `${base}\\CustomMissions`
            }
            setInstalledDir(targetDir)
          } else {
            setInstalledDir('')
          }
        } else {
          setIsInstalled(false)
          setInstalledDir('')
          setInstalledFiles([])
        }
      } catch (e) {
        console.warn('[ModDetailPage] 查询安装状态失败:', e)
      }
    }, [mod.mod_key, mod.files])

  // 切屏回来 / 首次挂载：重查安装记录刷新已安装态
  useEffect(() => {
    // checkInstalled 为命名异步取数函数，setState 均在 await 之后，
    // 规则对命名函数保守误报，故豁免
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkInstalled()
  }, [checkInstalled])

  // 用户可能在资源管理器里手动删除/改名文件，窗口重新获得焦点时再校验一次
  useEffect(() => {
    const onFocus = () => { checkInstalled() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkInstalled])

  // 强制删除（dev）：先删图床物理文件，再由后端事务硬删除全部关联数据，成功后刷新列表并返回。
  // 结果用右下角 toast 提示；失败时先关掉确认弹窗再提示，避免 toast 被模态遮罩压住
  const handleForceDelete = async () => {
    setForceDeleting(true)
    try {
      await forceDeleteMod({ modId: mod.id, files: mod.files || [] })
      setConfirmForceDelete(false)
      dispatchToast(
        <Toast>
          <ToastTitle>
            {t('workshop.deleteModSuccess', { name: mod.display_name || mod.mod_key || '' })}
          </ToastTitle>
        </Toast>,
        { intent: 'success', timeout: 3000 },
      )
      onDeleted?.()
      onBack?.()
    } catch (e) {
      setConfirmForceDelete(false)
      dispatchToast(
        <Toast>
          <ToastTitle>{t('workshop.deleteModFailed')}</ToastTitle>
          <ToastBody>{e?.message || String(e)}</ToastBody>
        </Toast>,
        { intent: 'error', timeout: 3000 },
      )
    } finally {
      setForceDeleting(false)
    }
  }

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
    // v2 前置版本过低提醒：安装动作不等待检测结果（fire-and-forget）
    v2Notice?.checkAndNotify()
    setInstallError('')
    setInstallingLang(file.lang_code)
    try {
      // 路径合法性统一由 installMod 拦截（所有安装入口都走该函数），这里不再重复检测。
      setNestedZipHint(false)
      // 下载前零流量预检：用新版本 manifest 与本地文件系统 / 安装记录比对。
      // 只有「将被覆盖」（其他 mod 或本机已有文件）、「本地残留」或「清单含非法路径」
      // 才弹确认框；嵌套 zip 无法预判明细时改为本页内联提示。用户取消直接返回，
      // 不发起下载、不落任何文件。
      // 预检本身失败（读游戏目录、查云端 hash 等）只做提示、不阻断安装：宁可少提醒
      // 一次覆盖，也不能因为预检故障让用户装不上。
      let overwriteCheck = null
      try {
        overwriteCheck = await checkModOverwrite({
          modKey: mod.mod_key,
          category: mod.category,
          manifest: file.manifest,
          langCode: file.lang_code,
        })
      } catch (checkError) {
        console.warn('[handleInstall] 覆盖预检失败，跳过提示直接安装:', checkError)
      }
      const hasOverwritePrompt =
        !!overwriteCheck?.conflicts?.length
        || !!overwriteCheck?.staleFiles?.length
        || !!overwriteCheck?.invalidPaths?.length
      // 清单含非法路径时弹拒绝式弹窗；无实际覆盖 / 残留时把"内含嵌套压缩包、
      // 覆盖明细无法预判"降为页面内联提示。有冲突时由弹窗统一展示。
      setNestedZipHint(!!(overwriteCheck?.hasNestedZip || overwriteCheck?.staleUnknown) && !hasOverwritePrompt)
      if (hasOverwritePrompt) {
        const confirmed = overwriteConfirm ? await overwriteConfirm.confirmOverwrite(overwriteCheck) : true
        if (!confirmed) return
      }
      // installMod 立即返回 taskId，下载/解压/写库全在 Rust 后台异步执行，
      // 不再阻塞本组件生命周期——离开本页也照常完成。
      // 进度由全局下载中心从 subscription-progress 事件同步，本页只是消费者，
      // 因此不需要在这里维护任何 taskId 映射或占位状态。
      const result = await installMod({
        modKey: mod.mod_key,
        category: mod.category,
        fileUrl: file.file_url,
        version: file.version,
        fileHash: file.file_hash,
        langCode: file.lang_code,
        manifest: file.manifest,
        displayName: mod.display_name,
        description: mod.description,
        translations: mod.translations,
        // 已安装时按钮语义是"重新安装/更新"——用户明确要求覆盖重装，必须跳过后端去重。
        // 去重只看磁盘文件是否存在，发现不了"文件被删错/被改坏但同名文件还在"的情况，
        // 仅凭它会让重装按钮在文件完好时变成空操作。
        force: !!installedByLang[file.lang_code],
      })
      // 命中后端去重（deduplicated=true）：旧任务已 done 且后端确认文件在，
      // 不会再有 subscription-progress 事件。直接重查安装态刷新（打开目录按钮等就位）。
      // 注意不能写"等待中"占位：全局中心里不会被兑现的任务会一直卡在 pending。
      if (result?.deduplicated) {
        await checkInstalled()
      }
    } catch (e) {
      // 后端错误码（如 GAME_DIR_INVALID）统一映射为本地化文案，不把裸代码丢给用户
      setInstallError(localizeError(t, e?.message || String(e)))
    } finally {
      setInstallingLang('')
    }
  }

  // 「仅下载」：先弹选择框（内置下载 / 使用 NDM），选中后再走对应链路。
  // 不直接开下是语义要求：NDM 接管后进度不在软件内，用户需要先知道这一点。
  const [archiveChoice, setArchiveChoice] = useState(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  // NDM 不可用时回填的地址（已按当前 CDN 线路改写），方便用户手动粘贴
  const [ndmFallbackUrl, setNdmFallbackUrl] = useState('')

  // 真正的内置下载：原始压缩包存到 <游戏根目录>\sfmmmDownloads，不解压、不安装。
  // 与 handleInstall 分开是语义要求：用户常只是想留一份原始包自行处理，
  // 走安装链路会写 installed_workshop_mods 并把文件铺进游戏目录。
  const handleArchiveDownload = async (file) => {
    setArchiveInfo(null)
    try {
      const res = await downloadModArchive({
        modKey: mod.mod_key,
        langCode: file.lang_code,
        version: file.version,
        fileUrl: file.file_url,
        fileName: file.file_name,
        displayName: mod.display_name || mod.mod_key,
      })
      // 后端命中"文件已存在"：不重复下载，也不产生任务事件（全局中心里不会有这条）。
      // 所以这次不经过进度链路，直接给出路径提示 + 打开目录入口——否则用户只能自己
      // 去 sfmmmDownloads 里翻，等于比改造前还退了一步。
      if (res?.status === 'exists') {
        setArchiveInfo({ text: t('workshop.downloadOnlyExists'), path: res.path || '' })
      }
      // started / downloading（后者是复用后端既有任务）：进度统一由全局下载中心
      // 从 archive-download-progress 事件同步，本页不做任何占位或映射。
    } catch (e) {
      // 开工前就失败（找不到游戏目录等）：没有任务事件，只能本页提示
      setArchiveInfo({ text: localizeError(t, e.message), tone: 'error' })
    }
  }

  // 点「仅下载」：开选择框
  const handleArchiveRequest = (file) => {
    setArchiveInfo(null)
    setNdmFallbackUrl('')
    setArchiveChoice(file)
  }

  // 选择框里点「内置下载」
  const handleChooseBuiltin = async () => {
    const file = archiveChoice
    setArchiveChoice(null)
    if (file) await handleArchiveDownload(file)
  }

  // 选择框里点「使用 NDM」：把任务推给正在运行的 NDM。
  // 成功 → 提示已接管；推不进去（NDM 没开或发送失败）→ 直接把地址复制到剪贴板。
  const handleChooseNdm = async () => {
    const file = archiveChoice
    if (!file) return
    setArchiveBusy(true)
    try {
      const res = await sendToNdm(file.file_url)
      if (res?.sent) {
        setArchiveChoice(null)
        setArchiveInfo({ text: t('workshop.ndmSent') })
        return
      }
      // 没送进去就复制地址：不追问原因，用户拿到地址即可自己处理。
      // 地址一并回填到弹窗里——剪贴板被系统策略禁用时还能手动复制。
      const target = res?.url || file.file_url
      const copied = await copyText(target)
      setNdmFallbackUrl(target)
      setArchiveInfo({
        text: copied ? t('workshop.ndmUrlCopied') : t('workshop.ndmCopyFailed'),
        tone: copied ? undefined : 'error',
      })
      // 复制成功就关掉弹窗；失败时留在弹窗里，让用户从回填的输入框手动复制
      if (copied) setArchiveChoice(null)
    } catch (e) {
      setArchiveInfo({ text: String(e?.message || e), tone: 'error' })
    } finally {
      setArchiveBusy(false)
    }
  }

  // 取消安装任务：中止下载并删临时包。后端会广播 cancelled 终态，
  // 全局中心据此把该任务从"运行中"移除，按钮自动恢复可点。
  const handleCancelInstall = useCallback(async (file, task) => {
    if (!task?.taskId) return
    try {
      await invoke('db_cancel_subscription', { task_id: task.taskId })
    } catch (e) {
      setInstallError(localizeError(t, e?.message || String(e)))
    }
  }, [t])

  // 取消仅下载任务：与安装不同，用户点"取消"= 不要这个文件了，
  // 后端除了停下载还会删掉已落盘的 zip（"移除下载的缓存"）。
  const handleCancelArchive = useCallback(async (file, task) => {
    if (!task?.taskId) return
    setArchiveInfo(null)
    try {
      await invoke('db_cancel_archive_download', { task_id: task.taskId, path: task.path || '' })
    } catch (e) {
      setArchiveInfo({ text: localizeError(t, e?.message || String(e)), tone: 'error' })
    }
  }, [t])

  // 安装任务终态统一处理：done 时重查 SQLite 刷已安装态（打开目录按钮、版本号等），
  // failed 时把原因抬到页面级 NoticeBar。与切屏回来走同一套逻辑。
  //
  // 数据源必须是 downloadCenter.tasks 而不是 subscribeProgress：后者（installByLang）
  // 只暴露运行中任务，done 事件一到就消失了，靠它永远等不到完成信号。
  //
  // 只认「本 mod 最新的一条安装任务」，并按 taskId 去重，避免每帧进度都跑一次重查。
  //
  // 失败提示单独一支，且要求 latest 本身就是 failed（而不是"曾经失败过"）：重装成功后
  // 最新任务是 done，这一支自然不响，否则页面重挂载时会把被覆盖的旧失败又翻出来提示，
  // 让用户以为刚装的这次也失败了。
  const doneTaskRef = useRef(null)
  useEffect(() => {
    const doneTask = downloadCenter.tasks
      .filter(task => task.kind === 'install' && task.modKey === mod.mod_key && task.status === 'done')
      .sort((a, b) => b.taskId - a.taskId)[0]
    if (!doneTask || doneTaskRef.current === doneTask.taskId) return
    doneTaskRef.current = doneTask.taskId
    checkInstalled()
  }, [downloadCenter.tasks, mod.mod_key, checkInstalled])

  const failedTaskRef = useRef(null)
  useEffect(() => {
    const latest = downloadCenter.tasks
      .filter(task => task.kind === 'install' && task.modKey === mod.mod_key)
      .sort((a, b) => b.taskId - a.taskId)[0]
    if (!latest || latest.status !== 'failed') return
    if (failedTaskRef.current === latest.taskId) return
    failedTaskRef.current = latest.taskId
    // 下载/解压/写记录阶段失败都走这里：文件行拿不到终态（installByLang 只含运行中），
    // 浮条 8s 后又会自动关闭，必须抬到页面级才能让用户看到原因
    setInstallError(
      localizeError(t, latest.error) || t('workshop.installFailed', { defaultValue: '安装失败' }),
    )
  }, [downloadCenter.tasks, mod.mod_key, t])

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
      // 进度状态由全局下载中心持有（按 mod_key 自动过滤），退订无需清理：
      // 该 mod 若无进行中的任务，中心里本来就没有它的条目
    } catch (e) {
      setUninstallError(e.message)
    } finally {
      setUninstalling(false)
    }
  }

  const handleLangToggle = (lang) => {
    setSelectedLangs(prev => prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang])
  }

  const handleOpenFolder = useCallback((path, selectedItems) => {
    if (selectedItems === undefined) {
      invoke('open_folder', { path })
    } else {
      invoke('open_folder', { path, selected_items: selectedItems })
    }
  }, [])

  const sortedSelectedLangs = [...selectedLangs].sort((a, b) => {
    if (a === userLang) return -1
    if (b === userLang) return 1
    return 0
  })

  return (
    <div className={styles.root} data-scroll-key={'mod-detail:' + mod.id}>
        {(offlineCachedAt || offlinePartial) && <OfflineCacheNotice cachedAt={offlineCachedAt} partial={offlinePartial} />}
        {gate.status === 'blocked' && (
          <GameVersionBanner version={gate.version} required={gate.required} onGoSettings={openSettings} />
        )}
        <div className={styles.toolbarRow}>
        <BackButton onClick={onBack} />
        <Text weight="semibold" size={400}>{mod.mod_key}</Text>
        {mod.is_original && (
          <Badge color="brand" appearance="filled" size="small">
            {t('workshop.isOriginalBadge')}
          </Badge>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <Text size={300}>{t('workshop.displayLang')}</Text>
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
                  <Text size={300}>{lang.label}</Text>
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
          <UserLink
            userId={mod.author_id}
            username={mod.author_name}
            avatar={mod.author_avatar}
            size={24}
            nameSize={300}
            showMasterTag
          />
          {mod.category && (
            <CategoryBadge category={mod.category} />
          )}
        </div>
        <div className={styles.ratingRow}>
          <RatingStarsInteractiveDisplay
            ratingAvg={ratingAvg}
            ratingCount={ratingCount}
            myRating={myRating}
            canRate={!!user}
            busy={ratingBusy}
            onRate={handleRate}
            size="medium"
          />
          {user ? (
            myRating > 0 && (
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button
                    size="small"
                    appearance="subtle"
                    disabled={ratingBusy}
                  >
                    {t('workshop.clearRating')}
                  </Button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem onClick={handleUnrate} disabled={ratingBusy}>
                      {t('workshop.confirmClearRating')}
                    </MenuItem>
                    <MenuItem>
                      {t('workshop.cancel')}
                    </MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            )
          ) : (
            <Text className={styles.meta}>
              {t('workshop.loginToRate')}
            </Text>
          )}
        </div>
        {(mod.created_at || mod.updated_at) && (
          <div className={styles.meta} style={{ display: 'flex', gap: '16px' }}>
            {mod.created_at && <Text size={300}>{t('workshop.createdAt')}: {new Date(mod.created_at).toLocaleString()}</Text>}
            {mod.updated_at && mod.updated_at !== mod.created_at && <Text size={300}>{t('workshop.updatedAt')}: {new Date(mod.updated_at).toLocaleString()}</Text>}
          </div>
        )}
        {mod.description && (
          <div className={styles.description}>
            <MarkdownContent markdown={mod.description} plain />
          </div>
        )}
        {(sortedSelectedLangs.length > 0 || mod.instructions) && (
          <div className={styles.section}>
            <Text className={styles.sectionTitle}>{t('workshop.detailedDesc')}</Text>
            {sortedSelectedLangs.length > 0 ? sortedSelectedLangs.map(langCode => {
              const trans = mod.translations?.[langCode]
              if (!trans?.instructions) return null
              return (
                <div key={langCode} className={styles.langCard}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <Badge appearance="outline" size="small">
                      {LANG_LABELS[langCode] || langCode}
                    </Badge>
                    {trans.name && <Text size={300} weight="semibold">{trans.name}</Text>}
                  </div>
                  {(trans.instructions_format || 'markdown') === 'richtext'
                    ? <RichTextContent html={trans.instructions} onImageClick={lightbox.open} variant="article" />
                    : <MarkdownContent markdown={trans.instructions} onImageClick={lightbox.open} variant="article" />}
                </div>
              )
            }) : (
              <>
                {(mod.instructions_format || 'markdown') === 'richtext'
                  ? <RichTextContent html={mod.instructions} onImageClick={lightbox.open} variant="article" />
                  : <MarkdownContent markdown={mod.instructions} onImageClick={lightbox.open} variant="article" />}
              </>
            )}
          </div>
        )}
        {mod.files && mod.files.length > 0 && (
          <div className={styles.section}>
            <Text className={styles.sectionTitle}>{t('workshop.availableVersions')}</Text>
            {mod.files.map(f => (
              <ModFileRow
                key={f.lang_code}
                file={f}
                category={mod.category}
                modKey={mod.mod_key}
                installed={installedByLang[f.lang_code]}
                installing={installingLang === f.lang_code}
                subscribeProgress={subscribeProgress[f.lang_code]}
                archiveProgress={archiveProgress[f.lang_code]}
                isInstalled={isInstalled}
                installedDir={installedDir}
                installedFiles={installedFiles}
                uninstalling={uninstalling}
                installBlocked={gate.status === 'blocked'}
                onInstall={handleInstall}
                onArchiveDownload={handleArchiveRequest}
                onCancelInstall={handleCancelInstall}
                onCancelArchive={handleCancelArchive}
                onOpenFolder={handleOpenFolder}
                onRequestUninstall={() => setConfirmUninstall(true)}
              />
            ))}
          </div>
        )}
        {nestedZipHint && (
          <NoticeBar>
            <Text>{t('workshop.overwriteNestedZip')}</Text>
          </NoticeBar>
        )}
        {installedDir && (
          <NoticeBar>
            <Text>
              {t('workshop.installSuccess')}{installedDir}
            </Text>
            <Button size="small" appearance="subtle" style={{ marginLeft: '8px' }} onClick={() => handleOpenFolder(installedDir, openDirHighlightItems(installedFiles))}>
              {t('workshop.openDir')}
            </Button>
          </NoticeBar>
        )}
        {installError && (
          <NoticeBar tone="error">
            <Text>{installError}</Text>
          </NoticeBar>
        )}
        {archiveInfo && (
          <NoticeBar tone={archiveInfo.tone === 'error' ? 'error' : 'success'}>
            <Text>{archiveInfo.text}</Text>
            {archiveInfo.path && (
              <Button
                size="small"
                appearance="subtle"
                style={{ marginLeft: '8px' }}
                onClick={() => handleOpenFolder(archiveInfo.path)}
              >
                {t('workshop.openDir')}
              </Button>
            )}
          </NoticeBar>
        )}
        {uninstallError && (
          <NoticeBar tone="error">
            <Text>{uninstallError}</Text>
          </NoticeBar>
        )}
        <CommentSection
          api={modCommentApi}
          targetId={mod.id}
          folderPrefix="sfm"
          ownerId={mod.author_id}
          canModerate={canEdit}
          scrollToCommentId={scrollToCommentId}
        />
      </div>

      {/* 图片灯箱预览（与讨论区/评论区同模式） */}
      <Lightbox src={lightbox.src} images={lightbox.images} onClose={lightbox.close} />

      {/* 「仅下载」方式选择：内置下载（本软件内显示进度）或交给 NDM（外部下载器接管） */}
      <Dialog
        open={!!archiveChoice}
        onOpenChange={(_, { open }) => {
          if (!open) {
            setArchiveChoice(null)
            setNdmFallbackUrl('')
          }
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('workshop.downloadMethodTitle')}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '4px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <Text weight="semibold">{t('workshop.downloadBuiltin')}</Text>
                  <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>
                    {t('workshop.downloadBuiltinDesc')}
                  </Text>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <Text weight="semibold">{t('workshop.downloadNdm')}</Text>
                  <Text size="small" style={{ color: tokens.colorNeutralForeground2 }}>
                    {t('workshop.downloadNdmDesc')}
                  </Text>
                </div>
                {/* NDM 未安装时把地址回填出来：剪贴板可能被系统策略禁用，
                    显示出来用户还能手动复制，不至于卡在死路 */}
                {ndmFallbackUrl && (
                  <Textarea
                    readOnly
                    resize="vertical"
                    value={ndmFallbackUrl}
                    style={{ fontSize: tokens.fontSizeBase200 }}
                  />
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button
                size="small"
                appearance="subtle"
                onClick={() => {
                  setArchiveChoice(null)
                  setNdmFallbackUrl('')
                }}
              >
                {t('workshop.cancel')}
              </Button>
              <Button size="small" appearance="outline" onClick={handleChooseNdm} disabled={archiveBusy}>
                {archiveBusy ? t('workshop.processing') : t('workshop.downloadNdm')}
              </Button>
              <Button size="small" appearance="primary" onClick={handleChooseBuiltin} disabled={archiveBusy}>
                {t('workshop.downloadBuiltin')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

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

      <FloatingActions items={[
        { key: 'back', icon: <ArrowLeft24Regular />, onClick: onBack },
        { key: 'like', icon: isLiked ? <Heart24Filled /> : <Heart24Regular />, appearance: isLiked ? 'primary' : 'outline', onClick: handleLikeToggle, disabled: likeBusy, label: String(likeCount), style: isLiked ? { color: tokens.colorPaletteRedForeground1 } : undefined },
        ...(user && canEdit ? [{ key: 'edit', icon: <Edit24Regular />, appearance: 'primary', onClick: () => onEdit?.(mod) }] : []),
        ...(user && canApply ? [{ key: 'apply', icon: <Add24Regular />, appearance: 'primary', onClick: () => setApplyOpen(true), label: t('workshop.applyToEdit') }] : []),
        // dev（pnpm tauri dev）专属：强制编辑（有编辑权限时上面的编辑按钮已显示，此处不重复）+ 强制删除
        ...(isDev && !(user && canEdit) ? [{ key: 'forceEdit', icon: <Edit24Regular />, appearance: 'primary', onClick: () => onEdit?.(mod), label: t('workshop.forceEdit') }] : []),
        ...(isDev ? [{ key: 'forceDelete', icon: <Delete24Regular />, appearance: 'outline', onClick: () => setConfirmForceDelete(true), label: t('workshop.forceDelete'), style: { color: tokens.colorPaletteRedForeground1 } }] : []),
      ]} />

      <Dialog open={confirmForceDelete} onOpenChange={(_, { open }) => { if (!open && !forceDeleting) setConfirmForceDelete(false) }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('workshop.forceDeleteTitle')}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                <Text size="small">{t('workshop.forceDeleteHint', { name: mod.display_name || mod.mod_key })}</Text>
              </div>
            </DialogContent>
            <DialogActions>
              <Button size="small" appearance="subtle" disabled={forceDeleting} onClick={() => setConfirmForceDelete(false)}>
                {t('workshop.cancel')}
              </Button>
              <Button
                size="small"
                appearance="primary"
                style={{ backgroundColor: tokens.colorPaletteRedForeground1 }}
                disabled={forceDeleting}
                onClick={handleForceDelete}
              >
                {forceDeleting ? t('workshop.deleting') : t('workshop.forceDeleteConfirm')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
