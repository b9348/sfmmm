// 前置检测 + 一键安装的单行状态，供 PrereqTable 的每一行复用。
// prereqKey 与安装产物一一对应：
//   bepinex  BepInEx 加载器（scan_mods，附带 Doorstop 版本兼容性判断）
//   v1       BepInEx/plugins/SFM_custom_mission.dll
//   v2       SFM_custom_mission_v2.dll（Rust 端读 FileVersion 与基准比较，见 checkV2Prereq）
//   font     中文字体 NotoSerifSC-Regular.otf（仅中文用户展示）
//   rmmosaic 去马赛克补丁 d3d11.dll
import { useState, useEffect, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { stat } from '@tauri-apps/plugin-fs'
import {
  PREREQ_DOWNLOAD_POINTS,
  V1_PREREQ_MARKER,
  V2_PREREQ_FONT,
  RMMOSAIC_MARKER,
} from './prereqPoints'
import { checkV2Prereq } from '../../services/v2PrereqCheck'

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 检测并安装一种前置。
 * @returns {{
 *   points: Array<{name: string, url: string}>,
 *   status: null | object,
 *   error: string,
 *   installing: boolean,
 *   progress: number, downloaded: number, total: number, speed: number,
 *   activeUrl: string|null,
 *   stage: string,
 *   check: () => Promise<void>,
 *   install: (point: {name: string, url: string}) => Promise<void>,
 *   cancelInstall: () => Promise<void>,
 * }}
 */
export function usePrereqRow({ gamePath, prereqKey, onInstalled }) {
  const points = prereqKey === 'font'
    ? PREREQ_DOWNLOAD_POINTS.font
    : (PREREQ_DOWNLOAD_POINTS[prereqKey] || PREREQ_DOWNLOAD_POINTS.bepinex)

  // status: null=检测中；其余形状按 prereqKey 不同
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState(0)
  const [downloaded, setDownloaded] = useState(0)
  const [total, setTotal] = useState(0)
  const [speed, setSpeed] = useState(0)
  const [stage, setStage] = useState('')
  const [activeUrl, setActiveUrl] = useState(null)
  const taskIdRef = useRef(null)

  const check = useCallback(async () => {
    if (!gamePath) return
    const root = gamePath.replace(/\/+$/, '')
    setError('')
    setStatus(null)
    try {
      if (prereqKey === 'v1') {
        setStatus({ installed: await fileExists(`${root}/${V1_PREREQ_MARKER}`) })
      } else if (prereqKey === 'v2') {
        // 版本检测与漫游引导共用 checkV2Prereq（见 services/v2PrereqCheck.js）
        const res = await checkV2Prereq(gamePath)
        setStatus({ installed: res.installed, outdated: res.outdated, required: res.required, installedVersion: res.installedVersion })
      } else if (prereqKey === 'font') {
        setStatus({ installed: await fileExists(`${root}/${V2_PREREQ_FONT}`) })
      } else if (prereqKey === 'rmmosaic') {
        setStatus({ installed: await fileExists(`${root}/${RMMOSAIC_MARKER}`) })
      } else {
        const res = await invoke('scan_mods', { gamePath })
        setStatus({
          installed: res.bepinExInstalled === true,
          doorstopVersion: res.doorstopVersion || '',
          doorstopCompatible: res.doorstopCompatible === true,
        })
      }
    } catch (e) {
      // 检测异常单独成态，避免被当成"仍在检测"或"未安装"
      setError(String(e))
      setStatus({ failed: true })
    }
  }, [gamePath, prereqKey])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (gamePath) check()
  }, [gamePath, check])

  // 全局进度事件：后台任务广播，本行按 taskId 匹配
  useEffect(() => {
    let unlistenFn = null
    listen('bepinex-progress', (ev) => {
      const payload = ev.payload || {}
      if (taskIdRef.current === null || payload.taskId !== taskIdRef.current) return
      setProgress(payload.percent ?? 0)
      setDownloaded(payload.downloaded ?? 0)
      setTotal(payload.total ?? 0)
      setSpeed(payload.speed ?? 0)
      setStage(payload.stage || '')
      if (payload.status === 'done') {
        setInstalling(false)
        setStage('')
        check()
        onInstalled?.()
      } else if (payload.status === 'cancelled') {
        setInstalling(false)
        setStage('')
        setError('')
        taskIdRef.current = null
      } else if (payload.status === 'failed') {
        setInstalling(false)
        setStage('')
        setError(payload.error || String(payload.status))
      }
    })
      .then((fn) => { unlistenFn = fn })
      .catch(() => {})
    return () => { if (unlistenFn) unlistenFn() }
  }, [onInstalled, check])

  // 挂载时恢复进行中的后台任务（离开页面再回来，下载不中断）
  useEffect(() => {
    let cancelled = false
    invoke('db_get_bepinex_task')
      .then((task) => {
        if (cancelled || !task) return
        // 只接管属于本前置下载点的任务，避免多行互相抢进度
        if (!points.some((p) => p.url === task.url)) return
        const running = ['pending', 'downloading', 'extracting'].includes(task.status)
        if (running) {
          taskIdRef.current = task.id
          setActiveUrl(task.url)
          setInstalling(true)
          setProgress(task.percent ?? 0)
          setDownloaded(task.downloaded ?? 0)
          setTotal(task.total ?? 0)
          setStage(task.stage || 'downloading')
        } else if (task.status === 'failed') {
          setError(task.error || '')
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [points])

  const install = useCallback(async (point) => {
    if (!point) return
    setActiveUrl(point.url)
    setInstalling(true)
    setProgress(0)
    setDownloaded(0)
    setTotal(0)
    setSpeed(0)
    setStage('downloading')
    setError('')
    try {
      const result = await invoke('db_install_bepinex', { url: point.url })
      // 命中进行中任务时返回 deduplicated=true，同样接管其进度
      taskIdRef.current = result.taskId
    } catch (e) {
      setError(String(e))
      setInstalling(false)
      setStage('')
    }
  }, [])

  const cancelInstall = useCallback(async () => {
    if (taskIdRef.current === null) return
    try {
      // db_cancel_bepinex 声明了 rename_all = "snake_case"，参数键必须是 task_id
      await invoke('db_cancel_bepinex', { task_id: taskIdRef.current })
    } catch (e) {
      console.warn('[usePrereqRow] 取消下载失败:', e)
    }
  }, [])

  return {
    points,
    status,
    error,
    installing,
    progress,
    downloaded,
    total,
    speed,
    activeUrl,
    stage,
    check,
    install,
    cancelInstall,
  }
}
