/**
 * `pnpm tauri` 的薄包装：把参数原样转交给 @tauri-apps/cli，
 * 并额外支持离线开发伪子命令 `dev:of`。
 *
 *   pnpm tauri dev       → tauri dev（照常连接云数据库）
 *   pnpm tauri dev:of    → tauri dev + SFMMM_OFFLINE=1
 *                          后端不建立任何 MySQL 连接，只读本地 SQLite 缓存
 *   pnpm tauri build     → tauri build（成功后写产物指纹）
 *
 * 为什么要包装：pnpm 会把 `dev:of` 当作 `tauri` 脚本的参数，实际执行
 * `tauri dev:of`，而 Tauri CLI 没有该子命令；这里在转发前改写为 `dev`
 * 并注入环境变量。其他子命令（含 `pnpm tauri build`）原样透传。
 *
 * 指纹见 scripts/build-meta.mjs：`pnpm release --skip-build` 靠它确认复用的
 * 安装包确实出自当前提交，而不是上一次构建留下的旧包。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeBuildMeta } from './build-meta.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const CLI = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js')

const OFFLINE_SUBCOMMAND = 'dev:of'
const args = process.argv.slice(2)
const offline = args[0] === OFFLINE_SUBCOMMAND
const isBuild = !offline && args[0] === 'build'
if (offline) args[0] = 'dev'

if (offline) {
  console.log('[tauri] 离线开发模式：SFMMM_OFFLINE=1（不连接云数据库，仅使用本地缓存）')
}

const child = spawn(process.execPath, [CLI, ...args], {
  cwd: ROOT,
  stdio: 'inherit',
  // 其余子命令沿用原环境，保持 `pnpm tauri build` 等既有行为完全不变
  env: offline ? { ...process.env, SFMMM_OFFLINE: '1' } : process.env,
})

child.on('error', (e) => {
  console.error('[tauri] 启动 Tauri CLI 失败:', e)
  process.exitCode = 1
})

/** 盖章失败不该让一次成功的构建变成失败，所以全程只警告。 */
function stampBuildMeta() {
  try {
    const conf = JSON.parse(readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))
    const hit = writeBuildMeta(ROOT, conf.version)
    if (hit) {
      const dirty = hit.meta.dirty ? '，构建时工作区有未提交改动' : ''
      console.log(`[tauri] 产物指纹：${path.basename(hit.exe)} @ ${hit.meta.head.slice(0, 7)}${dirty}`)
    } else {
      console.warn(`[tauri] 未找到 v${conf.version} 的 NSIS 安装包，未写指纹（--no-bundle、--debug 或自定义 bundle 目标？）`)
    }
  } catch (e) {
    console.warn('[tauri] 写入产物指纹失败:', e.message)
  }
}

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[tauri] Tauri CLI 被中断（${signal}）`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
  if (isBuild && process.exitCode === 0) stampBuildMeta()
})
