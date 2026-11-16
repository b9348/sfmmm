import { invoke } from '@tauri-apps/api/core'
import { message } from '@tauri-apps/plugin-dialog'
import i18n from '../i18n'

/**
 * 路径合法性检测（判定逻辑在 Rust 端 path_has_non_ascii）。
 *
 * BepInEx 前置与游戏本体走 ANSI 接口，路径含中文等非 ASCII 字符会导致
 * 注入失败/闪退，故选择目录、启动游戏、安装模组三处统一调用本模块：
 *   - 选择目录：用红字提示并阻止保存（见 WelcomeScreen / GameSettings）；
 *   - 启动游戏 / 安装模组：弹 Windows 原生警告框后直接中断操作。
 */
export async function hasNonAsciiPath(path) {
  if (!path) return false
  try {
    return await invoke('path_has_non_ascii', { path })
  } catch (e) {
    // 检测失败不阻断主流程：后端命令异常不应变成"路径一定合法"或"一定非法"的误判
    console.warn('[pathCheck] 路径检测失败:', e)
    return false
  }
}

/** 弹出 Windows 原生警告框，告知用户路径含中文/非 ASCII 字符。 */
export async function warnNonAsciiPath(path) {
  const body = i18n.t('pathCheck.message', { path })
  try {
    await message(body, {
      title: i18n.t('pathCheck.title'),
      kind: 'warning',
    })
  } catch (e) {
    // 弹窗插件不可用时退回浏览器 alert，保证警告一定送达
    console.warn('[pathCheck] 弹窗失败，回退 alert:', e)
    window.alert(body)
  }
}

/** 检测 + 弹窗的组合：返回 true 表示路径非法且已提示用户，调用方应直接 return。 */
export async function blockInvalidPath(path) {
  if (!(await hasNonAsciiPath(path))) return false
  await warnNonAsciiPath(path)
  return true
}

/**
 * 判断 manifest 条目是否为安全的相对路径（与 Rust 端 `safe_zip_path` 同一套口径）。
 *
 * 前导 `/` 按规范化剥离（兼容历史包），剥离后不能为空；任何含 `:` 的写法
 * （盘符 / NTFS 数据流）与含 `..` 段一律拒绝。Win32 会剥掉路径段尾的空格与点
 * 再解析（`.. ` -> `..`），因此先剥尾再比较，防止拼删除路径时被归一化引到
 * 游戏目录之外。前端凡是用 manifest 拼本地删除路径的地方（如卸载）都要先过
 * 这里，避免历史 manifest 把删除操作引到游戏目录之外。
 */
export function isSafeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  const norm = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (norm.length === 0) return false
  if (norm.includes(':')) return false
  if (norm.split('/').some(seg => seg.replace(/[ .]+$/, '') === '..')) return false
  return true
}
