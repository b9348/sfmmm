import { useState, useEffect, useRef, useCallback } from 'react'
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
} from '@fluentui/react-icons'
import { installMod, uninstallMod } from '../../services/installMod'
import { listen } from '@tauri-apps/api/event'
import { RichTextContent, MarkdownContent } from '../../components/common/RichTextEditor'
import { invoke } from '@tauri-apps/api/core'
import { useAuth } from '../../contexts/useAuth'
import { submitApplication, likeMod, unlikeMod, getDeviceId, rateMod, unrateMod } from '../../services/workshopApi'
import { upsertLikedModToCache, removeLikedModFromCache } from '../../services/likedModsCache'
import { upsertRatedModToCache } from '../../services/ratingCache'
import CommentSection from './CommentSection'
import { getDb, getGamePath } from '../../services/dbHelper'
import { BackButton, FloatingActions, FileRow, UserLink } from '../../components'
import { RatingStarsInteractiveDisplay } from '../../components/common/RatingStars'
import { LANGUAGES, LANG_LABELS } from '../../i18n/languages'

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
    gap: '12px',
    height: '100%',
    overflow: 'auto',
  },
  toolbarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    position: 'sticky',
    top: 0,
    zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '4px 0',
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
  ratingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
  },
  stats: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
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
  const [installInfo, setInstallInfo] = useState('')
  // 订阅下载实时进度：按 lang_code 存 { percent, stage, status, error }
  // 与订阅记录页共享同一 subscription-progress 事件源，本页只关心本 mod 的任务
  const [subscribeProgress, setSubscribeProgress] = useState({})
  // 当前活跃订阅任务：lang_code → taskId（用于 listen 时按 taskId 匹配回 lang）
  const activeTaskByLangRef = useRef({})
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
  const [ratingAvg, setRatingAvg] = useState(mod.rating_avg || 0)
  const [ratingCount, setRatingCount] = useState(mod.rating_count || 0)
  const [myRating, setMyRating] = useState(mod.my_rating || 0)
  const [ratingBusy, setRatingBusy] = useState(false)

  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  useEffect(() => {
    const handleMouseUp = (e) => {
      if (e.button === 3) {
        e.preventDefault()
        onBackRef.current()
      }
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [])

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
      })
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
      upsertRatedModToCache({
        ...mod,
        mod_id: mod.id,
        mod_key: mod.mod_key,
        my_rating: 0,
        rating_avg: res.rating_avg ?? ratingAvg,
        rating_count: res.rating_count ?? ratingCount,
      })
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
          const gamePath = await getGamePath()
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
          }
        }
      } catch (e) {
        console.warn('[ModDetailPage] 查询安装状态失败:', e)
      }
    }, [mod.mod_key, mod.files])

  // 切屏回来 / 首次挂载：重查安装记录刷新已安装态
  useEffect(() => {
    checkInstalled()
  }, [checkInstalled])

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
      })
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
      // 命中去重（deduplicated=true）：旧任务已 done，前端进度不会再来，
      // 复用 checkInstalled 重查 SQLite 刷已安装态（打开目录按钮等就位），不另写旁路显示
      if (result?.deduplicated) {
        checkInstalled()
      }
    } catch (e) {
      setInstallError(e.message)
    } finally {
      setInstallingLang('')
    }
  }

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
        },
      }))
      // 任务终结：清活跃映射。done 时复用 checkInstalled 重查 SQLite 刷已安装态
      // （installedByLang/isInstalled/installedDir/installedFiles 全套和切屏回来一致），
      // 不另写旁路显示避免样式不一致 + 打开目录按钮拿不到 installedDir 点不动
      if (['done', 'failed', 'cancelled'].includes(payload.status)) {
        delete activeTaskByLangRef.current[lang]
        if (payload.status === 'done') {
          checkInstalled()
        }
      }
    })
      .then(fn => { unlistenFn = fn })
      .catch(() => {})
    return () => { if (unlistenFn) unlistenFn() }
  }, [t])

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
          <UserLink
            userId={mod.author_id}
            username={mod.author_name}
            avatar={mod.author_avatar}
            size={24}
            nameSize={200}
          />
          {mod.category && (
            <Badge appearance="outline" size="small" style={{ whiteSpace: 'nowrap' }}>
              {t(`workshop.category_${mod.category}`)}
            </Badge>
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
            <Text size="small" className={styles.meta}>
              {t('workshop.loginToRate')}
            </Text>
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
              <FileRow key={f.lang_code} langCode={f.lang_code} name={f.file_name} version={f.version} fileSize={f.file_size}>
                {installedByLang[f.lang_code] && (
                  <Text size="small" className={styles.meta}>
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
                {subscribeProgress[f.lang_code] && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px' }}>
                    <Text size="small" className={styles.meta}>
                      {subscribeProgress[f.lang_code].stage}
                      {subscribeProgress[f.lang_code].percent > 0 && subscribeProgress[f.lang_code].status !== 'done'
                        ? ` ${subscribeProgress[f.lang_code].percent}%`
                        : ''}
                    </Text>
                    {['pending', 'downloading', 'extracting', 'recording'].includes(subscribeProgress[f.lang_code].status) && (
                      <ProgressBar value={(subscribeProgress[f.lang_code].percent || 0) / 100} thickness="thin" />
                    )}
                    {subscribeProgress[f.lang_code].status === 'failed' && (
                      <Text size="small" style={{ color: tokens.colorPaletteRedForeground2 }}>
                        {subscribeProgress[f.lang_code].error || t('workshop.installFailed', { defaultValue: '安装失败' })}
                      </Text>
                    )}
                  </div>
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
              </FileRow>
            )})}
          </div>
        )}
        {installInfo && (
          <div style={{ padding: '8px', background: tokens.colorPaletteGreenBackground1, borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Text size="small" style={{ color: tokens.colorPaletteGreenForeground1 }}>{installInfo}</Text>
          </div>
        )}
        {installedDir && (
          <div style={{ padding: '8px', background: tokens.colorPaletteGreenBackground1, borderRadius: '4px' }}>
            <Text size="small" style={{ color: tokens.colorPaletteGreenForeground1 }}>
              {t('workshop.installSuccess')}{installedDir}
            </Text>
            <Button size="small" appearance="subtle" style={{ marginLeft: '8px' }} onClick={() => invoke('open_folder', { path: installedDir, selected_items: openDirHighlightItems(installedFiles) })}>
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

      <FloatingActions items={[
        { key: 'back', icon: <ArrowLeft24Regular />, onClick: onBack },
        { key: 'like', icon: isLiked ? <Heart24Filled /> : <Heart24Regular />, appearance: isLiked ? 'primary' : 'outline', onClick: handleLikeToggle, disabled: likeBusy, label: String(likeCount), style: isLiked ? { color: tokens.colorPaletteRedForeground1 } : undefined },
        ...(user && canEdit ? [{ key: 'edit', icon: <Edit24Regular />, appearance: 'primary', onClick: () => onEdit?.(mod) }] : []),
        ...(user && canApply ? [{ key: 'apply', icon: <Add24Regular />, appearance: 'primary', onClick: () => setApplyOpen(true), label: t('workshop.applyToEdit') }] : []),
      ]} />
    </div>
  )
}
