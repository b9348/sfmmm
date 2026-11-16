import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { tokens, Text, Button, Card } from '@fluentui/react-components'
import { FolderOpen24Regular, ArrowClockwise24Regular, ChevronRight24Regular, Play24Regular, Pause24Regular } from '@fluentui/react-icons'
import { invoke } from '@tauri-apps/api/core'
import { useInstalledMods } from '../../hooks/useInstalledMods'
import { usePersistedNumber } from '../../hooks/usePersistedNumber'
import { useUserNav } from '../../contexts/useUserNav'
import { getModDetail } from '../../services/workshopApi'
import { installMod, checkModOverwrite } from '../../services/installMod'
import { localizeError } from '../../utils/localizeError'
import { useOverwriteConfirm } from '../../contexts/useOverwriteConfirm'
import { AsyncView, EmptyState, PrereqTable, ItemsPerRowControl } from '../../components'
import { NoticeBar } from '../../components/common/NoticeBar'
import { useMissionStyles } from './missionStyles'
import { FolderCard, FileCard, ModGroupCard } from './MissionFolderCards'
import { clearEntryCache, listFiles, getWorkshopKey, categoryFromSubfolder, openInExplorer } from './missionFs'

export function MissionFolder({ config, subfolder, onUninstall, focusModKey }) {
  const styles = useMissionStyles()
  const { t, i18n } = useTranslation()
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh')
  const gamePath = config?.game_path?.replace(/\\/g, '/') || ''
  const rootDir = gamePath ? `${gamePath}/${subfolder}` : ''
  const [currentDir, setCurrentDir] = useState(rootDir)
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const { installed, updates, modDetails, cloudInfo } = useInstalledMods()
  // 当前选中的条目集合（支持 Ctrl/Shift 多选，高亮提示用户）；仅在本页/本目录内生效
  const [selectedPaths, setSelectedPaths] = useState(() => new Set())
  // 每行展示数量：与创意工坊共用 workshop_items_per_row 配置键（1-10 持久化），复用同一「每行 X 个」控件
  const [itemsPerRow, handleItemsPerRowChange] = usePersistedNumber('workshop_items_per_row', { defaultValue: 3, logTag: 'MissionFolder' })
  const anchorRef = useRef(null) // Shift 范围选择的锚点
  // 更新前预检发现新包含嵌套 zip：残留明细无法判断，改为页内提示（不进确认框）
  const [nestedZipHint, setNestedZipHint] = useState(false)
  const orderedPaths = files.map(f => `${currentDir}/${f.name}`)

  // Windows 风格选择：plain=单选；Ctrl=切换；Shift=以锚点起算的范围；Ctrl+Shift=范围并入
  const handleItemSelect = (fullPath, e) => {
    const evt = e || {}
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (evt.shiftKey && anchorRef.current) {
        const startIdx = orderedPaths.indexOf(anchorRef.current)
        const endIdx = orderedPaths.indexOf(fullPath)
        if (startIdx !== -1 && endIdx !== -1) {
          const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
          if (!evt.ctrlKey) next.clear()
          for (let k = lo; k <= hi; k++) next.add(orderedPaths[k])
          return next
        }
      }
      if (evt.ctrlKey) {
        if (next.has(fullPath)) next.delete(fullPath)
        else next.add(fullPath)
      } else {
        next.clear()
        next.add(fullPath)
      }
      return next
    })
    if (!evt.shiftKey) anchorRef.current = fullPath
  }

  // 点击「打开所在目录」图标：
  //   - 多选（点击项属于一个 >1 的选择集）→ 打开父目录 currentDir 并高亮【所有选中项】
  //     （文件夹与文件一并高亮），使资源管理器的高亮与 UI 多选严格一致；不钻入文件夹，
  //     否则兄弟选中项在父目录里不可见、无法高亮。
  //   - 单选 → 把被点的完整路径 fullPath 交给 Rust 的 open_folder，由 Rust 按真实类型
  //     （std::fs::is_dir，跟随符号链接/目录交接点 junction，可靠）裁决：目录则直接打开
  //     （钻入），文件则打开其父目录并高亮该文件。**前端不再自行判定目录/文件**，从根上
  //     避免 junction 被 readDir/stat 误判为文件而错误打开上层父目录。
  const handleOpenLocation = useCallback((fullPath) => {
    const isMultiSelect = selectedPaths.size > 1 && selectedPaths.has(fullPath)
    if (isMultiSelect) {
      let selectedNames = files
        .filter(f => selectedPaths.has(`${currentDir}/${f.name}`))
        .map(f => f.name)
      if (selectedNames.length === 0) {
        // 兜底：过滤未命中（如 files 快照过期）时至少高亮被点击项本身，
        // 避免空 items 掉回单文件回退分支（junction 目录会再被 is_dir 误判而打开游戏根）。
        selectedNames = [fullPath.split(/[/\\]/).pop()]
      }
      // 多选：打开父目录并高亮全部选中项（文件夹+文件），与 UI 选择保持一致
      openInExplorer(currentDir, selectedNames)
    } else {
      // 单点：交给你 Rust 裁决（目录钻入 / 文件开父目录+高亮）
      openInExplorer(fullPath, [])
    }
    setSelectedPaths(prev => {
      const next = new Set(prev)
      next.add(fullPath)
      return next
    })
  }, [files, currentDir, selectedPaths])

  // 切换目录时清空选择，确保多选仅在本页/本目录内生效
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedPaths(new Set())
    anchorRef.current = null
  }, [currentDir])

  // 检查文件/文件夹是否是已安装的工坊模组
  // 解析出对应的创意工坊 mod_key：
  // 1) 名称直接等于 mod_key（dll / 多数 v1 顶层文件夹）
  // 2) v1 部署后顶层文件夹名可能等于某已安装 mod 的 manifest 首段
  const resolveModKey = useCallback((name) => {
    const key = getWorkshopKey(name)
    if (installed.has(key)) return key
    for (const [mk, d] of modDetails) {
      if (!d.manifest) continue
      try {
        const paths = JSON.parse(d.manifest)
        // manifest 首段与成员文件名用同一套归一化（getWorkshopKey）：旧记录首段
        // "xxx.zip"、v2 任务脚本 "actions.code" 去扩展名后才能与文件名对上
        if (paths.some(p => getWorkshopKey(String(p).split('/')[0]) === key)) return mk
      } catch { /* 忽略损坏的 manifest */ }
    }
    return null
  }, [installed, modDetails])
  const isWorkshopMod = (name) => resolveModKey(name) !== null
  const hasUpdate = (name) => { const k = resolveModKey(name); return k ? updates.has(k) : false }
  const getWorkshopDetail = (name) => { const k = resolveModKey(name); return k ? modDetails.get(k) : null }
  const getCloudInfo = (name) => { const k = resolveModKey(name); return k ? cloudInfo.get(k) : null }

  const { openMod } = useUserNav()
  const overwriteConfirm = useOverwriteConfirm()

  // 前往创意工坊查看该 mod 详情页（按 mod_key 跳转）
  const handleViewDetail = useCallback((modKey) => {
    if (!modKey) return
    openMod(modKey)
  }, [openMod])

  const loadFiles = useCallback(async () => {
    if (!currentDir) return
    try {
      const list = await listFiles(currentDir)
      setFiles(list)
    } finally {
      setLoading(false)
    }
  }, [currentDir])

  useEffect(() => {
    if (currentDir) {
      loadFiles()
    }
  }, [currentDir, loadFiles])

  // 外部跳转定位（订阅记录「在本地模组中查看」）：按 focusModKey 选中对应 item，
  // 滚动到视口并临时高亮——与 CommentSection 滚动到评论同模式：
  // 等待数据就绪后按文件名归一化/mod_key 匹配，重试等待 DOM 渲染完成再做 scrollIntoView + 背景色闪亮。
  const focusTimerRef = useRef(null)
  useEffect(() => {
    if (!focusModKey || loading || files.length === 0) return
    // 匹配当前目录中的条目：resolveModKey 归一化命中，或文件名直接等于 mod_key
    const target = files.find(f => {
      const k = resolveModKey(f.name)
      return k === focusModKey || getWorkshopKey(f.name) === focusModKey
    })
    if (!target) return
    const fullPath = `${currentDir}/${target.name}`
    // 单选语义：清空后加入选中集，锚点同步（与 handleItemSelect 行为一致）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedPaths(new Set([fullPath]))
    anchorRef.current = fullPath
    const domId = `mission-item-${encodeURIComponent(fullPath)}`
    const tryScroll = (retries = 8) => {
      const el = document.getElementById(domId)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.style.transition = 'background-color 1s ease'
        el.style.backgroundColor = tokens.colorBrandBackground2Hover
        setTimeout(() => { el.style.backgroundColor = '' }, 2000)
      } else if (retries > 0) {
        focusTimerRef.current = setTimeout(() => tryScroll(retries - 1), 300)
      }
    }
    tryScroll()
    return () => { if (focusTimerRef.current) clearTimeout(focusTimerRef.current) }
  }, [focusModKey, loading, files, currentDir, resolveModKey])

  // BepInEx 前置安装完成后：清空目录缓存并刷新文件列表
  const onPrereqInstalled = useCallback(() => {
    clearEntryCache()
    loadFiles()
  }, [loadFiles])

  // 前置检测表格：模组 / v1 / v2 三页共用同一组件，并展示统一的前置全集
  // （不随 tab 变化）：BepInEx 加载器、v1/v2 任务前置、中文字体（仅中文）、去马赛克补丁。
  const prereqItems = useMemo(() => {
    const items = [{ key: 'bepinex' }, { key: 'v1' }, { key: 'v2' }]
    if (isZh) items.push({ key: 'font' })
    items.push({ key: 'rmmosaic' })
    return items
  }, [isZh])

  const navigateTo = useCallback((targetDir) => {
    clearEntryCache()
    setCurrentDir(targetDir)
  }, [])

  const navigateBreadcrumb = useCallback((targetDir) => {
    clearEntryCache()
    setCurrentDir(targetDir)
  }, [])

  // Build breadcrumb segments: 以 rootDir 为根（模组页根为 plugins，隐藏 BepInEx 层），
  // 其余页面根为 CustomMissions / CustomMissions2，保持原有表现。
  const breadcrumbSegments = []
  if (currentDir && currentDir.startsWith(rootDir)) {
    const rootName = rootDir.split('/').pop()
    const rel = currentDir.slice(rootDir.length).replace(/^\//, '')
    const rest = rel ? rel.split('/') : []
    const all = [rootName, ...rest]
    for (let i = 0; i < all.length; i++) {
      const sub = i === 0 ? '' : rest.slice(0, i).join('/')
      const targetPath = sub ? `${rootDir}/${sub}` : rootDir
      breadcrumbSegments.push({
        label: all[i],
        targetPath,
        isLast: i === all.length - 1,
      })
    }
  }

  // Refresh a folder (re-cache and reload)
  const refresh = useCallback(() => {
    clearEntryCache()
    loadFiles()
  }, [loadFiles])

  // 就地更新：拉取云端最新文件后复用 installMod 重新安装
  const handleUpdate = useCallback(async (modKey) => {
    if (!modKey) return
    const langCode = (modDetails.get(modKey)?.langCode) || 'zh'
    try {
      // 路径合法性统一由 installMod 拦截（所有安装入口都走该函数），这里不再重复检测。
      const { data } = await getModDetail(modKey, langCode, null, null, modKey)
      const mod = data?.data?.mod || data?.mod
      const files = mod?.files || []
      const file = files.find(f => f.lang_code === langCode) || files[0]
      if (!file) {
        alert(t('mods.updateNoFile'))
        return
      }
      const category = mod.category || categoryFromSubfolder(subfolder)
      // 下载前零流量预检：覆盖其他 mod / 本机已有文件、本地残留、或清单含非法路径
      // （拒绝式弹窗）时提示；嵌套 zip 只做页内提示，不进确认框。
      // 用户取消则不下载、不落任何文件；预检本身失败只提示、不阻断安装。
      let overwriteCheck = null
      setNestedZipHint(false)
      try {
        overwriteCheck = await checkModOverwrite({
          modKey,
          category,
          manifest: file.manifest,
          langCode: file.lang_code,
        })
      } catch (checkError) {
        console.warn('[handleUpdate] 覆盖预检失败，跳过提示直接安装:', checkError)
      }
      // 嵌套 zip 无法在下载前展开：旧清单里未被新清单覆盖的条目归入
      // staleUnknown（后端不把它们放进 staleFiles），这里做页内提示，
      // 且不因此弹残留确认框。
      const hasOverwritePrompt =
        !!overwriteCheck?.conflicts?.length
        || !!overwriteCheck?.staleFiles?.length
        || !!overwriteCheck?.invalidPaths?.length
      // 有实际覆盖 / 残留 / 非法路径时由弹窗统一展示，页内提示让位，避免两种提示同时出现
      setNestedZipHint(!!(overwriteCheck?.hasNestedZip || overwriteCheck?.staleUnknown) && !hasOverwritePrompt)
      // 仅在有实际覆盖 / 本地残留 / 清单非法路径时弹确认框；清单含非法路径时
      // 弹窗为拒绝式，确认按钮不存在，用户只能关闭（不安装）。
      if (hasOverwritePrompt) {
        const confirmed = overwriteConfirm ? await overwriteConfirm.confirmOverwrite(overwriteCheck) : true
        if (!confirmed) return
      }
      await installMod({
        modKey,
        category,
        fileUrl: file.file_url,
        version: file.version,
        fileHash: file.file_hash,
        langCode: file.lang_code,
        manifest: file.manifest,
        displayName: mod.display_name,
        description: mod.description,
        translations: mod.translations,
        // 用户主动点"更新"，要求覆盖现有安装：跳过后端去重（去重只看文件是否存在，
        // 无法发现内容被改坏），否则云端文件已变但本地同名文件还在时会被拦成空操作
        force: true,
      })
      // 安装已入队：嵌套提示立即复位，避免页面上长期残留
      setNestedZipHint(false)
      refresh()
    } catch (e) {
      setNestedZipHint(false)
      alert(t('mods.updateFailed', { msg: localizeError(t, e?.message || String(e)) }))
    }
  }, [modDetails, subfolder, t, refresh, overwriteConfirm])

  const toggleItemEnabled = useCallback(async (filePath) => {
    try {
      const [newIsBanned, newPath] = await invoke('toggle_mod_enabled', { path: filePath.replace(/\//g, '\\') })
      // 更新文件列表中的状态
      setFiles(prev => prev.map(f => {
        const fullPath = `${currentDir}/${f.name}`
        if (filePath === fullPath) {
          // 重命名后文件名变了，从新路径中提取文件名
          const newName = newPath.split(/[/\\]/).pop()
          return { ...f, name: newName, isBanned: newIsBanned }
        }
        return f
      }))
    } catch (e) {
      console.error('Failed to toggle item:', e)
    }
  }, [currentDir, setFiles])

  const handleBatchToggle = useCallback(async (ban) => {
    if (!currentDir) return
    setLoading(true)
    try {
      await invoke('batch_toggle_mod_enabled', { dir: currentDir.replace(/\//g, '\\'), ban })
      await loadFiles()
    } catch (e) {
      console.error('Failed to batch toggle:', e)
    } finally {
      setLoading(false)
    }
  }, [currentDir, loadFiles, setLoading])

  // 按 mod_key 把当前目录文件索引成 Map（O(1) 取组），供组级「暂停/继续」共用，
  // 避免每次操作都对 files 全表扫描一遍（filesByKey 依赖 resolveModKey，已用 useCallback 稳定化）
  const filesByKey = useMemo(() => {
    const map = new Map()
    for (const f of files) {
      const k = resolveModKey(f.name)
      if (!k) continue
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(f)
    }
    return map
  }, [files, resolveModKey])

  // 组级「暂停/继续」共用逻辑：
  //   ban=true  → 只把组内【未禁用】的文件禁用（已禁用的跳过）
  //   ban=false → 只把组内【已禁用】的文件恢复（未禁用的跳过）
  // 因此两个按钮始终同时显示，即使组内混有用户手动暂停的文件也各自幂等、不会误操作。
  // 与 toggleItemEnabled 相同，只就地更新 files 状态而不重新扫描目录，
  // 配合 getWorkshopKey 对 [ban] 标记的归一化，改名后文件仍留在所属分组容器内。
  const handleGroupToggleAll = useCallback(async (modKey, ban) => {
    if (!currentDir) return
    const targets = (filesByKey.get(modKey) || [])
      .filter(f => !f.isDir && (ban ? !f.isBanned : f.isBanned))
    if (targets.length === 0) return
    const results = await Promise.allSettled(
      targets.map(f => invoke('toggle_mod_enabled', { path: `${currentDir}/${f.name}`.replace(/\//g, '\\') }))
    )
    const renamed = new Map() // 旧完整路径 -> 新文件名
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const newPath = r.value[1]
        renamed.set(`${currentDir}/${targets[i].name}`, newPath.split(/[/\\]/).pop())
      } else {
        console.error(`Failed to ${ban ? 'disable' : 'enable'} group member:`, r.reason)
      }
    })
    if (renamed.size === 0) return
    setFiles(prev => prev.map(f => {
      const fullPath = `${currentDir}/${f.name}`
      const newName = renamed.get(fullPath)
      return newName ? { ...f, name: newName, isBanned: ban } : f
    }))
  }, [currentDir, filesByKey, setFiles])

  const handleGroupDisableAll = useCallback((modKey) => handleGroupToggleAll(modKey, true), [handleGroupToggleAll])
  const handleGroupEnableAll = useCallback((modKey) => handleGroupToggleAll(modKey, false), [handleGroupToggleAll])

  return (
    <div className={styles.root}>
      <Card className={styles.toolbarCard}>
        <div className={styles.toolbarRow}>
          {/* Breadcrumb navigation */}
          <div className={styles.breadcrumbRow}>
            {breadcrumbSegments.map((seg, idx) => (
              <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
                {idx > 0 && (
                  <span className={styles.breadcrumbChevron}>
                    <ChevronRight24Regular style={{ fontSize: '10px', verticalAlign: 'middle' }} />
                  </span>
                )}
                <Button
                  size="small"
                  appearance="subtle"
                  className={seg.isLast ? styles.breadcrumbBtnActive : styles.breadcrumbBtn}
                  onClick={() => navigateBreadcrumb(seg.targetPath)}
                  title={seg.targetPath}
                  disabled={seg.isLast}
                >
                  {seg.label}
                </Button>
              </span>
            ))}
          </div>

          <Button size="small" icon={<FolderOpen24Regular />} appearance="subtle" onClick={() => openInExplorer(currentDir)} disabled={!currentDir} />
          <Button size="small" icon={<ArrowClockwise24Regular />} appearance="subtle" onClick={refresh} disabled={!currentDir || loading} />
          <Button size="small" icon={<Pause24Regular />} appearance="subtle" onClick={() => handleBatchToggle(true)} disabled={!currentDir || loading} title={t('mods.disableAll')} />
          <Button size="small" icon={<Play24Regular />} appearance="subtle" onClick={() => handleBatchToggle(false)} disabled={!currentDir || loading} title={t('mods.enableAll')} />
          <ItemsPerRowControl value={itemsPerRow} onChange={handleItemsPerRowChange} disabled={!currentDir || loading} />
        </div>

        <Text size="small" className={styles.pathText} title={currentDir}>
          {currentDir || t('mission.notConfigured')}
        </Text>
      </Card>

      {nestedZipHint && (
        <NoticeBar>
          <Text size="small">{t('workshop.overwriteNestedZip')}</Text>
        </NoticeBar>
      )}

      {currentDir && categoryFromSubfolder(subfolder) !== 'dll' && (
        <Text size="small" className={styles.meta} style={{ padding: '0 4px' }}>
          {t('mission.reloadTaskHint')}
        </Text>
      )}

      {/* 前置检测表格：模组 / v1 / v2 三页共用同一组件，且展示统一的前置全集 */}
      <PrereqTable
        gamePath={gamePath}
        items={prereqItems}
        onInstalled={onPrereqInstalled}
      />

      <AsyncView loading={loading} loadingLabel={t('app.loading')}>
        {files.length === 0 && (
          <EmptyState
            title={currentDir ? t('mission.folderEmpty') : t('mission.noGameDir')}
            description={currentDir ? t('mission.noFilesInDir') : undefined}
          />
        )}

      {files.length > 0 && (() => {
        // 统计每个 mod_key 的成员数：同一创意工坊订阅（同 mod_key）出现 >= 2 个条目时归为一组
        const keyCount = new Map()
        for (const f of files) {
          const k = resolveModKey(f.name)
          if (k) keyCount.set(k, (keyCount.get(k) || 0) + 1)
        }
        const renderedGroups = new Set()

        const renderItem = (f, i, inGroup) => {
          const fullPath = `${currentDir}/${f.name}`
          const detail = getWorkshopDetail(f.name)
          const ci = getCloudInfo(f.name)
          const mk = resolveModKey(f.name)
          return f.isDir
            ? <FolderCard key={i} name={f.name} fullPath={fullPath} onNavigate={navigateTo} isWorkshop={isWorkshopMod(f.name)} workshopDetail={detail} cloudInfo={ci} onUninstall={onUninstall} hasUpdate={hasUpdate(f.name)} modKey={mk} onViewDetail={handleViewDetail} onUpdate={handleUpdate} inGroup={inGroup} selected={selectedPaths.has(fullPath)} onSelect={handleItemSelect} onOpenLocation={handleOpenLocation} />
            : <FileCard key={i} name={f.name} fullPath={fullPath} isBanned={f.isBanned} onToggle={toggleItemEnabled} isWorkshop={isWorkshopMod(f.name)} hasUpdate={hasUpdate(f.name)} workshopDetail={detail} cloudInfo={ci} onUninstall={onUninstall} modKey={mk} onViewDetail={handleViewDetail} onUpdate={handleUpdate} inGroup={inGroup} selected={selectedPaths.has(fullPath)} onSelect={handleItemSelect} onOpenLocation={handleOpenLocation} />
        }

        return (
          <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${itemsPerRow}, minmax(0, 1fr))` }}>
            {files.map((f, i) => {
              const mk = resolveModKey(f.name)
              const grouped = mk && (keyCount.get(mk) || 0) >= 2
              if (!grouped) return renderItem(f, i, false)
              // 分组：只在第一个成员出现的位置渲染整组，其余成员跳过
              if (renderedGroups.has(mk)) return null
              renderedGroups.add(mk)
              const members = files
                .map((m, j) => ({ m, j }))
                .filter(({ m }) => resolveModKey(m.name) === mk)
              return (
                <ModGroupCard
                  key={`group-${mk}`}
                  modKey={mk}
                  items={members.map(x => x.m)}
                  workshopDetail={modDetails.get(mk)}
                  cloudInfo={cloudInfo.get(mk)}
                  hasUpdate={updates.has(mk)}
                  itemsPerRow={itemsPerRow}
                  onViewDetail={handleViewDetail}
                  onUpdate={handleUpdate}
                  onUninstall={onUninstall}
                  onDisableAll={handleGroupDisableAll}
                  onEnableAll={handleGroupEnableAll}
                >
                  {members.map(({ m, j }) => renderItem(m, j, true))}
                </ModGroupCard>
              )
            })}
          </div>
        )
      })()}
      </AsyncView>
    </div>
  )
}
