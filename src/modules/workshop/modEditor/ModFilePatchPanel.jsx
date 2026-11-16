import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Input, Text, Spinner, Badge, Checkbox, makeStyles, tokens,
} from '@fluentui/react-components'
import { open } from '@tauri-apps/plugin-dialog'
import { stat } from '@tauri-apps/plugin-fs'
import {
  openModEditWorkspace,
  autoApplyModEditLocal,
  rescanModEditLocal,
  buildModEditPackage,
  discardModEditWorkspace,
  modEditWorkspaceKey,
} from '../../../services/workshopApi'
import { useUserNav } from '../../../contexts/useUserNav'
import { localizeError } from '../../../utils/localizeError'
import { LANG_LABELS } from '../../../i18n/languages'
import { ConfirmDialog } from '../../../components/common/ConfirmDialog'
import { NoticeBar } from '../../../components/common/NoticeBar'

// 与 Rust 端 is_valid_version 同一口径：版本号会拼进远端对象路径
// sfm/{mod_id}/{lang}/{version}/edit_...，只允许安全字符集与 64 长度上限。
const VERSION_PATTERN = /^[0-9A-Za-z._-]{1,64}$/

const useStyles = makeStyles({
  // 内联在语言块下方，不遮挡页面；视觉上与语言块区分为浅底卡片
  inline: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
    padding: '8px',
    marginTop: '-4px',
    marginBottom: '8px',
  },
  inlineHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    marginBottom: '6px',
  },
  hint: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.5',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 4px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  path: {
    flex: 1,
    minWidth: 0,
    fontSize: tokens.fontSizeSmall,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
  // 行主体两段式：第一行放文件名+徽标+大小，替换来源等次要信息下沉到第二行
  rowMain: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  rowLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
  },
  stagedFrom: {
    // 比 meta 再弱一档（置灰更深），避免与文件名抢视觉
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeSmall,
    lineHeight: '1.4',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  list: {
    maxHeight: '340px',
    overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeSmall,
  },
  // 危险操作按钮：统一 outlined（secondary）+ danger 配色，不再用文字样式
  dangerButton: {
    color: tokens.colorStatusDangerForeground1,
    borderColor: tokens.colorStatusDangerBorder1,
    ':hover': {
      color: tokens.colorStatusDangerForeground1,
      borderColor: tokens.colorStatusDangerBorder1,
      backgroundColor: tokens.colorStatusDangerBackground1,
    },
    ':active': {
      color: tokens.colorStatusDangerForeground1,
      borderColor: tokens.colorStatusDangerBorder1,
      backgroundColor: tokens.colorStatusDangerBackground2,
    },
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  built: {
    padding: '8px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: tokens.fontSizeSmall,
  },
})

/**
 * 上次为该 mod/语言使用的草稿指针。
 * 只是本机路径记忆，放 localStorage（按用户隔离），不进数据库。
 */
function wsKey(userId, modId, lang) {
  return modEditWorkspaceKey(userId, modId, lang)
}
// 从本地源文件路径取文件名（跨 Windows / POSIX 分隔符）
function fileBaseName(p) {
  return String(p || '').split(/[\\/]/).pop() || ''
}

function formatSize(bytes) {
  // null 表示大小未知（草稿恢复/刚挑选的文件还没 stat），显示占位而不是误导性的 0 B
  if (bytes == null) return '—'
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 列表增量渲染：单批渲染行数。筛选/语言变化时从头重置。
const RENDER_CHUNK = 200

function stripArrayPrefix(name) {
  // 部分平台上 dialog 的单选也会返回数组
  return Array.isArray(name) ? name[0] : name
}

// 选择阶段先取文件大小；取不到时返回 null，让后续构建阶段继续兜底。
async function fileSizeOrNull(path) {
  try {
    const info = await stat(path)
    return Number(info?.size) || 0
  } catch {
    return null
  }
}

/**
 * 编辑页「选择性替换压缩包内文件」面板。
 * 每次打开（或切换语言）都挂载新的 Body，避免在 effect 里同步重置大量状态。
 */
export function ModFilePatchPanel(props) {
  const { isOpen, lang, modId } = props
  if (!isOpen || !lang) return null
  return <PatchPanelBody key={`${modId}:${lang}`} {...props} />
}

function PatchPanelBody({
  lang,
  modId,
  userId,
  // 编辑表单当前分类：决定条目路径按哪个安装根归一（composite=游戏根）
  category = '',
  // 与主编辑器共用同一上传上限，选择阶段就拦截超限文件
  maxZipSize = 20 * 1024 * 1024,
  // 与编辑表单 translations[lang].version 共用同一数据源，双向联动
  version = '',
  onVersionChange,
  wholeArchivePending = false,
  force = false,
  onClose,
  // 把「尚未构建的本地草稿」同步给页面：保存时可复用同一份 draft 自动构建，
  // 避免作者在面板里改完直接点保存却跳过构建。
  onDraftChange = null,
  // 面板收起/切换语言会卸载重建：从这里恢复上一次未构建的草稿选择
  getDraft = null,
  // 构建成功/失效时通知父页面：待发布包挂在该语言的待保存状态上，
  // 真正上传与写库统一在页面点「保存」时执行。
  onBuilt,
  onBusyChange,
}) {
  const { t } = useTranslation()
  const styles = useStyles()
  const { openSettings } = useUserNav()

  const [loading, setLoading] = useState(true)
  const [data, setData] = useState(null)
  const [built, setBuilt] = useState(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [building, setBuilding] = useState(false)
  // 文件多时一次性渲染全部行会卡顿：先渲染一部分，按需增量展开
  const [renderLimit, setRenderLimit] = useState(RENDER_CHUNK)
  // 本地目录导入汇总（缺失/变更数），打开面板时从草稿恢复
  const [importSummary, setImportSummary] = useState(null)
  // 自动套用本地来源后的提示
  const [notice, setNotice] = useState('')
  // 非阻断提醒：旧草稿因基线变更被清理、manifest 目录条目因长度限制降级
  const [warning, setWarning] = useState('')
  const [discardOpen, setDiscardOpen] = useState(false)
  // 强制重扫本地目录：确认后才清掉已构建的补丁包并全量重新比对
  const [rescanOpen, setRescanOpen] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  // 按类别从游戏目录推导来源失败时的明确原因（未配置/游戏目录无效/类别子目录不存在）
  const [sourceError, setSourceError] = useState('')
  const [sourceErrorCode, setSourceErrorCode] = useState('')
  // ── 草稿：全部放在前端内存，编辑阶段零后端调用 ──
  // 勾选 / 删除（本次不打包）
  const [selectedPaths, setSelectedPaths] = useState(() => new Set())
  const [excludedPaths, setExcludedPaths] = useState(() => new Set())
  // 本次会话新增的文件（尚未落盘）：path → 本地源文件绝对路径
  const [draftAdds, setDraftAdds] = useState([])
  // 本次会话的行级替换：path → { path, sourcePath, name, size }
  const [draftReplaces, setDraftReplaces] = useState({})
  // 选择器打开中（仅防重复点击，不涉及后端）
  const [picking, setPicking] = useState(false)
  // 上一次生效的分类：用于识别「面板打开期间改了分类」，让旧草稿明确作废
  const prevCategoryRef = useRef(undefined)

  const workspaceId = data?.workspace_id || ''
  // 路径列表预览（提示里展示缺失/跳过列表）
  const previewPaths = (list) =>
    list.slice(0, 6).join('、') + (list.length > 6 ? ' …' : '')

  // 待发布包只在「页面保存」时发布：这里把构建结果同步到父页面，
  // 构建/草稿变更都通过 applyData 刷新，避免保存时发布一个旧包。
  const applyBuilt = useCallback((ws, b) => {
    setBuilt(b || null)
    onBuilt?.(lang, b ? { workspace_id: ws, built: b } : null)
  }, [lang, onBuilt])

  // 后端视图 → 前端状态。打开面板与构建完成后共用。
  // restoreDraft：面板被收起/切语言后重新打开时，用父页面记住的草稿恢复选择。
  // 草稿是面板最后一次上报的**完整快照**（selected/excluded/added/replaced 全量），
  // 因此恢复时必须以草稿为准，不能再与后端已落盘的 meta.selected/meta.excluded 取并集：
  // 否则「构建后撤销删除/重新勾选」的改动会在重开面板时被后端快照覆盖回去（动作被复活）。
  const applyData = useCallback((d, restoreDraft = null) => {
    setData(d)
    applyBuilt(d.workspace_id, d.built)
    setImportSummary(d.local_source?.summary || null)
    const nextSelected = new Set(restoreDraft ? (restoreDraft.selected || []) : (d.selected || []))
    if (!restoreDraft && d.selection_initialized === false) {
      Object.keys(d.staged || {}).forEach(p => nextSelected.add(p))
    }
    if (restoreDraft) {
      // 恢复草稿时仍以草稿为准（撤销删除/取消勾选不能被后端快照复活），但后端
      // 本次新检出并已 staged+selected 的条目必须补进来：它们不在草稿快照的
      // staged_paths 里，说明是面板收起后才发现的，旧 selected 会把它们丢掉。
      const knownStaged = restoreDraft.staged_paths
      if (Array.isArray(knownStaged)) {
        const known = new Set(knownStaged)
        const backendSelected = new Set(d.selected || [])
        const restoredExcluded = new Set(restoreDraft.excluded || [])
        Object.keys(d.staged || {}).forEach((p) => {
          if (known.has(p) || restoredExcluded.has(p)) return
          if (backendSelected.has(p)) nextSelected.add(p)
        })
      }
    }
    const entryPaths = new Set((d.entries || []).map(e => e.path))
    if (restoreDraft) {
      const restoredAdds = (restoreDraft.added || [])
        .filter(a => !entryPaths.has(a.path))
        .map(a => ({ path: a.path, sourcePath: a.source_path, name: fileBaseName(a.source_path), size: null }))
      const restoredReplaces = {}
      for (const r of restoreDraft.replaced || []) {
        if (!entryPaths.has(r.path)) continue
        restoredReplaces[r.path] = { path: r.path, sourcePath: r.source_path, name: fileBaseName(r.source_path), size: null }
      }
      setSelectedPaths(nextSelected)
      setExcludedPaths(new Set(restoreDraft.excluded || []))
      setDraftAdds(restoredAdds)
      setDraftReplaces(restoredReplaces)
      return
    }
    setSelectedPaths(nextSelected)
    setExcludedPaths(new Set(d.excluded || []))
    setDraftAdds([])
    setDraftReplaces({})
  }, [applyBuilt])

  // 草稿只在前端内存里变化：一旦改动，之前构建出的待发布包就失效了，
  // 必须同步清掉父页面的待保存状态，避免「先构建、再删除、保存时发布旧包」。
  const invalidateBuilt = useCallback(() => {
    if (built) applyBuilt(workspaceId, null)
  }, [built, applyBuilt, workspaceId])

  // 后端错误码 → 本地化文案。取不到游戏路径时给「去设置」，不是让人选目录。
  const localizeSourceError = useCallback((info) => {
    switch (info?.error_code) {
      case 'GAME_PATH_MISSING':
        return t('workshop.patchGamePathMissing')
      case 'GAME_PATH_INVALID':
        return t('workshop.patchGamePathInvalid')
      case 'GAME_PATH_READ_FAILED':
        return t('workshop.patchGamePathReadFailed')
      case 'ROOT_MISSING':
        return t('workshop.patchRootMissing', { path: info?.expected_root || '' })
      default:
        return info?.error || ''
    }
  }, [t])

  // 构建进行中把忙碌状态同步给父组件：此时不允许切换语言或收起，
  // 否则内联区域卸载后用户会失去进度反馈（后端任务仍在继续）。
  useEffect(() => {
    onBusyChange?.(building)
    // 卸载时若仍在构建，必须把忙碌态复位：否则父页面 patchBusy 永久为 true，
    // 之后所有「选择性替换」按钮禁用、保活灯永久暂停。构建结果由父页面按
    // 「语言是否还存在」判定是否采纳（见 useModEditor.handlePatchBuilt）。
    return () => {
      if (building) onBusyChange?.(false)
    }
  }, [building, onBusyChange])

  useEffect(() => {
    let cancelled = false
    const cached = localStorage.getItem(wsKey(userId, modId, lang))
    // 分类变化会改变条目路径的归一/落盘规则：旧草稿已不可复用（父页面也已清空），
    // 明确提示后按新分类重建，避免按旧路径发布。
    const categoryChanged = prevCategoryRef.current !== undefined && prevCategoryRef.current !== category
    prevCategoryRef.current = category
    if (categoryChanged) {
      onDraftChange?.(lang, null, -1)
      setWarning(t('workshop.patchCategoryChangedDraftReset'))
    }
    // 收起/切语言后重新打开：恢复父页面里尚未构建的草稿
    const restoreDraft = categoryChanged ? null : (getDraft?.(lang) || null)
    openModEditWorkspace({ mod_id: modId, user_id: userId, lang_code: lang, workspace_id: cached, force, category })
      .then(d => {
        if (cancelled) return
        const restore = (restoreDraft && !d.staleDraftDiscarded) ? restoreDraft : null
        applyData(d, restore)
        // 旧草稿因整包更新导致基线变化：后端已清理，明确告知并让用户重新选择文件
        const warnings = []
        if (d.staleDraftDiscarded) warnings.push(t('workshop.patchStaleDraft'))
        if (warnings.length) setWarning(warnings.join(' '))
        if (d.workspace_id) localStorage.setItem(wsKey(userId, modId, lang), d.workspace_id)
        // 打开面板即按程序已配置的游戏路径 + category 推导安装根目录，
        // 逐条映射 manifest 并在本地比对指纹——没有「选择来源」这一步。
        if (!d.workspace_id) {
          setLoading(false)
          return
        }
        autoApplyModEditLocal({ workspace_id: d.workspace_id, user_id: userId })
          .then(auto => {
            if (cancelled) return
            const info = auto.auto || {}
            // auto 是完整视图：同步过来让失效的来源状态一起更新（同样恢复草稿）
            applyData(auto, restore)
            if (info.mode === 'error') {
              setSourceError(localizeSourceError(info))
              setSourceErrorCode(info.error_code || '')
            } else {
              setSourceError('')
              setSourceErrorCode('')
              if (info.mode === 'import') {
                setNotice(t('workshop.patchAutoApplied', {
                  count: Number(info.applied) || 0,
                }))
              }
            }
            if (info.skipped?.length) {
              setWarning(t('workshop.patchAutoSkipped', {
                count: info.skipped.length,
                list: previewPaths(info.skipped),
              }))
            }
          })
          // 扫描/读取失败也要说出来，不能静默退化成「无来源」
          .catch(e => {
            if (cancelled) return
            setSourceError(localizeError(t, e?.message || String(e)))
            setSourceErrorCode('')
          })
          // 只有按游戏目录比对完成后才结束加载态：否则扫描期间会出现
          // 「没有任何变化」这类误导性结论
          .finally(() => { if (!cancelled) setLoading(false) })
      })
      .catch(e => {
        if (cancelled) return
        // 不要在这里清指针：打开失败多为瞬时网络/DB 错误，
        // 后端对无效 workspace_id 会静默新建，重试即可恢复草稿
        setError(e.message)
        setLoading(false)
      })
    return () => { cancelled = true }
    // getDraft / onDraftChange 只在「打开工作区」这一刻读取一次：父组件每次渲染都会传新函数，
    // 放进依赖会让 effect 每次渲染都重跑（重复打开工作区），故显式忽略依赖检查。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modId, lang, userId, force, category, t, applyData, localizeSourceError])

  // 发布进度不再由面板处理：真正上传发生在页面「保存」时，
  // 进度反馈统一由 useModEditor 订阅 mod-edit-publish-progress。

  const entries = useMemo(() => data?.entries || [], [data])
  // 后端已落盘的替换/新增（打开面板时自动导入的）
  const staged = useMemo(() => data?.staged || {}, [data])
  const excluded = excludedPaths
  const selected = selectedPaths
  // 本次新增的条目（后端已落盘的 + 本次会话还未落盘的）
  const added = useMemo(() => {
    const set = new Set(data?.added || [])
    draftAdds.forEach(a => set.add(a.path))
    return set
  }, [data, draftAdds])
  const addedCount = added.size
  // 本次打包实际保留的文件条目数（清单条目 - 删除 + 新增）。
  // 为 0 时必须阻止构建/保存：不能让作者错手删空后发布空包。
  // 口径与后端 build_package_inner 一致：
  // - 原始条目只在「删除」时不写入，未勾选只是保留基线内容，仍会进包；
  // - 新增条目未勾选则不写入；同一路径重复出现只算一次。
  const remainingFileCount = useMemo(() => {
    const backendAdded = new Set(data?.added || [])
    const draftAddedPaths = new Set(draftAdds.map(a => a.path))
    const kept = new Set()
    entries.forEach((e) => {
      if (excluded.has(e.path)) return
      // 新增条目未勾选不会写入；原始条目未勾选仍写基线
      if (backendAdded.has(e.path) && !selected.has(e.path) && !draftAddedPaths.has(e.path)) return
      kept.add(e.path)
    })
    draftAdds.forEach((a) => {
      if (excluded.has(a.path) || !selected.has(a.path)) return
      kept.add(a.path)
    })
    return kept.size
  }, [entries, excluded, selected, data, draftAdds])
  // 保存时自动构建用的草稿：与下方「构建待发布包」按钮提交的 payload 完全一致。
  const draftPayload = useMemo(() => ({
    selected: [...selectedPaths],
    excluded: [...excludedPaths],
    added: draftAdds.map(a => ({ path: a.path, source_path: a.sourcePath })),
    replaced: Object.values(draftReplaces).map(r => ({
      path: r.path,
      source_path: r.sourcePath,
    })),
    // 面板上次看到过的 staged 条目集合（含草稿新增/替换）。后端据此判断
    // 草稿是否落后于工作区：不在快照里的 staged 条目 = 收起后才检出的新变化。
    staged_paths: [...new Set([
      ...Object.keys(staged),
      ...Object.keys(draftReplaces),
      ...draftAdds.map(a => a.path),
    ])],
  }), [selectedPaths, excludedPaths, draftAdds, draftReplaces, staged])
  // 是否有「与当前视图不同」的未构建改动：用于页面离开确认。
  // 刚打开面板（全部已落盘条目默认勾选、无删除/新增/替换）不算改动。
  const draftDirty = useMemo(() => {
    if (draftAdds.length > 0 || Object.keys(draftReplaces).length > 0 || excludedPaths.size > 0) return true
    const allKnown = [...Object.keys(staged), ...(data?.added || [])]
    return allKnown.some(p => !selectedPaths.has(p))
  }, [draftAdds, draftReplaces, excludedPaths, selectedPaths, staged, data])
  useEffect(() => {
    if (!data) return undefined
    // 已选择整包替换（wholeArchivePending）时不走工作区补丁包，文件清单为空
    // 也不影响保存（那是另一条全量发布路径），因此不上报空清单标记。
    const remaining = wholeArchivePending ? -1 : remainingFileCount
    onDraftChange?.(lang, draftPayload, remaining, draftDirty)
    return undefined
  }, [lang, data, draftPayload, remainingFileCount, wholeArchivePending, draftDirty, onDraftChange])
  // 面板卸载（收起/切语言/删除语言）时只清父页面的「空清单」标记：标记只描述面板
  // 当前视图，留着会让页面「保存」在本页面生命周期内永久禁用（改用整包替换也无法保存）。
  // 草稿不在这里写回：删除语言后卸载不能把已删除语言的草稿复活（remaining=-2 只清标记）。
  useEffect(() => () => {
    onDraftChange?.(lang, null, -2)
  }, [lang, onDraftChange])
  // 筛选条件 / 语言变化时从头渲染（渲染期间调整 state 的官方模式，不用 effect）
  const [prevResetKey, setPrevResetKey] = useState({ filter, lang })
  if (prevResetKey.filter !== filter || prevResetKey.lang !== lang) {
    setPrevResetKey({ filter, lang })
    setRenderLimit(RENDER_CHUNK)
  }
  // 生效的替换集合：后端 staged + 本地草稿（构建时才提交）
  const effectiveStaged = useMemo(() => {
    const map = { ...staged }
    Object.values(draftReplaces).forEach((r) => {
      map[r.path] = {
        staged_name: `draft:${r.path}`,
        source_name: r.name,
        source_path: r.sourcePath,
        size: r.size ?? null,
      }
    })
    draftAdds.forEach((a) => {
      map[a.path] = {
        staged_name: `draft:${a.path}`,
        source_name: a.name,
        source_path: a.sourcePath,
        size: a.size ?? null,
      }
    })
    return map
  }, [staged, draftReplaces, draftAdds])
  // 列表 = 后端清单条目 + 本次会话新增（后端尚未落盘）
  const allEntries = useMemo(() => {
    const rows = [...entries]
    const known = new Set(entries.map(e => e.path))
    draftAdds.forEach((a, i) => {
      if (!known.has(a.path)) {
        rows.push({ index: -1 - i, path: a.path, size: a.size ?? null, draft: true })
      }
    })
    return rows
  }, [entries, draftAdds])
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return allEntries
    return allEntries.filter(e => e.path.toLowerCase().includes(needle))
  }, [allEntries, filter])

  const base = data?.base
  const stagedKeys = Object.keys(effectiveStaged)
  const stagedCount = stagedKeys.length
  const selectedCount = stagedKeys.filter(p => selected.has(p)).length
  // 取消勾选的变化条目：打包时必须从底包取回基线原样（可能触发下载）
  const unselectedChangedCount = stagedKeys.filter(
    p => !selected.has(p) && !excluded.has(p),
  ).length
  const excludedCount = excluded.size
  const localSource = data?.local_source || null
  // 来源根目录的来路标签：面板必须让作者一眼确认读的是哪一层
  const rootKindLabel = (kind) => ({
    game_root: t('workshop.patchRootKindGameRoot'),
    custom_missions: t('workshop.patchRootKindV1'),
    custom_missions2: t('workshop.patchRootKindV2'),
    plugins: t('workshop.patchRootKindPlugins'),
  }[kind] || t('workshop.patchRootKindDir'))
  const sourceRootPath = importSummary?.root_path || localSource?.root_path || ''
  // 游戏目录里找不到的条目：本次已替换/已删除的不再算「本地缺失」。
  // 它们只影响展示（保留原文件），不阻断构建：未选中替换的条目会从底包取原文。
  const missingOpen = useMemo(
    () => (importSummary?.missing || []).filter(p => !effectiveStaged[p] && !excluded.has(p)),
    [importSummary, effectiveStaged, excluded],
  )
  // 路径无法解析（本地存在多个候选）的条目：和缺失同样保留线上原文件，
  // 但必须单独提示候选，不能静默按 basename 瞎猜。
  const ambiguousSet = useMemo(
    () => new Set(importSummary?.ambiguous || []),
    [importSummary],
  )
  const keepOriginalSet = useMemo(
    () => new Set([...missingOpen, ...ambiguousSet]),
    [missingOpen, ambiguousSet],
  )
  // 版本号字符集不合法的即时提示（仅内容有变化时该值才会被用于发布路径）
  const versionInvalid = version.trim() !== '' && !VERSION_PATTERN.test(version.trim())
  // ── 构建禁用判定 ──
  // 结论必须同时驱动按钮 disabled 与面板内的原因文案，避免"灰掉但不说为什么"。
  const localChanged = (importSummary?.changed || 0) + Object.keys(draftReplaces).length
  const localUnchanged = importSummary?.unchanged || 0
  const baselineHashes = base?.file_hash_count || 0
  // 本地文件全部与线上指纹一致（无变化、无新增、无剔除）
  const allIdentical = !!localSource && !!importSummary
    && localChanged === 0 && localUnchanged > 0
    && addedCount === 0 && excludedCount === 0
  // 检测到变化文件，但一个都没勾选
  const noneSelected = stagedCount > 0 && selectedCount === 0
    && excludedCount === 0 && addedCount === 0
  const buildBlocked = wholeArchivePending
    ? {
        // 同一语言只能走一条发布路径：整包与补丁包不能同时进入本次保存
        code: 'wholeArchive',
        text: t('workshop.patchWholeArchiveWarning'),
        hint: '',
      }
    // 游戏路径取不到：明确要求去设置配置，不提供「选择目录」入口
    : sourceError
      ? {
          code: 'gamePath',
          text: sourceError,
          hint: '',
        }
      : remainingFileCount === 0
        ? {
            code: 'emptyList',
            text: t('workshop.patchBuildBlockedEmptyList'),
            hint: '',
          }
        : noneSelected
          ? {
              code: 'noneSelected',
              text: t('workshop.patchBuildBlockedNoneSelected', { count: stagedCount }),
              hint: '',
            }
        : allIdentical
          ? {
              code: 'allSame',
              text: t('workshop.patchBuildBlockedAllSame', {
                count: localUnchanged,
                hashes: baselineHashes,
              }),
              hint: '',
            }
          : (stagedCount === 0 && excludedCount === 0 && addedCount === 0)
            ? {
                code: 'noChanges',
                text: t('workshop.patchBuildBlockedEmpty'),
                hint: '',
              }
            : null

  // 本机绝对路径是否位于游戏内的来源根目录之下。
  // 文件必须来自游戏目录，来源唯一确定，因此不允许选游戏目录之外的文件。
  const isUnderSourceRoot = (abs) => {
    const root = sourceRootPath.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!root) return false
    const p = String(abs || '').replace(/\\/g, '/')
    const lowerRoot = root.toLowerCase()
    return p.toLowerCase() === lowerRoot || p.toLowerCase().startsWith(`${lowerRoot}/`)
  }
  const pathUnderRoot = (abs) => {
    if (!isUnderSourceRoot(abs)) return ''
    const root = sourceRootPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const p = String(abs || '').replace(/\\/g, '/')
    return p.substring(root.length).replace(/^\/+/, '')
  }
  const baseName = (p) => String(p || '').split(/[\\/]/).pop() || ''

  // 行级替换：只记录在本机内存，构建时才提交并复制文件。
  const handleReplace = async (entry) => {
    setError('')
    if (!sourceRootPath) {
      setError(sourceError || t('workshop.patchGamePathMissing'))
      return
    }
    const picked = stripArrayPrefix(await open({
      multiple: false,
      directory: false,
      filters: [{ name: t('workshop.patchAllFiles'), extensions: ['*'] }],
    }))
    if (!picked) return
    if (!isUnderSourceRoot(picked)) {
      setError(t('workshop.patchPickOutsideRoot', { root: sourceRootPath }))
      return
    }
    const pickedSize = await fileSizeOrNull(picked)
    if (pickedSize != null && pickedSize > maxZipSize) {
      setError(t('workshop.modSelectedFileTooLarge', {
        max: maxZipSize / 1024 / 1024,
        files: baseName(picked),
      }))
      return
    }
    setDraftReplaces(prev => ({
      ...prev,
      [entry.path]: {
        path: entry.path,
        sourcePath: picked,
        name: baseName(picked),
        size: pickedSize,
      },
    }))
    invalidateBuilt()
    setDraftAdds(prev => prev.filter(a => a.path !== entry.path))
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      next.add(entry.path)
      return next
    })
    setExcludedPaths((prev) => {
      const next = new Set(prev)
      next.delete(entry.path)
      return next
    })
  }

  // 撤销：本地即时生效，不请求后端。
  // - 本次会话的替换/新增：直接丢弃草稿
  // - 后端已导入的替换：取消勾选（打包改用基线原样）
  const handleUndo = (entry) => {
    setError('')
    invalidateBuilt()
    if (draftReplaces[entry.path]) {
      setDraftReplaces((prev) => {
        const next = { ...prev }
        delete next[entry.path]
        return next
      })
      return
    }
    if (draftAdds.some(a => a.path === entry.path)) {
      setDraftAdds(prev => prev.filter(a => a.path !== entry.path))
      setSelectedPaths((prev) => {
        const next = new Set(prev)
        next.delete(entry.path)
        return next
      })
      return
    }
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      next.delete(entry.path)
      return next
    })
  }

  // 添加文件：只记录到前端草稿；文件复制发生在构建时。
  // 目标路径按类别规则推导（dll=basename，其余=相对来源根目录）。
  const handleAddFiles = async () => {
    setError('')
    if (!sourceRootPath) {
      setError(sourceError || t('workshop.patchGamePathMissing'))
      return
    }
    setPicking(true)
    try {
      const picked = await open({
        multiple: true,
        directory: false,
        filters: [{ name: t('workshop.patchAllFiles'), extensions: ['*'] }],
      })
      if (!picked) return
      const paths = Array.isArray(picked) ? picked : [picked]
      const cat = data?.category
      const rejected = []
      const oversized = []
      const next = [...draftAdds]
      // 只勾选本次新挑的文件：不能把 draftAdds 里已有的新增项一并重新勾上，
      // 否则用户此前手动取消勾选的新增项会被「加一个新文件」复活。
      const addedNow = []
      for (const p of paths) {
        // 所有类别都要求文件来自游戏内来源根目录：来源唯一确定，路径推导才成立。
        // dll 虽然只取 basename，也必须守住同一条边界，不能从游戏目录外挑文件。
        const rel = cat === 'dll' ? baseName(p) : pathUnderRoot(p)
        if (!rel || !isUnderSourceRoot(p)) {
          rejected.push(p)
          continue
        }
        if (next.some(a => a.path === rel) || entries.some(e => e.path === rel)) {
          rejected.push(p)
          continue
        }
        const size = await fileSizeOrNull(p)
        if (size != null && size > maxZipSize) {
          oversized.push(p)
          continue
        }
        next.push({ path: rel, sourcePath: p, name: baseName(p), size })
        addedNow.push(rel)
      }
      setDraftAdds(next)
      invalidateBuilt()
      setSelectedPaths((prev) => {
        const set = new Set(prev)
        addedNow.forEach(p => set.add(p))
        return set
      })
      if (oversized.length) {
        const msg = t('workshop.modSelectedFileTooLarge', {
          max: maxZipSize / 1024 / 1024,
          files: previewPaths(oversized),
        })
        setWarning(rejected.length
          ? `${msg}；${t('workshop.patchAddRejected', { list: previewPaths(rejected) })}`
          : msg)
      } else if (rejected.length) {
        setWarning(t('workshop.patchAddRejected', { list: previewPaths(rejected) }))
      }
    } finally {
      setPicking(false)
    }
  }

  // 删除 / 撤销删除：只改前端集合，零后端调用、零延迟。
  // 删除只表示「不进入本次发布的新包」，不会移除订阅者机器上已有的文件。
  const handleToggleExclude = (entry) => {
    setError('')
    invalidateBuilt()
    const removing = !excludedPaths.has(entry.path)
    setExcludedPaths((prev) => {
      const next = new Set(prev)
      if (removing) next.add(entry.path)
      else next.delete(entry.path)
      return next
    })
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (removing) next.delete(entry.path)
      else if (effectiveStaged[entry.path]) next.add(entry.path)
      return next
    })
  }

  // 勾选 / 取消「用本地新内容更新」；取消勾选后打包会改用底包里的基线原样
  const handleToggleSelected = (entry) => {
    setError('')
    invalidateBuilt()
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
  }

  // 只构建待发布包（package.zip + manifest/file_hashes/size/hash），
  // 不上传、不写库；真正的发布由页面「保存」统一执行。
  // 草稿在这里一次性提交给后端（复制新增/替换文件、覆盖勾选/删除集合）。
  const handleBuild = async () => {
    setError('')
    setBuilding(true)
    try {
      // 与页面「保存」时的自动构建共用同一份 payload，避免两套草稿逻辑分叉
      const res = await buildModEditPackage({ workspace_id: workspaceId, user_id: userId, draft: draftPayload, category })
      // 后端返回构建后的完整视图：本地草稿清空、勾选/删除以后端为准
      if (res.workspace) applyData(res.workspace)
      else applyBuilt(workspaceId, res.built)
      const warnings = []
      const duplicates = res.duplicates || []
      if (duplicates.length) {
        warnings.push(t('workshop.patchAddDuplicateNotice', {
          count: duplicates.length,
          list: previewPaths(duplicates),
        }))
      }
      setWarning(warnings.join(' '))
    } catch (e) {
      setError(localizeError(t, e.message))
    } finally {
      setBuilding(false)
    }
  }

  const handleDiscard = () => {
    setError('')
    setDiscardOpen(true)
  }

  const confirmDiscard = async () => {
    setDiscardOpen(false)
    try {
      await discardModEditWorkspace({ workspace_id: workspaceId, user_id: userId })
      localStorage.removeItem(wsKey(userId, modId, lang))
      // 真放弃：草稿、dirty 标记、空清单标记与待发布包必须一起清掉。
      // 只清待发布包的话，父页面里残留的 draft 会在下一次「保存」时被自动重新构建，
      // 把已经放弃的替换/新增/排除重新打包发布出去。
      // -1 表示「该语言没有草稿」，父页面据此把三项标记全部清空。
      onDraftChange?.(lang, null, -1)
      // 工作区已删除：待发布包随之失效，必须同步清掉父页面的待保存状态
      applyBuilt(workspaceId, null)
      onClose?.()
    } catch (e) {
      // 删除失败时保留草稿指针与面板，避免用户以为草稿已清理
      setError(e.message)
    }
  }

  // 强制重扫：清掉后端已构建的补丁包与新增记忆，按本地目录全量重新比对。
  // 用于「构建之后又改了本地文件」：普通打开会保留待发布包而跳过重扫。
  const confirmRescan = async () => {
    setRescanOpen(false)
    setRescanning(true)
    setLoading(true)
    setError('')
    setNotice('')
    setWarning('')
    try {
      const res = await rescanModEditLocal({ workspace_id: workspaceId, user_id: userId })
      const info = res.auto || {}
      // 后端已清空旧 staged/added/built：本次不再恢复任何旧草稿，直接按新扫描结果。
      applyData(res, null)
      // 来源校验失败时后端会以 auto.mode='error' 返回（并非异常），必须把真实
      // 原因留下来；不能只处理 import 分支后无条件清空 sourceError。
      if (info.mode === 'error') {
        setSourceError(localizeSourceError(info))
        setSourceErrorCode(info.error_code || '')
      } else {
        setSourceError('')
        setSourceErrorCode('')
      }
      if (info.mode === 'import') {
        setNotice(t('workshop.patchAutoApplied', {
          count: Number(info.applied) || 0,
        }))
      }
      if (info.skipped?.length) {
        setWarning(t('workshop.patchAutoSkipped', {
          count: info.skipped.length,
          list: previewPaths(info.skipped),
        }))
      }
    } catch (e) {
      // 后端预校验失败（游戏路径/来源根不可用）会直接返回 Err，原样展示原因
      setError(localizeError(t, e?.message || String(e)))
    } finally {
      setRescanning(false)
      setLoading(false)
    }
  }

  return (
    <>
    <div className={styles.inline}>
      <div className={styles.inlineHeader}>
        <Text weight="semibold" size="small">
          {t('workshop.patchTitle', { lang: LANG_LABELS[lang] || lang })}
        </Text>
        <Button
          size="small"
          appearance="secondary"
          disabled={building}
          onClick={onClose}
        >
          {t('workshop.patchCollapse')}
        </Button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <Text className={styles.hint}>{t('workshop.patchHint')}</Text>

              {loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 0' }}>
                  <Spinner size="small" />
                  <Text className={styles.meta}>{t('workshop.patchLoading')}</Text>
                </div>
              )}

              {error && <Text className={styles.error}>{error}</Text>}

              {notice && <NoticeBar tone="success"><Text size="small">{notice}</Text></NoticeBar>}

              {warning && (
                <div className={styles.built} style={{ color: tokens.colorStatusWarningForeground1 }}>
                  <Text size="small">{warning}</Text>
                </div>
              )}

              {!loading && base && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <Badge appearance="outline">v{base.version}</Badge>
                    <Text className={styles.meta}>
                      {t('workshop.patchFileCount', { count: entries.length })} · {formatSize(base.file_size)}
                    </Text>
                    {stagedCount > 0 && (
                      <Badge appearance="tint" color="brand" size="large">
                        {t('workshop.patchSelectedCount', { count: selectedCount, total: stagedCount })}
                      </Badge>
                    )}
                    {excludedCount > 0 && (
                      <Badge appearance="outline" color="warning">
                        {t('workshop.patchExcludedCount', { count: excludedCount })}
                      </Badge>
                    )}
                  </div>

                  {/* 来源唯一确定：直接按程序配置的游戏路径 + category 读取。
                      不再提供「选择来源 / 选择目录」入口。 */}
                  {/* 解析到的绝对根路径：作者一眼确认读的是游戏根 / CustomMissions / ... */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    {/* 来源可能因重扫失败/扫描无结果被清空，但重扫入口必须保留 */}
                    {localSource && (
                      <Text
                        className={styles.hint}
                        style={{ wordBreak: 'break-all', flex: 1, minWidth: 0 }}
                      >
                        {t('workshop.patchSourceRoot', {
                          kind: rootKindLabel(localSource.root_kind),
                          path: localSource.root_path,
                        })}
                      </Text>
                    )}
                    {/* 构建后又改了本地文件：普通打开会保留待发布包而跳过重扫，
                        这里给一个明确入口（确认后作废已构建的包） */}
                    <Button
                      size="small"
                      appearance="secondary"
                      style={localSource ? undefined : { marginLeft: 'auto' }}
                      disabled={building || loading || rescanning}
                      onClick={() => setRescanOpen(true)}
                    >
                      {rescanning ? t('workshop.patchRescanning') : t('workshop.patchRescan')}
                    </Button>
                  </div>

                  {sourceError && (
                    <>
                      <Text
                        className={styles.error}
                        style={{ wordBreak: 'break-all', marginTop: '2px' }}
                      >
                        {sourceError}
                      </Text>
                      {(sourceErrorCode === 'GAME_PATH_MISSING'
                        || sourceErrorCode === 'GAME_PATH_INVALID') && (
                        <Button
                          size="small"
                          appearance="secondary"
                          onClick={openSettings}
                        >
                          {t('workshop.patchGoSettings')}
                        </Button>
                      )}
                    </>
                  )}

                  {/* 明确告知比对基准：有逐文件指纹才按 hash 精确比对；缺失时按存在性保守处理 */}
                  {base && (
                    <Text
                      className={styles.hint}
                      style={base.file_hash_count > 0 ? undefined : { color: tokens.colorStatusWarningForeground1 }}
                    >
                      {base.file_hash_count > 0
                        ? t('workshop.patchHashBaseline', { count: base.file_hash_count })
                        : t('workshop.patchHashBaselineMissing')}
                    </Text>
                  )}

                  {localSource && importSummary && (
                    <div className={styles.built}>
                      <Text block>
                        {t('workshop.patchImportSummary', {
                          changed: importSummary.changed,
                          unchanged: importSummary.unchanged,
                        })}
                      </Text>
                      {/* 实际根与按类别期望的根不一致时，把期望层也指出来 */}
                      {importSummary.expected_root
                        && importSummary.expected_root !== (importSummary.root_path || localSource.root_path) && (
                        <Text block className={styles.meta} style={{ marginTop: '2px', wordBreak: 'break-all' }}>
                          {t('workshop.patchExpectedRoot', { path: importSummary.expected_root })}
                        </Text>
                      )}
                      {missingOpen.length > 0 && (
                        <Text block className={styles.meta} style={{ marginTop: '4px', wordBreak: 'break-all' }}>
                          {t('workshop.patchImportMissingKept', {
                            count: missingOpen.length,
                            list: previewPaths(missingOpen),
                          })}
                        </Text>
                      )}
                      {importSummary.ambiguous_details?.length > 0 && (
                        <Text
                          block
                          className={styles.meta}
                          style={{
                            marginTop: '4px',
                            wordBreak: 'break-all',
                            color: tokens.colorStatusWarningForeground1,
                          }}
                        >
                          {t('workshop.patchImportAmbiguous', {
                            count: importSummary.ambiguous_details.length,
                            list: previewPaths(importSummary.ambiguous_details),
                          })}
                        </Text>
                      )}
                      {importSummary.extra?.length > 0 && (
                        <Text block className={styles.meta} style={{ marginTop: '4px', wordBreak: 'break-all' }}>
                          {t('workshop.patchImportExtra', {
                            count: importSummary.extra.length,
                            list: previewPaths(importSummary.extra),
                          })}
                        </Text>
                      )}
                      {importSummary.baseline_unverified && (
                        <Text block className={styles.meta} style={{ marginTop: '4px' }}>
                          {t('workshop.patchImportBaselineUnverified')}
                        </Text>
                      )}
                      {importSummary.nested_zip_unverified > 0 && (
                        <Text block className={styles.meta} style={{ marginTop: '4px' }}>
                          {t('workshop.patchImportNested', { count: importSummary.nested_zip_unverified })}
                        </Text>
                      )}
                      {importSummary.file_hash_budget_exceeded && (
                        <Text block className={styles.meta} style={{ marginTop: '4px' }}>
                          {t('workshop.patchImportBudget')}
                        </Text>
                      )}
                    </div>
                  )}

                  {/* 新增文件：只记在本次草稿里，构建时才复制进包 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <Text className={styles.meta}>{t('workshop.patchAddLabel')}</Text>
                    <Button
                      size="small"
                      appearance="secondary"
                      disabled={building || picking || !workspaceId || !sourceRootPath}
                      onClick={handleAddFiles}
                    >
                      {picking ? t('workshop.patchAdding') : t('workshop.patchAddFiles')}
                    </Button>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <Text className={styles.meta}>{t('workshop.patchVersionLabel')}</Text>
                    <Input
                      size="small"
                      value={version}
                      disabled={building}
                      onChange={(_, d) => onVersionChange?.(d.value)}
                      placeholder={base.version}
                      maxLength={64}
                      style={{ width: '150px' }}
                    />
                    <Text
                      className={styles.hint}
                      style={versionInvalid ? { color: tokens.colorStatusDangerForeground1 } : undefined}
                    >
                      {versionInvalid
                        ? t('workshop.patchVersionInvalid')
                        : t('workshop.patchVersionHint', { version: base.version })}
                    </Text>
                  </div>

                  <Input
                    size="small"
                    value={filter}
                    onChange={(_, d) => setFilter(d.value)}
                    placeholder={t('workshop.patchFileFilter')}
                  />

                  <Text className={styles.hint}>{t('workshop.patchSelectionHint')}</Text>
                  {unselectedChangedCount > 0 && (
                    <Text
                      className={styles.hint}
                      style={{ color: tokens.colorStatusWarningForeground1 }}
                    >
                      {t('workshop.patchUnselectedNeedsBase', { count: unselectedChangedCount })}
                    </Text>
                  )}

                  <div className={styles.list}>
                    {filtered.length === 0 && (
                      <Text className={styles.meta} style={{ padding: '12px' }}>{t('workshop.patchNoMatch')}</Text>
                    )}
                    {filtered.slice(0, renderLimit).map(entry => {
                      const st = effectiveStaged[entry.path]
                      const removed = excluded.has(entry.path)
                      const isSelected = selected.has(entry.path)
                      const isMissing = keepOriginalSet.has(entry.path)
                      const isAdded = added.has(entry.path)
                      return (
                        <div key={`${entry.index}-${entry.path}`} className={styles.row}>
                          {st ? (
                            <Checkbox
                              checked={isSelected}
                              disabled={removed || building}
                              onChange={() => handleToggleSelected(entry)}
                              title={removed ? t('workshop.patchExcludedActionHint') : t('workshop.patchSelectToggle')}
                            />
                          ) : (
                            <span style={{ width: '22px', flexShrink: 0 }} aria-hidden />
                          )}
                          <div className={styles.rowMain}>
                            <div className={styles.rowLine}>
                              <Text
                                className={styles.path}
                                title={entry.path}
                                // 删除后该行仍保留在列表里，用删除线 + 置灰让作者看得见删了什么
                                style={removed
                                  ? {
                                      textDecoration: 'line-through',
                                      color: tokens.colorNeutralForeground3,
                                    }
                                  : undefined}
                              >
                                {entry.path}
                              </Text>
                              {isAdded && (
                                <Badge appearance="tint" color="brand">
                                  {t('workshop.patchAddedBadge')}
                                </Badge>
                              )}
                              {isMissing && (
                                <Badge appearance="outline">
                                  {t('workshop.patchRowKeepOriginal')}
                                </Badge>
                              )}
                              {removed && (
                                <Badge appearance="outline" color="warning">
                                  {t('workshop.patchExcludedBadge')}
                                </Badge>
                              )}
                              {st && !removed && (
                                isSelected ? (
                                  <Badge appearance="outline" color="brand">
                                    {t('workshop.patchRowChangedSelected')}
                                  </Badge>
                                ) : (
                                  <Badge appearance="outline" color="warning">
                                    {t('workshop.patchRowChangedUnselected')}
                                  </Badge>
                                )
                              )}
                              {!st && !isMissing && !removed && (
                                <Badge appearance="outline">{t('workshop.patchRowUnchanged')}</Badge>
                              )}
                              <Text className={styles.meta}>{formatSize(st ? st.size : entry.size)}</Text>
                            </div>
                            {/* 替换来源不再挤在行右侧，下沉到文件名下方并弱化 */}
                            {st && !removed && (
                              <Text className={styles.stagedFrom} title={st.source_name}>
                                {t('workshop.patchStagedFrom', { name: st.source_name })}
                              </Text>
                            )}
                          </div>
                          {st && !removed && (
                            <Button
                              size="small"
                              appearance="secondary"
                              disabled={building}
                              onClick={() => handleUndo(entry)}
                            >
                              {t('workshop.patchUndo')}
                            </Button>
                          )}
                          {!st && !removed && !isAdded && (
                            // 替换单个文件：只记录到本次草稿，构建时才提交；
                            // 文件必须来自游戏目录。
                            <Button
                              size="small"
                              appearance="secondary"
                              disabled={building || picking}
                              onClick={() => handleReplace(entry)}
                            >
                              {t('workshop.patchReplace')}
                            </Button>
                          )}
                          {/* 任意条目（原始或新增）都只有一个统一的「删除 / 撤销」入口 */}
                          <Button
                            size="small"
                            appearance="secondary"
                            className={removed ? undefined : styles.dangerButton}
                            disabled={building}
                            onClick={() => handleToggleExclude(entry)}
                          >
                            {removed ? t('workshop.patchExcludeUndo') : t('workshop.patchExclude')}
                          </Button>
                        </div>
                      )
                    })}
                    {filtered.length > renderLimit && (
                      <Button
                        size="small"
                        appearance="secondary"
                        style={{ margin: '8px auto 4px', display: 'block' }}
                        onClick={() => setRenderLimit(l => l + RENDER_CHUNK)}
                      >
                        {t('workshop.patchShowMore', { shown: renderLimit, total: filtered.length })}
                      </Button>
                    )}
                  </div>

                  {excludedCount > 0 && (
                    <Text className={styles.hint}>{t('workshop.patchExcludeNotice')}</Text>
                  )}

                  {built && (
                    <div className={styles.built}>
                      <Text block>
                        {t('workshop.patchBuiltSummary', {
                          count: entries.filter(e => !excluded.has(e.path)).length,
                          size: formatSize(built.file_size),
                          replaced: built.replaced,
                          added: built.added || 0,
                        })}
                      </Text>
                      <Text block className={styles.meta} style={{ marginTop: '4px' }}>
                        {built.changed
                          ? t('workshop.patchChangedHint', { version: base.version })
                          : t('workshop.patchUnchangedHint')}
                      </Text>
                      <Text block className={styles.meta} style={{ marginTop: '4px' }}>
                        {t('workshop.patchBuiltPendingSave')}
                      </Text>
                    </div>
                  )}

                  {!building && buildBlocked && (
                    <div className={styles.built} style={{ border: `1px solid ${tokens.colorStatusWarningForeground1}` }}>
                      <Text
                        block
                        className={styles.hint}
                        style={{ color: tokens.colorStatusWarningForeground1 }}
                      >
                        {buildBlocked.text}
                      </Text>
                      {buildBlocked.hint && (
                        <Text block className={styles.meta} style={{ marginTop: '4px' }}>
                          {buildBlocked.hint}
                        </Text>
                      )}
                    </div>
                  )}

                  <div className={styles.footer}>
                    <Button
                      size="small"
                      appearance="secondary"
                      className={styles.dangerButton}
                      disabled={building}
                      onClick={handleDiscard}
                      style={{ marginRight: 'auto' }}
                    >
                      {t('workshop.patchDiscard')}
                    </Button>
                    <Button size="small" appearance="secondary" disabled={!!buildBlocked || building} onClick={handleBuild}>
                      {building ? t('workshop.patchBuilding') : t('workshop.patchBuild')}
                    </Button>
                    <Button size="small" disabled={building} onClick={onClose}>{t('workshop.patchCollapse')}</Button>
                  </div>
                </>
              )}

              {!loading && !base && !error && (
                <>
                  {sourceError ? (
                    <>
                      <Text className={styles.error} style={{ wordBreak: 'break-all' }}>
                        {sourceError}
                      </Text>
                      {(sourceErrorCode === 'GAME_PATH_MISSING'
                        || sourceErrorCode === 'GAME_PATH_INVALID') && (
                        <Button size="small" appearance="secondary" onClick={openSettings}>
                          {t('workshop.patchGoSettings')}
                        </Button>
                      )}
                    </>
                  ) : (
                    <Text className={styles.meta}>{t('workshop.patchEntriesEmpty')}</Text>
                  )}
                </>
              )}
      </div>
    </div>

    <ConfirmDialog
      open={discardOpen}
      onClose={() => setDiscardOpen(false)}
      title={t('workshop.patchDiscardTitle')}
      confirmText={t('workshop.patchDiscard')}
      onConfirm={confirmDiscard}
    >
      <Text>{t('workshop.patchDiscardConfirm')}</Text>
    </ConfirmDialog>

    <ConfirmDialog
      open={rescanOpen}
      onClose={() => setRescanOpen(false)}
      title={t('workshop.patchRescanTitle')}
      confirmText={t('workshop.patchRescan')}
      onConfirm={confirmRescan}
    >
      <Text>{t('workshop.patchRescanConfirm')}</Text>
    </ConfirmDialog>
    </>
  )
}
