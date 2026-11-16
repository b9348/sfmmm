/**
 * 夸克网盘 CLI 启动器（内置 CLI 见 scripts/vendor/quark/）。
 *
 * CLI 会按「当前 Agent 渠道」隔离登录态：在普通终端里它认不出渠道，
 * 会直接以 -104 拒绝运行。这里固定成 workbuddy，让 `pnpm quark ...`
 * 与 `pnpm release` 的夸克步骤共用同一份 config.json。
 *
 *   pnpm quark login      # 首次授权（浏览器 OAuth）
 *   pnpm quark get-user-info
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = process.env.SFMMM_QUARK_CLI || path.join(HERE, 'vendor', 'quark', 'quark-drive.cjs')

// 夸克 SDK 的 clientInfo（clientId/signKey）不入库：优先环境变量，其次 src-tauri/.env。
// 内置 CLI 已打补丁从 QUARK_CLIENT_ID / QUARK_SIGN_KEY 读取（升级 vendor 时需重打）。
function readEnvFile(file) {
  try {
    const out = {}
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#') || !s.includes('=')) continue
      const i = s.indexOf('=')
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}

const envFile = readEnvFile(path.join(HERE, '..', 'src-tauri', '.env'))
const QUARK_CLIENT_ID = process.env.QUARK_CLIENT_ID || envFile.QUARK_CLIENT_ID || ''
const QUARK_SIGN_KEY = process.env.QUARK_SIGN_KEY || envFile.QUARK_SIGN_KEY || ''
if (!QUARK_CLIENT_ID || !QUARK_SIGN_KEY) {
  console.error('缺少 QUARK_CLIENT_ID / QUARK_SIGN_KEY：请在 src-tauri/.env 中配置（参考 .env.example）')
  process.exit(1)
}

const child = spawn(process.execPath, [CLI, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    WORKBUDDY_CONFIG_DIR: path.join(path.dirname(CLI), 'workbuddy'),
    QUARK_CLIENT_ID,
    QUARK_SIGN_KEY,
  },
})
child.on('error', (e) => {
  console.error(`无法启动夸克 CLI：${e.message}`)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 1))
