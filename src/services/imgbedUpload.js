/**
 * 图床通用上传入口：把 Blob/File 落到本地临时文件，交由 Rust 流式上传。
 * Token 只在 Rust 侧使用，前端不接触。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { join, tempDir } from '@tauri-apps/api/path'
import { writeFile, remove } from '@tauri-apps/plugin-fs'

/**
 * @param {File|Blob} file 待上传内容（需带 name；Blob 可用 options.fileName 指定）
 * @param {object} options
 * @param {string} options.folder 图床目录
 * @param {string} [options.channel] 上传通道，默认 telegram
 * @param {string|null} [options.uploadNameType] 命名方式（如图片用 origin）
 * @param {string} [options.fileName] 覆盖上传文件名
 * @param {(loaded:number,total:number,speed:number)=>void} [options.onProgress] 进度回调（speed 为字节/秒）
 * @param {AbortSignal} [options.signal] 取消信号：触发后由 Rust 侧中断进行中的 HTTP 上传
 * @returns {Promise<{src:string,publicUrl:string,url:string}>}
 */
export async function uploadBlobViaTempFile(file, {
  folder,
  channel = 'telegram',
  uploadNameType = null,
  fileName,
  onProgress,
  signal,
} = {}) {
  // 上传标识：进度事件全局广播，按 id 过滤避免并发上传互相串进度
  const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

  let tempPath
  let unlisten
  const onAbort = () => {
    // 通知 Rust 侧中断进行中的上传（含卡在连接阶段的请求）
    invoke('db_cancel_imgbed_upload', { upload_id: uploadId }).catch(() => {})
  }
  try {
    if (signal?.aborted) throw new Error('上传已取消')
    signal?.addEventListener('abort', onAbort, { once: true })

    const name = fileName || file.name || 'upload.bin'
    const ext = name.includes('.') ? name.split('.').pop() : 'bin'
    tempPath = await join(
      await tempDir(),
      `sfmmm-upload-${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`,
    )

    await writeFile(tempPath, new Uint8Array(await file.arrayBuffer()))
    if (signal?.aborted) throw new Error('上传已取消')

    if (onProgress) {
      unlisten = await listen('imgbed-upload-progress', (event) => {
        const { upload_id: id, loaded, total, speed } = event.payload || {}
        if (id !== uploadId || !total) return
        onProgress(loaded, total, speed || 0)
      })
    }

    // listen 期间可能已被取消：进入 Rust 上传前再确认一次，避免取消信号早于注册而失效
    if (signal?.aborted) throw new Error('上传已取消')

    const res = await invoke('db_imgbed_upload_file', {
      file_path: tempPath,
      file_name: name,
      folder,
      channel,
      upload_name_type: uploadNameType,
      upload_id: uploadId,
    })
    if (!res?.success) {
      throw new Error(res?.message || 'ImgBed upload failed')
    }

    return {
      src: res.data?.src || '',
      publicUrl: res.data?.public_url || '',
      url: res.data?.url || res.data?.public_url || res.data?.src || '',
    }
  } catch (err) {
    // Tauri 命令返回 Err(String) 时 invoke 以字符串 reject，统一转成 Error，
    // 保证调用方 e.message 不为空
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    signal?.removeEventListener('abort', onAbort)
    unlisten?.()
    if (tempPath) remove(tempPath).catch(() => {})
  }
}
