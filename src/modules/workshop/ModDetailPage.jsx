import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Text, Button, Badge, ProgressBar,
  makeStyles, tokens,
  Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogTrigger, DialogActions, Textarea, Select, Checkbox,
  Popover, PopoverTrigger, PopoverSurface,
  Menu, MenuTrigger, MenuList, MenuItem, MenuPopover,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular, ArrowDownload24Regular,
  Edit24Regular, Add24Regular, Delete24Regular,
  Heart24Regular, Heart24Filled,
  Folder24Regular, Document24Regular,
  Save24Regular,
} from '@fluentui/react-icons'
import { installMod, uninstallMod, downloadModArchive } from '../../services/installMod'
import { listen } from '@tauri-apps/api/event'
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
import { BackButton, CategoryBadge, FloatingActions, FileRow, UserLink, OfflineCacheNotice } from '../../components'
import { RatingStarsInteractiveDisplay } from '../../components/common/RatingStars'
import { LANGUAGES, LANG_LABELS } from '../../i18n/languages'
import { formatSpeed } from '../../utils/formatSpeed'
import { localizeError } from '../../utils/localizeError'
import { useMouseBackButton } from '../../hooks/useMouseBackButton'

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

// manifest 是文件路径列表（JSON 字符串），用于安装记录与文件列表预览
function parseManifest(raw) {
  try {
    const list = JSON.parse(raw || '[]')
    return Array.isArray(list) ? list.filter(p => typeof p === 'string' && p) : []
  } catch {
    return []
  }
}

// 打开目录时的高亮项：manifest 路径可能带子目录前缀（作者上传的是文件夹，如
// "上级--长--.../01.json"），而 Windows 资源管理器只显示 installedDir 的【直接子项】，
// 深层文件在当前视图中不可见、无法高亮。故取每项第一段并去重——文件夹型 mod 高亮
// 文件夹本身，平铺的单/多文件高亮文件名，保证高亮目标在视图中可见、可被选中。
function openDirHighlightItems(files) {
  const seen = new Set()
  const items = []
  for (const f of files || []) {
    const first = String(f).split(/[/\\]/)[0]
    if (first && !seen.has(first)) {
      seen.add(first)
      items.push(first)
    }
  }
  return items
}

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
  stats: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
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

export default function ModDetailPage({ mod, onBack, onEdit, onDeleted, scrollToCommentId, offlineCachedAt = null, offlinePartial = false }) {
  const styles = useStyles()
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
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
  const [installError, setInstallError] = useState('')
  const [installInfo] = useState('')
  // 订阅下载实时进度：按 lang_code 存 { percent, stage, status, error }
  // 与订阅记录页共享同一 subscription-progress 事件源，本页只关心本 mod 的任务
  const [subscribeProgress, setSubscribeProgress] = useState({})
  // 当前活跃订阅任务：lang_code → taskId（用于 listen 时按 taskId 匹配回 lang）
  const activeTaskByLangRef = useRef({})
  // 「仅下载」进度：按 lang_code 存 { percent, speed, status, error, path }
  // 后端把原始压缩包存到 <游戏根目录>\sfmmmDownloads，不解压、不写安装记录，
  // 与上面安装链路的 subscription-progress 是两套独立事件，互不干扰
  const [archiveProgress, setArchiveProgress] = useState({})
  const [archiveError, setArchiveError] = useState('')
  const [archiveInfo, setArchiveInfo] = useState('')
  // 活跃「仅下载」任务：lang_code → taskId
  const activeArchiveTaskByLangRef = useRef({})
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
  const [forceDeleteError, setForceDeleteError] = useState('')
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

  useMouseBackButton(onBack)

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
          const fileList = parseManifest(manifest)
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

  // 强制删除（dev）：先删图床物理文件，再由后端事务硬删除全部关联数据，成功后刷新列表并返回
  const handleForceDelete = async () => {
    setForceDeleteError('')
    setForceDeleting(true)
    try {
      await forceDeleteMod({ modId: mod.id, files: mod.files || [] })
      onDeleted?.()
      onBack()
    } catch (e) {
      setForceDeleteError(e.message || String(e))
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
    setInstallError('')
    setInstallingLang(file.lang_code)
    // 清掉该 lang 旧的进度反馈，避免上次失败提示残留
    setSubscribeProgress(prev => { const n = { ...prev }; delete n[file.lang_code]; return n })
    try {
      // 改造后：installMod 立即返回 taskId，下载/解压/写库全在 Rust 后台异步执行，
      // 不再阻塞本组件生命周期——离开本页也照常完成。
      // 进度通过 subscription-progress 事件实时回传本页安装按钮（与订阅记录页共享同一事件源）。
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
      // 不会再有 subscription-progress 事件，绝不能写"等待中"占位——否则
      // disabled={!!subscribeProgress[lang]} 会永久禁用按钮且无人清除。
      // 直接重查安装态刷新（打开目录按钮等就位）。
      if (result?.deduplicated) {
        // 该 taskId 不归本次调用，清掉可能残留的映射，避免它被后端复用后
        // 事件打进来、本页误认作自己的任务而更新进度
        delete activeTaskByLangRef.current[file.lang_code]
        await checkInstalled()
        return
      }
      // 记录 lang→taskId 映射，listen 回调凭 taskId 匹配回 lang 更新进度
      if (result?.taskId != null) {
        activeTaskByLangRef.current[file.lang_code] = result.taskId
        // 立即占位显示"已入队"，避免 emit 首帧到达前按钮态空窗
        // stage 用 t() 拿汉化文案（workshop.stage.pending），不裸 'pending'
        setSubscribeProgress(prev => ({
          ...prev,
          [file.lang_code]: { percent: 0, stage: t('workshop.stage.pending', { defaultValue: 'pending' }), status: 'pending', error: '' },
        }))
      }
    } catch (e) {
      setInstallError(e.message)
    } finally {
      setInstallingLang('')
    }
  }

  // 「仅下载」：只把原始压缩包存到 <游戏根目录>\sfmmmDownloads，不解压、不安装。
  // 与 handleInstall 分开是语义要求：用户常只是想留一份原始包自行处理，
  // 走安装链路会写 installed_workshop_mods 并把文件铺进游戏目录。
  const handleArchiveDownload = async (file) => {
    setArchiveError('')
    setArchiveInfo('')
    // 清掉该 lang 的旧展示（上次的完成结果/失败态），避免与新进度并存
    setArchiveProgress(prev => { const n = { ...prev }; delete n[file.lang_code]; return n })
    try {
      const res = await downloadModArchive({
        modKey: mod.mod_key,
        langCode: file.lang_code,
        version: file.version,
        fileUrl: file.file_url,
        fileName: file.file_name,
      })
      // 后端命中"文件已存在"：不重复下载，直接给出可打开的路径
      if (res?.status === 'exists') {
        setArchiveInfo(t('workshop.downloadOnlyExists'))
        setArchiveProgress(prev => ({
          ...prev,
          [file.lang_code]: { percent: 100, speed: 0, status: 'done', error: '', path: res.path },
        }))
        return
      }
      // started / downloading（后者是复用后端既有任务）：两种都靠事件推进度
      if (res?.taskId != null) {
        activeArchiveTaskByLangRef.current[file.lang_code] = res.taskId
        // 占位：等首帧进度事件到达前按钮态不断档
        setArchiveProgress(prev => ({
          ...prev,
          [file.lang_code]: { percent: 0, speed: 0, status: 'downloading', error: '', path: res.path || '' },
        }))
      }
    } catch (e) {
      setArchiveError(localizeError(t, e.message))
    }
  }

  // 监听后端 archive-download-progress 事件，按 taskId 反查 lang 更新进度。
  // 与安装链路的 subscription-progress 是两套独立事件源，互不影响。
  useEffect(() => {
    let unlistenFn = null
    listen('archive-download-progress', (ev) => {
      const payload = ev.payload || {}
      const tid = payload.taskId
      if (tid == null) return
      // 反查 lang：本页活跃任务映射里找，找不到说明不是本页发起的，忽略
      const lang = Object.entries(activeArchiveTaskByLangRef.current).find(([, id]) => id === tid)?.[0]
      if (!lang) return
      if (['done', 'failed'].includes(payload.status)) {
        delete activeArchiveTaskByLangRef.current[lang]
        if (payload.status === 'failed') {
          setArchiveError(payload.error || '')
        }
      }
      // 终态条目保留（done 时带 path，要继续显示"已下载 + 打开目录"），
      // 但状态改成终态后按钮即恢复可点，用户可再次下载。
      setArchiveProgress(prev => ({
        ...prev,
        [lang]: {
          percent: payload.percent ?? 0,
          speed: payload.speed ?? 0,
          status: payload.status,
          error: payload.error || '',
          path: payload.path || prev[lang]?.path || '',
        },
      }))
    })
      .then(fn => { unlistenFn = fn })
      .catch(() => {})
    return () => { if (unlistenFn) unlistenFn() }
  }, [])

  // 监听后端 subscription-progress 事件，按 taskId 反查 activeTaskByLang 拿 lang，
  // 更新本页 subscribeProgress[lang]——与订阅记录页共享同一事件源，不互扰
  useEffect(() => {
    let unlistenFn = null
    listen('subscription-progress', (ev) => {
      const payload = ev.payload || {}
      const tid = payload.taskId
      if (tid == null) return
      // 反查 lang：本页活跃任务映射里找
      const lang = Object.entries(activeTaskByLangRef.current).find(([, id]) => id === tid)?.[0]
      if (!lang) return // 不是本页发起的订阅，忽略
      const stageKey = `workshop.stage.${payload.stage}`
      setSubscribeProgress(prev => ({
        ...prev,
        [lang]: {
          percent: payload.percent ?? 0,
          stage: t(stageKey, { defaultValue: payload.stage }),
          status: payload.status,
          error: payload.error || '',
          speed: payload.speed ?? 0,
        },
      }))
      // 任务终结：清活跃映射 + 清该 lang 的进度占位。占位不清会让
      // disabled={... || !!subscribeProgress[lang]} 永久置灰按钮，无法再次重装。
      // done 时复用 checkInstalled 重查 SQLite 刷已安装态
      // （installedByLang/isInstalled/installedDir/installedFiles 全套和切屏回来一致），
      // 不另写旁路显示避免样式不一致 + 打开目录按钮拿不到 installedDir 点不动
      if (['done', 'failed', 'cancelled'].includes(payload.status)) {
        delete activeTaskByLangRef.current[lang]
        if (payload.status === 'failed') {
          setInstallError(payload.error || '')
        }
        setSubscribeProgress(prev => {
          const next = { ...prev }
          delete next[lang]
          return next
        })
        if (payload.status === 'done') {
          checkInstalled()
        }
      }
    })
      .then(fn => { unlistenFn = fn })
      .catch(() => {})
    return () => { if (unlistenFn) unlistenFn() }
  }, [t, checkInstalled])

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
      // 退订后清掉订阅进度占位 + 活跃任务映射，否则按钮段
      // disabled={... || !!subscribeProgress[lang]} 会因残留占位永久禁用无法重装
      setSubscribeProgress(prev => {
        const next = { ...prev }
        // 清本 mod 所有 lang 的占位（退订是 mod 级，所有语言一并清）
        Object.keys(next).forEach(l => delete next[l])
        return next
      })
      activeTaskByLangRef.current = {}
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
        {(offlineCachedAt || offlinePartial) && <OfflineCacheNotice cachedAt={offlineCachedAt} partial={offlinePartial} />}
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
          <Text block className={styles.description}>{mod.description}</Text>
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
        {mod.download_count > 0 && (
          <div className={styles.stats}>
            <ArrowDownload24Regular style={{ fontSize: '16px' }} />
            <Text size={300}>{t('workshop.downloadCount', { count: mod.download_count })}</Text>
          </div>
        )}
        {mod.files && mod.files.length > 0 && (
          <div className={styles.section}>
            <Text className={styles.sectionTitle}>{t('workshop.availableVersions')}</Text>
            {mod.files.map(f => {
              const previewFiles = parseManifest(f.manifest)
              return (
              <FileRow key={f.lang_code} langCode={f.lang_code} name={f.file_name} version={f.version} fileSize={f.file_size}>
                {installedByLang[f.lang_code] && (
                  <Text className={styles.meta}>
                    {t('workshop.localVersion', { version: installedByLang[f.lang_code].installed_version })}
                  </Text>
                )}
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
                  disabled={installingLang === f.lang_code || !!subscribeProgress[f.lang_code]}
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
                {/* 仅下载：把原始压缩包存到游戏根目录 sfmmmDownloads，不安装 */}
                <Button
                  size="small"
                  icon={<Save24Regular />}
                  appearance="outline"
                  disabled={archiveProgress[f.lang_code]?.status === 'downloading'}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleArchiveDownload(f)
                  }}
                >
                  {archiveProgress[f.lang_code]?.status === 'downloading'
                    ? t('workshop.downloadOnlyRunning')
                    : t('workshop.downloadOnly')}
                </Button>
                {archiveProgress[f.lang_code] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px' }}>
                    <Text className={styles.meta}>
                      {archiveProgress[f.lang_code].status === 'done'
                        ? t('workshop.downloadOnlyDone')
                        : archiveProgress[f.lang_code].status === 'failed'
                          ? t('workshop.downloadOnlyFailed')
                          : `${t('workshop.stage.downloading', { defaultValue: '下载中' })} ${archiveProgress[f.lang_code].percent}%`}
                      {archiveProgress[f.lang_code].status === 'downloading' && archiveProgress[f.lang_code].speed > 0
                        ? ` · ${formatSpeed(archiveProgress[f.lang_code].speed)}`
                        : ''}
                    </Text>
                    {archiveProgress[f.lang_code].status === 'downloading' && (
                      <ProgressBar value={(archiveProgress[f.lang_code].percent || 0) / 100} thickness="thin" />
                    )}
                    {archiveProgress[f.lang_code].status === 'done' && archiveProgress[f.lang_code].path && (
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Folder24Regular />}
                        onClick={(e) => {
                          e.stopPropagation()
                          // 传文件路径：open_folder 会打开其父目录并高亮该文件
                          invoke('open_folder', { path: archiveProgress[f.lang_code].path })
                        }}
                      >
                        {t('workshop.openDir')}
                      </Button>
                    )}
                  </div>
                )}
                {subscribeProgress[f.lang_code] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px' }}>
                    <Text className={styles.meta}>
                      {subscribeProgress[f.lang_code].stage}
                      {subscribeProgress[f.lang_code].percent > 0 && subscribeProgress[f.lang_code].status !== 'done'
                        ? ` ${subscribeProgress[f.lang_code].percent}%`
                        : ''}
                      {subscribeProgress[f.lang_code].status === 'downloading' && subscribeProgress[f.lang_code].speed > 0
                        ? ` · ${formatSpeed(subscribeProgress[f.lang_code].speed)}`
                        : ''}
                    </Text>
                    {['pending', 'downloading', 'extracting', 'recording'].includes(subscribeProgress[f.lang_code].status) && (
                      <ProgressBar value={(subscribeProgress[f.lang_code].percent || 0) / 100} thickness="thin" />
                    )}
                    {subscribeProgress[f.lang_code].status === 'failed' && (
                      <Text style={{ color: tokens.colorPaletteRedForeground2 }}>
                        {localizeError(t, subscribeProgress[f.lang_code].error) || t('workshop.installFailed', { defaultValue: '安装失败' })}
                      </Text>
                    )}
                  </div>
                )}
                {/* 未安装时也能预览将要写入的文件列表（来自发布者上传的 manifest） */}
                {!installedByLang[f.lang_code] && previewFiles.length > 0 && (
                  <Popover withArrow positioning="below-start">
                    <PopoverTrigger disableButtonEnhancement>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Document24Regular />}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t('workshop.viewFileList')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverSurface style={{ maxHeight: '300px', overflow: 'auto', minWidth: '240px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {previewFiles.map((filePath, idx) => (
                          <Text key={idx} block>{filePath}</Text>
                        ))}
                      </div>
                    </PopoverSurface>
                  </Popover>
                )}
                {isInstalled && (
                  <>
                    <Button
                      size="small"
                      icon={<Folder24Regular />}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (installedDir) {
                          invoke('open_folder', { path: installedDir, selected_items: openDirHighlightItems(installedFiles) })
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
                            <Text>{t('workshop.noFiles')}</Text>
                          ) : (
                            installedFiles.map((filePath, idx) => (
                              <Text key={idx} block>{filePath}</Text>
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
              </FileRow>
            )})}
          </div>
        )}
        {installInfo && (
          <div style={{ padding: '10px 12px', background: tokens.colorPaletteGreenBackground1, borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Text style={{ color: tokens.colorPaletteGreenForeground1 }}>{installInfo}</Text>
          </div>
        )}
        {installedDir && (
          <div style={{ padding: '10px 12px', background: tokens.colorPaletteGreenBackground1, borderRadius: '6px' }}>
            <Text style={{ color: tokens.colorPaletteGreenForeground1 }}>
              {t('workshop.installSuccess')}{installedDir}
            </Text>
            <Button size="small" appearance="subtle" style={{ marginLeft: '8px' }} onClick={() => invoke('open_folder', { path: installedDir, selected_items: openDirHighlightItems(installedFiles) })}>
              {t('workshop.openDir')}
            </Button>
          </div>
        )}
        {installError && (
          <div style={{ padding: '10px 12px', background: tokens.colorPaletteRedBackground1, borderRadius: '6px' }}>
            <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{installError}</Text>
          </div>
        )}
        {archiveError && (
          <div style={{ padding: '10px 12px', background: tokens.colorPaletteRedBackground1, borderRadius: '6px' }}>
            <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
              {archiveError}
            </Text>
          </div>
        )}
        {archiveInfo && (
          <div style={{ padding: '10px 12px', background: tokens.colorPaletteGreenBackground1, borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Text style={{ color: tokens.colorPaletteGreenForeground1 }}>{archiveInfo}</Text>
          </div>
        )}
        {uninstallError && (
          <div style={{ padding: '10px 12px', background: tokens.colorPaletteRedBackground1, borderRadius: '6px' }}>
            <Text style={{ color: tokens.colorPaletteRedForeground1 }}>{uninstallError}</Text>
          </div>
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
        ...(isDev ? [{ key: 'forceDelete', icon: <Delete24Regular />, appearance: 'outline', onClick: () => { setForceDeleteError(''); setConfirmForceDelete(true) }, label: t('workshop.forceDelete'), style: { color: tokens.colorPaletteRedForeground1 } }] : []),
      ]} />

      <Dialog open={confirmForceDelete} onOpenChange={(_, { open }) => { if (!open && !forceDeleting) setConfirmForceDelete(false) }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{t('workshop.forceDeleteTitle')}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                <Text size="small">{t('workshop.forceDeleteHint', { name: mod.display_name || mod.mod_key })}</Text>
                {forceDeleteError && (
                  <Text size="small" style={{ color: tokens.colorPaletteRedForeground1 }}>{forceDeleteError}</Text>
                )}
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
