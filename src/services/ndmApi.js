/**
 * NDM（Neat Download Manager）外部下载器集成。
 *
 * 通道与 NDM 的浏览器扩展完全一致：本机 `ws://127.0.0.1:10007/download`
 * （子协议 `neatextension.v1`）。后端 `commands/ndm.rs` 复刻这条通道。
 *
 * 和浏览器扩展一样，只能在 NDM **已经运行**时推送任务——不会去查找或拉起它。
 * 不去猜安装路径：别人的 NDM 装在哪无从得知，猜错只会把"能用"误判成"没装"。
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * 探测 NDM 是否在运行（本地服务端口是否在监听）。
 * @returns {Promise<{running: boolean}>}
 */
export async function getNdmStatus() {
  try {
    return await invoke('ndm_status')
  } catch {
    // 探测失败按"没在运行"处理：宁可提示用户先打开 NDM，也不要误报可用后点了没反应
    return { running: false }
  }
}

/**
 * 把下载任务交给 NDM。
 *
 * 传原始图床地址即可：后端会用与内置下载相同的 CDN 线路改写，
 * 保证用户在设置里选的「原始线路 / CDN 加速」对 NDM 同样生效。
 *
 * @returns {Promise<{running: boolean, sent: boolean, url: string, error: string|null}>}
 *   - sent=true：已交给 NDM，软件内不再显示进度
 *   - running=false：NDM 没在运行，url 为改写后的地址，调用方应提示并复制到剪贴板
 *   - error：NDM 在运行但推送失败（同样降级为复制地址）
 */
export async function sendToNdm(fileUrl) {
  return await invoke('ndm_send_download', { url: fileUrl })
}

/**
 * 复制文本到剪贴板。
 *
 * 用 navigator.clipboard 而不是额外插件：Tauri 的 WebView 以安全上下文运行，
 * 该 API 可用且不需要申请权限。失败时回退到隐藏 textarea + execCommand，
 * 覆盖剪贴板 API 被系统策略禁用的少数环境。
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 回退路径：老式选区复制，仅在上面的 API 不可用时走到
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }
}
