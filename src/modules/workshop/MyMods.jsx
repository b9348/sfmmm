import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Text, Button, Toast, ToastBody, ToastTitle,
  makeStyles, tokens, useToastController,
  TabList, Tab,
} from '@fluentui/react-components'
import {
  Add24Regular, Delete24Regular, Edit24Regular,
  ArrowClockwise24Regular, Cloud24Regular,
  Comment24Regular,
} from '@fluentui/react-icons'
import { listMyMods, getModForEdit, getModDetail, deleteMod, deleteModFile, getDeviceId } from '../../services/workshopApi'
import { useAuth } from '../../contexts/useAuth'
import ModCard from './ModCard'
import ModDetailPage from './ModDetailPage'
import { MyDiscussions } from './MyDiscussions'
import { ConfirmDialog, ProgressModal, AsyncView, LoginCard, EmptyState, ItemsPerRowControl } from '../../components'
import { BOTTOM_TOASTER_ID } from '../../components/common/BottomToaster'
import { useGridColumns } from '../../hooks/useGridColumns'
import { usePersistedNumber } from '../../hooks/usePersistedNumber'
import { CreateModPage, EditModPage } from './ModEditorPage'
import { enterView, leaveView } from '../../utils/navHistory'

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
    gap: '12px',
  },
  meta: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeSmall,
  },
})

export function MyMods({ active = true, onDetailOpenChange }) {
  const styles = useStyles()
  const { t } = useTranslation()
  const { user, isLoggedIn } = useAuth()
  const deviceIdRef = useRef(getDeviceId())
  // 删除结果提示：与讨论区一致的全局右下角 Toaster
  const { dispatchToast } = useToastController(BOTTOM_TOASTER_ID)
  // 内部 tab：mods（我的模组）/ discussions（我的讨论：发帖+回复 tag 区分）
  // 支持从 hash 恢复（删除讨论后回到 我的发帖 时带 ?sub=discussions）
  const [subTab, setSubTab] = useState(() => (
    /[?&]sub=discussions\b/.test(window.location.hash) ? 'discussions' : 'mods'
  ))
  const [mods, setMods] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showCreatePage, setShowCreatePage] = useState(false)
  const [editingMod, setEditingMod] = useState(null)
  const [detailMod, setDetailMod] = useState(null)
  // 窄屏：详情页打开时页面要收起顶部 tabs 行（整屏让给详情）
  useEffect(() => {
    onDetailOpenChange?.(!!detailMod)
  }, [detailMod, onDetailOpenChange])
  const [confirmDeleteModId, setConfirmDeleteModId] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deletePercent, setDeletePercent] = useState(0)
  const [deleteStep, setDeleteStep] = useState('')
  const initialFetch = useRef(false)
  // 每行卡片数与「云」页共用配置键 workshop_items_per_row，两页列宽节奏一致
  const [itemsPerRow, handleItemsPerRowChange] = usePersistedNumber('workshop_items_per_row', { defaultValue: 3, logTag: 'MyMods' })
  const [gridRef, gridColumns] = useGridColumns(itemsPerRow)

  const fetchMods = useCallback(async (opts = {}) => {
    setLoading(true)
    setError('')
    try {
      const data = await listMyMods({ author_id: user.user_id, lang: 'zh', device_id: deviceIdRef.current }, opts)
      setMods(data.mods || [])
    } catch (e) {
      setError(e.message)
      setMods([])
    } finally {
      setLoading(false)
    }
  }, [user])

  // 挂载即拉取：Workshop 用 useTabPrefetch 只挂载当前 + 预加载的下一个 tab（非全挂载），
  // 预加载目标在后台提前请求，切换即时展示；避免冷启动多个页面查询挤在唯一连接上排队
  useEffect(() => {
    if (isLoggedIn && !initialFetch.current) {
      initialFetch.current = true
      fetchMods()
    }
  }, [isLoggedIn, fetchMods])

  // 常驻挂载下，从隐藏回到可见（再次进入该 tab）时重新拉取，避免列表数据过期；
  // 首次展示（预加载目标）不重复拉取，直接呈现预加载结果
  const wasShown = useRef(false)
  useEffect(() => {
    if (!active || !isLoggedIn) return
    if (wasShown.current) {
      fetchMods({ force: true })
    }
    wasShown.current = true
  }, [active, isLoggedIn, fetchMods])

  const handleEdit = async (mod) => {
    try {
      // dev（pnpm tauri dev）：强制编辑，跳过后端归属/权限校验
      const res = await getModForEdit(mod.id, user?.user_id || 0, import.meta.env.DEV)
      setEditingMod(res.data || mod)
    } catch (e) {
      alert(t('workshop.getEditDataFailed') + e.message)
    }
  }

  const handleDetail = async (mod) => {
    // 这一层不改 hash：显式入栈并登记重开方式，侧键前进才能重开同一详情
    enterView({
      key: `mymods:${mod.id}`,
      enter: () => setDetailMod(mod),
    })
    try {
      const res = await getModDetail(mod.id, 'zh', user?.user_id, deviceIdRef.current)
      setDetailMod(res.data?.mod || mod)
      // 缓存优先：首渲染可能是本地缓存详情，网络刷新完成后替换为最新数据
      res.revalidate?.then(fresh => {
        const fm = fresh?.data?.mod
        if (fm) setDetailMod(prev => (prev && prev.id === fm.id ? fm : prev))
      })
    } catch {
      setDetailMod(mod)
    }
  }

  const handleDelete = (modId) => setConfirmDeleteModId(modId)

  const handleConfirmDelete = async () => {
    setDeleting(true)
    setDeletePercent(0)
    setDeleteStep(t('workshop.deletingModFiles', { done: 0, total: 0 }))
    const target = mods.find(m => m.id === confirmDeleteModId)
    try {
      const files = target?.files || []
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
      dispatchToast(
        <Toast>
          <ToastTitle>
            {t('workshop.deleteModSuccess', { name: target?.display_name || target?.mod_key || '' })}
          </ToastTitle>
        </Toast>,
        { intent: 'success', timeout: 3000 },
      )
    } catch (e) {
      dispatchToast(
        <Toast>
          <ToastTitle>{t('workshop.deleteModFailed')}</ToastTitle>
          <ToastBody>{e?.message || String(e)}</ToastBody>
        </Toast>,
        { intent: 'error', timeout: 3000 },
      )
    } finally {
      setDeleting(false)
      setConfirmDeleteModId(null)
    }
  }

  // 编辑保存后用接口重拉详情：避免从详情页进入编辑、返回后仍展示旧数据
  const refreshDetailMod = async (modId) => {
    try {
      const res = await getModDetail(modId, 'zh', user?.user_id, deviceIdRef.current, null, { force: true })
      const fresh = res.data?.mod
      if (fresh) setDetailMod(prev => (prev && prev.id === fresh.id ? fresh : prev))
    } catch {
      // 刷新失败静默：保留当前内容，网络指示灯会提示
    }
  }

  if (showCreatePage) {
    return <CreateModPage onClose={() => setShowCreatePage(false)} onCreated={() => { setShowCreatePage(false); fetchMods({ force: true }) }} />
  }

  if (!isLoggedIn) {
    return <LoginCard />
  }

  if (editingMod) {
    return (
      <EditModPage
        mod={editingMod}
        onClose={() => setEditingMod(null)}
        onUpdated={() => {
          const editedId = editingMod.id
          setEditingMod(null)
          fetchMods({ force: true })
          if (detailMod?.id === editedId) refreshDetailMod(editedId)
        }}
        onRefresh={() => {
          // 选择性替换发布成功后只刷新父页面数据，不关闭编辑器（允许继续编辑）。
          // 必须 force：发布刚完成，缓存失效也才刚落地，不能命中发布前的列表快照。
          const editedId = editingMod.id
          fetchMods({ force: true })
          if (detailMod?.id === editedId) refreshDetailMod(editedId)
        }}
      />
    )
  }

  if (detailMod) {
    return <ModDetailPage key={detailMod.id} mod={detailMod} onBack={() => { leaveView(); setDetailMod(null) }} onEdit={handleEdit} onDeleted={() => fetchMods({ force: true })} navActive={active} />
  }

  return (
    <div className={styles.root}>
      <TabList
        selectedValue={subTab}
        onTabSelect={(_, d) => {
          setSubTab(d.value)
          // 同步 hash，刷新后仍停在同一个二级页（不触发 hashchange，避免重复切 tab）
          if (window.location.hash.startsWith('#/workshop/my')) {
            window.history.replaceState(null, '', d.value === 'discussions' ? '#/workshop/my?sub=discussions' : '#/workshop/my')
          }
        }}
      >
        <Tab value="mods" icon={<Cloud24Regular />}>{t('workshop.myMods')}</Tab>
        <Tab value="discussions" icon={<Comment24Regular />}>{t('workshop.myDiscussions')}</Tab>
      </TabList>
      {subTab === 'discussions' ? (
        <MyDiscussions
          userId={user.user_id}
          isLoggedIn={isLoggedIn}
          active={active}
          onOpenDiscussion={(id, commentId) => {
            // 设置 #/discuss/<id>?comment=<cid>&from=my，Workshop hashchange 自动切到讨论区并打开详情；
            // from=my 让详情返回/删除成功后回到「我的发帖」而不是讨论区列表
            window.location.hash = commentId
              ? `#/discuss/${id}?comment=${commentId}&from=my`
              : `#/discuss/${id}?from=my`
          }}
        />
      ) : (
      <>
      <div className={styles.toolbarRow}>
        <Text size="small" className={styles.meta} style={{ flex: 1 }}>
          {t('workshop.modCount', { username: user.username, count: mods.length })}
        </Text>
        <ItemsPerRowControl value={itemsPerRow} onChange={handleItemsPerRowChange} disabled={loading} />
        <Button size="small" icon={<Add24Regular />} appearance="primary" onClick={() => setShowCreatePage(true)}>
          {t('workshop.publishMod')}
        </Button>
        <Button size="small" icon={<ArrowClockwise24Regular />} onClick={() => fetchMods({ force: true })} disabled={loading}>
          {t('workshop.refresh')}
        </Button>
      </div>

      <AsyncView loading={loading} error={error} onRetry={() => fetchMods({ force: true })} loadingLabel={t('workshop.loading')}>
        {mods.length === 0 ? (
          <EmptyState
            icon={<Cloud24Regular style={{ fontSize: '32px' }} />}
            title={t('workshop.noModsYet')}
            description={t('workshop.uploadHint')}
          />
        ) : (
        <div ref={gridRef} className={styles.list} style={{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }}>
          {mods.map(mod => (
            <ModCard
              key={mod.id}
              mod={mod}
              onClick={() => handleDetail(mod)}
              actions={<>
                <Button size="small" icon={<Edit24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); handleEdit(mod) }} />
                <Button size="small" icon={<Delete24Regular />} appearance="subtle" onClick={(e) => { e.stopPropagation(); handleDelete(mod.id) }} />
              </>}
            />
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
      </>
      )}
    </div>
  )
}
