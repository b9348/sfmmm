// v2 前置版本检测（供三处复用）：
//   - PrereqTable（本地模组 v2 页前置表格的"版本低于基准"提示）
//   - BrowseMods 漫游引导（创意工坊「云」页提醒更新 v2）
//   - V2PrereqNoticeProvider（详情页「安装」/ 侧栏「启动游戏」时的右下角 toast）
// 判定逻辑在 Rust 端（commands/v2_prereq.rs）：直接读 dll 的 FileVersion 与基准
// 2.4.0 逐位比较，返回已安装版本号与要求版本号，前端不再保存任何指纹/基准常量。
import { invoke } from '@tauri-apps/api/core'

/**
 * 检测游戏目录已安装的 v2 前置版本状态。
 * @param {string} [gamePath] 游戏根目录；省略时由 Rust 从 config.db 读取最新路径
 * @returns {Promise<{installed: boolean, outdated: boolean, installedVersion: string, required: string}>}
 *   installed=false 表示插件不存在；outdated 仅在 installed=true 时有意义。
 *   检测异常（命令失败/版本读不出）一律降级为"不提示更新"。
 */
export async function checkV2Prereq(gamePath) {
  const fallback = { installed: false, outdated: false, installedVersion: '', required: '' }
  try {
    const res = await invoke('check_v2_prereq_version', {
      gamePath: gamePath ? gamePath.replace(/[\\/]+$/, '') : null,
    })
    const status = res?.status
    return {
      // unknown = 文件在但版本资源读不出（非标准改版），按已安装处理
      installed: status === 'ok' || status === 'outdated' || status === 'unknown',
      outdated: status === 'outdated',
      installedVersion: res?.installedVersion || '',
      required: res?.required || '',
    }
  } catch {
    return fallback
  }
}
