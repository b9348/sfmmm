/**
 * 本地发版（替代 GitHub Actions 的 release.yml）：
 *   比对版本 → 构建 NSIS 安装包 → 上传图床 → 发布 latest.json → 更新云端 version_config → 清理旧包
 *
 * 用法（仓库根目录）：
 *   pnpm release                       # 本地版本高于线上才发版，相等/落后直接中止
 *   pnpm release --dry-run             # 只跑到版本比对，打印后续将做什么
 *   pnpm release --skip-build          # 跳过构建，复用 target 里本版本的安装包（校验构建指纹）
 *   pnpm release --no-db               # 跳过云端 version_config
 *   pnpm release --tag                 # 额外创建并推送 v{version} 标签
 *   pnpm release --force               # 线上版本相同时也强制重发
 *   pnpm release --force-online-unreachable  # 读不到线上清单时仍继续（危险）
 *   pnpm release --only-db             # 故障恢复：只按线上清单补更新 version_config
 *   pnpm release --keep-old=1          # 清理旧包时保留最近 1 个旧版本
 *   pnpm release --verbose             # 子进程输出直出（同时关闭进度面板）
 *
 * 版本号由 .git/hooks/pre-commit 每次提交自动 +1，本脚本不做 bump：
 * 安装包内的版本与 latest.json 的版本必须完全一致，否则客户端会陷入
 * 「提示更新 → 装上还是旧版 → 再次提示」的循环。
 *
 * --skip-build 复用本地产物前，比对 <exe>.meta.json 里的构建指纹
 * （HEAD、工作区是否干净、.env 哈希，由 pnpm tauri build 写入，见 build-meta.mjs）；
 * 包名里的版本号只能证明它「声称」是哪个版本，证明不了它是用当前源码编的。
 *
 * 配置全部取自本地文件：
 *   src-tauri/.env → IMGBED_URL / IMGBED_TOKEN / DB_URL / DB_ENC_KEY / DB_TLS1
 *   .env           → VITE_LATEST_URL（构建时注入前端，同时作为清单回读地址）
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { META_SUFFIX, fingerprint, readBuildMeta } from './build-meta.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const TAURI_DIR = path.join(ROOT, 'src-tauri')
const TARGET_DIR = path.join(TAURI_DIR, 'target')
const NSIS_DIR = path.join(TARGET_DIR, 'release', 'bundle', 'nsis')
const CONF_PATH = path.join(TAURI_DIR, 'tauri.conf.json')

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const argValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : null
}

const skipBuild = has('--skip-build')
const dryRun = has('--dry-run')
const noDb = has('--no-db')
const makeTag = has('--tag')
const force = has('--force')
const forceOnlineUnreachable = has('--force-online-unreachable')
const onlyDb = has('--only-db')
const verbose = has('--verbose')
const keepOld = Number(argValue('--keep-old') ?? 0)

if (!Number.isInteger(keepOld) || keepOld < 0) {
  console.error('--keep-old 必须是非负整数')
  process.exit(2)
}

// ────────────────────────────── 终端输出 ──────────────────────────────

const WIN = process.platform === 'win32'
const CURL = WIN ? 'curl.exe' : 'curl'
const PNPM = WIN ? 'pnpm.cmd' : 'pnpm'
const CARGO = WIN ? 'cargo.exe' : 'cargo'
const GIT = WIN ? 'git.exe' : 'git'

/**
 * cmd.exe 不会自动开启 VT 处理，直接把 \x1b[2A 打出来会变成「←[2A」。
 * 因此只在能确认支持 ANSI 的终端里做整块重绘，否则退化成逐行打印。
 */
const ANSI_OK =
  process.env.SFMMM_RELEASE_ANSI === '1' ||
  (process.stdout.isTTY === true &&
    Boolean(
      process.env.WT_SESSION ||
        process.env.TERM ||
        process.env.TERM_PROGRAM ||
        process.env.ANSICON ||
        process.env.ConEmuANSI,
    ))
const PLAIN = !ANSI_OK || verbose || process.env.SFMMM_RELEASE_PLAIN === '1'
const ASCII = process.env.SFMMM_RELEASE_ASCII === '1'

const SYM = ASCII
  ? { pending: '.', ok: '[OK]', fail: '[XX]', warn: '[!!]', skip: '[--]', abort: '[STOP]' }
  : { pending: '·', ok: '✔', fail: '✘', warn: '⚠', skip: '—', abort: '⏹' }

const SPIN = ASCII ? ['.  ', '.. ', '...'] : ['·  ', '·· ', '···']

const C = ANSI_OK
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', cyan: '', reset: '' }

function charWidth(cp) {
  if (cp < 0x1100) return 1
  if (
    cp <= 0x115f ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

const strWidth = (s) => {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0))
  return w
}

/** 按显示宽度截断：中文占两列，用 code unit 截断会让面板画花 */
function clip(s, max) {
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0))
    if (w + cw > max) break
    out += ch
    w += cw
  }
  return out
}

function padTo(s, width) {
  const w = strWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

function fmtDur(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

const firstLine = (msg) => String(msg || '').split('\n')[0].slice(0, 200)
const titleOf = (t) => (typeof t.title === 'function' ? t.title() : t.title)

/** 「已中止」不是错误：版本没有变化时用它来正常退出 */
class Abort extends Error {}

const TITLE_W = 30
// 帧高必须留在终端窗口内，否则 \x1b[NA 上移量会失真、面板整个画花
const MAX_DETAILS = 12

/** 详情过多时保留头部（失败归因用的提示）和尾部（日志尾巴），中间折叠 */
function clipDetails(details) {
  if (details.length <= MAX_DETAILS) return details
  const head = details.slice(0, 3)
  const tail = details.slice(-(MAX_DETAILS - 4))
  return [...head, `…省略 ${details.length - MAX_DETAILS + 1} 行`, ...tail]
}

class UI {
  constructor(tasks) {
    this.tasks = tasks
    this.header = []
    this.printed = 0
    this.timer = null
  }

  setHeader(lines) {
    this.header = lines
    // PLAIN 模式不重绘，表头在这里一次性打出来（否则图床/清单地址会丢）
    if (PLAIN) {
      for (const l of lines) console.log(l)
      console.log('')
      return
    }
    this.render()
  }

  frameLines() {
    const cols = Math.max(40, process.stdout.columns || 100)
    const n = this.tasks.length
    const idxW = String(n).length
    const lines = []

    for (const h of this.header) lines.push(clip(h, cols - 1))
    if (this.header.length) lines.push('')

    for (let i = 0; i < n; i += 1) {
      const t = this.tasks[i]
      const title = titleOf(t)
      let status = ''
      let color = ''

      if (t.state === 'pending') {
        status = `${SYM.pending} 等待中`
        color = C.dim
      } else if (t.state === 'running') {
        const frame = SPIN[Math.floor(Date.now() / 120) % SPIN.length]
        const dur = t.startedAt ? ` ${fmtDur(Date.now() - t.startedAt)}` : ''
        status = `[${frame}] ${t.spin || '执行中'}${dur}`
        color = C.cyan
      } else if (t.state === 'ok') {
        status = `${SYM.ok} ${t.note || '完成'}`
        color = C.green
      } else if (t.state === 'fail') {
        status = `${SYM.fail} ${t.note || '失败'}`
        color = C.red
      } else if (t.state === 'abort') {
        status = `${SYM.abort} ${t.note || '已中止'}`
        color = C.yellow
      } else {
        status = `${SYM.skip} ${t.note || '已跳过'}`
        color = C.dim
      }

      const head = `  [${String(i + 1).padStart(idxW)}/${n}] ${padTo(title, TITLE_W)} `
      lines.push(color + clip(head + status, cols - 1) + C.reset)

      for (const d of clipDetails(t.details)) {
        lines.push(C.dim + clip(`        └ ${d}`, cols - 1) + C.reset)
      }
    }
    return lines
  }

  render() {
    if (PLAIN) return
    const lines = this.frameLines()
    const buf = []
    if (this.printed > 0) buf.push(`\x1b[${this.printed}A`)
    buf.push('\x1b[0J', lines.join('\n'), '\n')
    process.stdout.write(buf.join(''))
    this.printed = lines.length
  }

  start() {
    if (PLAIN || this.timer) return
    this.timer = setInterval(() => this.render(), 120)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

// ────────────────────────────── 配置 ──────────────────────────────

function readEnvFile(file) {
  const out = {}
  if (!existsSync(file)) return out
  let content = readFileSync(file, 'utf8')
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    let value = line.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[line.slice(0, i).trim()] = value
  }
  return out
}

const tauriEnv = readEnvFile(path.join(TAURI_DIR, '.env'))
const webEnv = readEnvFile(path.join(ROOT, '.env'))

const IMGBED_URL = (tauriEnv.IMGBED_URL || '').replace(/\/+$/, '')
const IMGBED_TOKEN = tauriEnv.IMGBED_TOKEN || ''
const LATEST_URL = webEnv.VITE_LATEST_URL || (IMGBED_URL ? `${IMGBED_URL}/file/sfm/installer/latest.json` : '')

// ────────────────────────────── 子进程 ──────────────────────────────

// Windows 下不能直接 spawn .cmd/.bat：Node ≥18.20/20.12 起会抛 spawn EINVAL
// （CVE-2024-27980 的修复移除了隐式 cmd.exe 包装）。这里改由 cmd.exe /c 执行，
// 不用 shell:true——那会对参数做未转义拼接并触发 DEP0190 警告。
function spawnChild(cmd, args, options) {
  if (WIN && /\.(cmd|bat)$/i.test(cmd)) {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd, ...args], options)
  }
  return spawn(cmd, args, options)
}

/** 杀掉进程树：pnpm → tauri → cargo 是多层，只杀父进程会留下占着 .cargo-lock 的孤儿 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  if (WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出 */
    }
  }
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd, args, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))))
  })
}

function runCapture(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd, args, { cwd })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

/**
 * 把子进程输出写进日志文件，界面上只显示耗时。
 * 直接 inherit 的话 cargo 的几百行输出会把进度面板冲散。
 */
function runLogged(cmd, args, cwd, logPath, onChild) {
  if (verbose) {
    return new Promise((resolve, reject) => {
      const child = spawnChild(cmd, args, { cwd, stdio: 'inherit' })
      child.on('error', reject)
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`)),
      )
    })
  }
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(logPath, { flags: 'w' })
    const child = spawnChild(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    if (onChild) onChild(child)
    child.stdout.pipe(stream)
    child.stderr.pipe(stream)

    let settled = false
    const finish = (fn) => {
      if (settled) return
      settled = true
      if (onChild) onChild(null)
      // 必须等写入流真正 flush 完再返回：失败时紧接着要读日志尾部做归因，
      // stream.end() 只是“开始收尾”，立刻 readFileSync 会读到截断的内容。
      stream.end(() => fn())
    }

    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code) => {
      finish(() =>
        code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`)),
      )
    })
  })
}

/** 从日志尾部提取可读的错误，并按前后端归因 */
async function describeBuildFailure(logPath) {
  let lines = []
  try {
    lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  } catch {
    return { hint: '', tail: [] }
  }
  const tail = lines.slice(-15)
  const text = lines.slice(-400).join('\n')
  let hint = ''
  if (/error\[E\d+\]|could not compile|error: could not/i.test(text)) {
    hint = 'Rust 编译失败'
  } else if (/\bESLint\b|\berror\s+TS\d+|\bParsing error\b/i.test(text)) {
    hint = '前端检查失败（pnpm build 含 eslint）'
  } else if (/error while running|command failed/i.test(text)) {
    hint = '构建命令失败'
  }
  return { hint, tail }
}

// ────────────────────────────── HTTP ──────────────────────────────

/**
 * 用系统 curl 做 HTTP 请求。
 * 不用 Node fetch：本项目网络环境下 undici 直连图床会挑到不可达的 IPv6/边缘 IP 并超时，
 * curl 会遍历解析结果并复用系统代理，稳定得多。
 */
const CURL_RETRY = ['--retry', '5', '--retry-delay', '3', '--retry-all-errors', '--connect-timeout', '20']

function curl(args, { unref = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CURL, ['-sS', ...CURL_RETRY, ...args])
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`curl 退出码 ${code}: ${err.trim().slice(0, 300)}`)),
    )
    if (unref) {
      // 后台任务（旧包扫描）不该拖着进程不让退出：失败时报完错就要立刻能退
      child.unref()
      child.stdout.unref?.()
      child.stderr.unref?.()
    }
  })
}

/** 同时拿响应体和状态码：清单 404 是「首次发版」，不能被当成网络异常 */
async function curlWithStatus(args) {
  const text = await curl([...args, '-w', '\n%{http_code}'])
  const i = text.lastIndexOf('\n')
  if (i < 0) throw new Error('curl 输出异常（缺少状态码）')
  return { body: text.slice(0, i), status: Number(text.slice(i + 1).trim()) }
}

function compareVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff) return diff
  }
  return 0
}

/** 读线上清单：404 → 无版本；200+JSON → 版本；其它 → 抛错（交给调用方决定是否强推） */
async function readManifest() {
  const { body, status } = await curlWithStatus([
    '-H',
    'Cache-Control: no-cache',
    `${LATEST_URL}?t=${Date.now()}`,
  ])
  if (status === 404) return { status, version: null, updateUrl: null, raw: null }
  if (status !== 200) throw new Error(`清单请求返回 HTTP ${status}`)
  let data
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error(`清单返回非 JSON（CDN 可能尚未生效）: ${body.slice(0, 60)}`)
  }
  if (typeof data?.version !== 'string') throw new Error('清单缺少 version 字段')
  return { status, version: data.version, updateUrl: data.update_url || null, raw: body }
}

async function readManifestRetry(attempts = 3) {
  let last
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await readManifest()
    } catch (e) {
      last = e
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw last
}

const fileKey = (url) => String(url).split(/[?#]/)[0].replace(`${IMGBED_URL}/file/`, '')

async function remoteExists(url) {
  const code = await curl(['-o', '/dev/null', '-w', '%{http_code}', '-H', 'Cache-Control: no-cache', `${url}?t=${Date.now()}`])
  return code.trim() === '200'
}

/** 删除图床文件；接口非幂等（记录不存在也报失败），用存活检查兜底 */
async function imgbedDelete(key, { tolerateAbsent = true } = {}) {
  const text = await curl([`${IMGBED_URL}/api/manage/delete/${key}`, '-H', `Authorization: Bearer ${IMGBED_TOKEN}`])
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    // 旧版接口异常时可能返回非 JSON，交给存活检查兜底
  }
  if (data?.success === true) return { existed: data.existed !== false }
  if (tolerateAbsent && !(await remoteExists(`${IMGBED_URL}/file/${key}`))) return { existed: false }
  throw new Error(data?.error || data?.message || `删除失败: ${text.slice(0, 120)}`)
}

async function deleteManifest() {
  try {
    await imgbedDelete('sfm/installer/latest.json')
  } catch (e) {
    throw new Error(
      `删除旧清单失败（${e.message}）：` +
        '图床 KV 写入/删除配额可能已耗尽（UTC 零点重置）。' +
        '若继续上传，固定地址会被重命名成 latest(1).json，请稍后重试或先手动清理',
    )
  }
}

async function imgbedUpload(filePath, folder, nameType) {
  const query = new URLSearchParams({
    uploadChannel: 'telegram',
    uploadFolder: folder,
    returnFormat: 'full',
  })
  if (nameType) query.set('uploadNameType', nameType)

  const text = await curl([
    '-X',
    'POST',
    `${IMGBED_URL}/upload?${query}`,
    '-H',
    `Authorization: Bearer ${IMGBED_TOKEN}`,
    '-F',
    `file=@${filePath}`,
  ])

  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`图床上传返回非 JSON: ${text.slice(0, 300)}`)
  }
  const src = Array.isArray(data) ? data[0]?.src : data?.src
  if (!src) throw new Error(`图床上传返回缺少 src: ${text.slice(0, 300)}`)
  return src
}

async function listRemote(prefix, opts) {
  const url = `${IMGBED_URL}/api/manage/list?count=-1&dir=${encodeURIComponent(prefix)}&recursive=true`
  const text = await curl([url, '-H', `Authorization: Bearer ${IMGBED_TOKEN}`], opts)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`图床列表返回非 JSON: ${text.slice(0, 200)}`)
  }
  if (!Array.isArray(data.files)) throw new Error('图床列表缺少 files 字段')
  return data.files
}

/**
 * 回读校验清单。
 * 上传后固定地址在 CDN 生效前可能短暂返回 404 占位图（JPEG），此时 JSON.parse 会抛
 * "Unexpected token"；因此不能只读一次，需要轮询到版本匹配为止。
 */
async function verifyManifest(version, attempts = 30, intervalMs = 2000) {
  let lastError = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      const info = await readManifest()
      if (info.status !== 200) throw new Error(`清单尚未生效（HTTP ${info.status}）`)
      if (info.version !== version) throw new Error(`清单版本不一致：期望 ${version}，实际 ${String(info.version)}`)
      return info
    } catch (e) {
      lastError = e
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw new Error(`清单回读校验失败（已重试 ${attempts} 次）: ${lastError?.message}`)
}

// ────────────────────────────── 安装包 ──────────────────────────────

/**
 * 找本次版本对应的安装包：只认文件名含 `_{version}_` 的，
 * 避免 --skip-build 时误传到历史版本（或更新的）旧包。
 */
async function findInstaller(version, strict) {
  if (!existsSync(NSIS_DIR)) {
    if (strict) throw new Error(`未找到 NSIS 产物目录: ${NSIS_DIR}`)
    return null
  }
  const entries = (await readdir(NSIS_DIR)).filter((f) => f.toLowerCase().endsWith('.exe'))
  const matched = entries.filter((name) => name.includes(`_${version}_`))
  if (matched.length) {
    const stats = await Promise.all(
      matched.map(async (name) => ({ name, mtime: (await stat(path.join(NSIS_DIR, name))).mtimeMs })),
    )
    stats.sort((a, b) => b.mtime - a.mtime)
    return path.join(NSIS_DIR, stats[0].name)
  }
  if (strict) throw new Error(`未找到 v${version} 的安装包，请去掉 --skip-build 重新构建`)
  return null
}

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

/** 删本地包时把指纹一起删，免得留下没有宿主的 .meta.json */
async function unlinkPackage(file) {
  await unlink(file)
  if (existsSync(file + META_SUFFIX)) await unlink(file + META_SUFFIX)
}

/**
 * 扫描待清理的旧包。
 * 只收版本号严格小于当前版本的包：不能按「文件名不含当前版本」来删，
 * 手工 build 出的更高版本会被误删。图床侧还顺带收集残留的 latest(N).json。
 */
async function scanOldPackages(currentVersion, opts) {
  const remoteFiles = (await listRemote('sfm/installer', opts)).map((f) => f.name).filter(Boolean)
  const older = remoteFiles.filter((name) => {
    const m = /^sfm\/installer\/v(\d+\.\d+\.\d+)\//.exec(name)
    return m && compareVersion(m[1], currentVersion) < 0
  })

  const localFiles = []
  if (existsSync(NSIS_DIR)) {
    for (const name of await readdir(NSIS_DIR)) {
      if (!name.toLowerCase().endsWith('.exe')) continue
      const m = /^sfmmm_(\d+\.\d+\.\d+)_/i.exec(name)
      if (!m || compareVersion(m[1], currentVersion) >= 0) continue
      localFiles.push(path.join(NSIS_DIR, name))
    }
  }

  return { remoteFiles, older, localFiles }
}

/** --keep-old：在「低于当前版本」的集合里再保留最近 N 个版本 */
function dropKeptVersions(items, versionOf) {
  if (keepOld <= 0) return items
  const versions = [...new Set(items.map(versionOf))]
  versions.sort((a, b) => compareVersion(b, a))
  const keep = new Set(versions.slice(0, keepOld))
  return items.filter((item) => !keep.has(versionOf(item)))
}

const remoteVersionOf = (name) => (/^sfm\/installer\/v(\d+\.\d+\.\d+)\//.exec(name) || [])[1] || '0.0.0'

// ────────────────────────────── 任务 ──────────────────────────────

const ctx = {
  version: '',
  online: { status: 0, version: null, updateUrl: null, raw: null },
  installer: null,
  downloadUrl: '',
  scan: null,
  scanPromise: null,
  scanError: null,
  logStamp: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
}

const tasks = []
const addTask = (title, fn, extra = {}) => {
  const task = { title, run: fn, state: 'pending', details: [], note: '', startedAt: 0, ...extra }
  tasks.push(task)
  return task
}

function checkConfig() {
  if (!IMGBED_URL || !IMGBED_TOKEN) {
    throw new Error('缺少图床配置：请在 src-tauri/.env 配置 IMGBED_URL / IMGBED_TOKEN')
  }
  if (IMGBED_TOKEN.startsWith('sec1:')) {
    throw new Error('src-tauri/.env 里的 IMGBED_TOKEN 需使用明文后再用本脚本')
  }
  if (!LATEST_URL) {
    throw new Error('缺少版本清单地址：请在根目录 .env 配置 VITE_LATEST_URL')
  }
}

async function tPreflight(t) {
  checkConfig()

  const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(conf.version)) throw new Error(`版本号格式非法: ${conf.version}`)
  ctx.version = conf.version

  try {
    const dirty = await runCapture(GIT, ['status', '--porcelain'], ROOT)
    if (dirty) {
      t.details.push(
        skipBuild
          ? `${SYM.warn} 工作区有未提交改动；--skip-build 复用旧包，这些改动不会进包`
          : `${SYM.warn} 工作区有未提交改动，安装包将包含这些改动`,
      )
    }
  } catch {
    t.details.push(`${SYM.warn} 无法读取 git 状态`)
  }

  return `本地 v${ctx.version}`
}

/** 旧包扫描要打图床列表接口（数秒），不放在预检里阻塞版本比对 */
function loadScan(opts) {
  return scanOldPackages(ctx.version, opts)
    .then((s) => {
      ctx.scan = s
    })
    .catch((e) => {
      ctx.scanError = e
    })
}

async function tCompare(t) {
  let info
  try {
    info = await readManifestRetry()
  } catch (e) {
    if (!forceOnlineUnreachable) {
      throw new Error(`无法读取线上清单（${firstLine(e.message)}）；确认网络后再试，或用 --force-online-unreachable 强制继续`)
    }
    info = { status: 0, version: null, updateUrl: null, raw: null }
    t.details.push(`${SYM.warn} 已按 --force-online-unreachable 跳过版本检查`)
  }
  ctx.online = info

  if (info.version) {
    const cmp = compareVersion(ctx.version, info.version)
    if (cmp === 0) {
      if (!force) throw new Abort(`线上已是 v${info.version}，本次没有新版本可发（先提交一次让钩子升版本，或用 --force）`)
      t.details.push(`${SYM.warn} 线上同版本，按 --force 重发`)
    } else if (cmp < 0) {
      throw new Error(`本地 v${ctx.version} 低于线上 v${info.version}，先 git pull 或检查版本号，避免版本倒退`)
    }
  } else if (info.status === 404) {
    t.details.push('线上尚无清单（首次发版）')
  }

  // 闸门已过，扫描旧包与后续构建/上传并行，等第 7 步再收结果
  if (dryRun) {
    await loadScan()
    if (ctx.scanError) {
      t.details.push(`${SYM.warn} 旧包扫描失败（${firstLine(ctx.scanError.message)}），将跳过清理`)
    } else {
      const r = dropKeptVersions(ctx.scan.older, remoteVersionOf).length
      const l = ctx.scan.localFiles.length
      t.details.push(r + l ? `将清理旧包：图床 ${r} 个 / 本地 ${l} 个` : '没有需要清理的旧包')
    }
  } else {
    ctx.scanPromise = loadScan({ unref: true })
  }

  return info.version ? `线上 v${info.version} → 本地 v${ctx.version}` : '线上无版本，按首次发版处理'
}

async function tBuild(t) {
  await mkdir(TARGET_DIR, { recursive: true })
  const logPath = path.join(TARGET_DIR, `release-${ctx.logStamp}.log`)
  t.spin = '编译中…'
  if (!verbose) t.details.push(`日志：${path.relative(ROOT, logPath)}`)
  try {
    await runLogged(PNPM, ['tauri', 'build'], ROOT, logPath, (child) => {
      ctx.child = child
    })
  } catch (e) {
    const { hint, tail } = await describeBuildFailure(logPath)
    if (hint) t.details.push(hint)
    for (const line of tail) t.details.push(line)
    throw e
  }
  if (verbose) return `构建完成（用时 ${fmtDur(Date.now() - t.startedAt)}）`
  const st = await stat(logPath)
  t.details.push(`日志 ${fmtSize(st.size)}`)
  return '构建完成'
}

const shortSha = (sha) => (sha || '').slice(0, 7)

async function tLocate(t) {
  ctx.installer = await findInstaller(ctx.version, true)
  const st = await stat(ctx.installer)
  t.details.push(`${path.basename(ctx.installer)}（${fmtSize(st.size)}）`)

  // 本次自己编的，产物即事实，不需要指纹
  if (!skipBuild) return '已定位本次构建产物'
  return assertBuildFingerprint(ctx.installer, t)
}

/**
 * --skip-build 的保险丝：包名里的版本号只证明「声称」，指纹才证明来源。
 * 宁可错杀一次（重新构建很便宜），也不能把带旧配置/旧源码的包发到更新源上。
 */
function assertBuildFingerprint(installer, t) {
  let meta
  try {
    meta = readBuildMeta(installer)
  } catch (e) {
    throw new Error(`构建指纹无法解析（${path.basename(installer)}${META_SUFFIX}）：${firstLine(e.message)}`)
  }
  if (!meta) {
    throw new Error(
      `${path.basename(installer)} 没有构建指纹，无法确认它出自当前提交；` +
        '去掉 --skip-build 重新构建，或用 pnpm tauri build 重新编一次以补写指纹',
    )
  }

  let now
  try {
    now = fingerprint(ROOT)
  } catch (e) {
    throw new Error(`无法读取当前 git 指纹，拒绝复用本地产物：${firstLine(e.message)}`)
  }

  if (meta.version !== ctx.version) throw new Error(`指纹版本 ${meta.version} 与包名 ${ctx.version} 不符`)
  if (!meta.head) throw new Error('构建指纹缺少 HEAD，无法确认来源；重新构建')
  if (meta.head !== now.head) {
    throw new Error(
      `安装包出自 ${shortSha(meta.head)}，当前 HEAD 是 ${shortSha(now.head)}：提交后没重新构建（用 pnpm tauri build 重编）`,
    )
  }
  if (meta.envTauri !== now.envTauri || meta.envWeb !== now.envWeb) {
    throw new Error('src-tauri/.env 或根目录 .env 在构建后改动过，包内配置已不是当前值')
  }

  if (meta.dirty) t.details.push(`${SYM.warn} 构建时工作区不干净，包里含未入库代码`)
  else if (now.dirty) t.details.push(`${SYM.warn} 当前工作区的未提交改动不会出现在这个包里`)
  t.details.push(`构建于 ${meta.builtAt} @ ${shortSha(meta.head)}`)

  return `指纹匹配 ${shortSha(now.head)}`
}

async function tUpload(t) {
  const installer = ctx.installer
  const st = await stat(installer)
  t.details.push(`安装包：${path.basename(installer)}（${fmtSize(st.size)}）`)

  t.spin = '上传中…'
  ctx.downloadUrl = await imgbedUpload(installer, `sfm/installer/v${ctx.version}`, null)
  t.details.push(`直链：${ctx.downloadUrl}`)
  return '上传完成'
}

async function tPublish(t) {
  const oldRaw = ctx.online.raw

  t.spin = '写入清单…'
  await deleteManifest()

  let uploaded = null
  try {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sfmmm-release-'))
    const manifestPath = path.join(tmpDir, 'latest.json')
    await writeFile(manifestPath, JSON.stringify({ version: ctx.version, update_url: ctx.downloadUrl }))
    uploaded = await imgbedUpload(manifestPath, 'sfm/installer', 'origin')

    // 图床删除旧清单失败时同名上传会被重命名成 latest(1).json，固定地址永远是旧内容/404
    const expected = `${IMGBED_URL}/file/sfm/installer/latest.json`
    if (uploaded.split(/[?#]/)[0] !== expected) {
      throw new Error(`清单被图床重命名（通常是旧清单删除失败）: ${uploaded}`)
    }

    ctx.online = { status: 200, version: ctx.version, updateUrl: ctx.downloadUrl, raw: null }

    t.spin = '等待 CDN 生效…'
    const verified = await verifyManifest(ctx.version)
    t.details.push(`清单地址：${LATEST_URL}`)
    return `v${verified.version} 已生效`
  } catch (e) {
    // 旧清单已经删了；不回滚就等于主更新源直接 404
    if (!oldRaw) throw e
    t.details.push(`${SYM.warn} 发布失败，正在尝试恢复旧清单…`)
    try {
      if (uploaded) {
        await imgbedDelete(fileKey(uploaded)).catch(() => {})
      }
      await imgbedDelete('sfm/installer/latest.json').catch(() => {})
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sfmmm-restore-'))
      const p = path.join(tmpDir, 'latest.json')
      await writeFile(p, oldRaw)
      const src = await imgbedUpload(p, 'sfm/installer', 'origin')
      if (src.split(/[?#]/)[0] !== `${IMGBED_URL}/file/sfm/installer/latest.json`) {
        throw new Error('恢复后地址被重命名')
      }
      t.details.push('已恢复旧清单')
    } catch (restoreErr) {
      t.details.push(`${SYM.warn} 旧清单恢复失败（${firstLine(restoreErr.message)}），需手动补传`)
    }
    throw e
  }
}

async function tUpdateDb(t) {
  const logPath = path.join(TARGET_DIR, `release-db-${ctx.logStamp}.log`)
  t.spin = '写库中…'
  if (!verbose) t.details.push(`日志：${path.relative(ROOT, logPath)}`)
  try {
    await runLogged(
      CARGO,
      ['run', '--release', '--example', 'set_version_config', '--', ctx.version, ctx.downloadUrl],
      TAURI_DIR,
      logPath,
      (child) => {
        ctx.child = child
      },
    )
  } catch (e) {
    const { tail } = await describeBuildFailure(logPath)
    for (const line of tail) t.details.push(line)
    throw e
  }
  return '云端已同步'
}

async function tTag(t) {
  const tag = `v${ctx.version}`
  try {
    await runCapture(GIT, ['rev-parse', '--verify', `refs/tags/${tag}`], ROOT)
    return `标签 ${tag} 已存在`
  } catch {
    /* 不存在，继续创建 */
  }
  await run(GIT, ['tag', tag], ROOT)
  await run(GIT, ['push', 'origin', tag], ROOT)
  return `已推送 ${tag}`
}

async function tCleanup(t) {
  if (ctx.scanPromise) await ctx.scanPromise
  if (!ctx.scan) {
    const why = ctx.scanError ? firstLine(ctx.scanError.message) : '未取得清理清单'
    return `${SYM.warn} 跳过清理（${why}）`
  }

  const keepKey = ctx.online.updateUrl ? fileKey(ctx.online.updateUrl) : null

  const olderRemote = dropKeptVersions(ctx.scan.older, remoteVersionOf)
  // 同版本被重复上传的包、以及上次发版残留的 latest(1).json 都属于垃圾
  const extrasRemote = ctx.scan.remoteFiles.filter((name) => {
    if (name === 'sfm/installer/latest.json') return false
    const m = /^sfm\/installer\/v(\d+\.\d+\.\d+)\//.exec(name)
    if (!m) return /^sfm\/installer\/latest.*\.json$/i.test(name)
    return compareVersion(m[1], ctx.version) === 0 && Boolean(keepKey) && name !== keepKey
  })

  const targets = [
    ...olderRemote.map((key) => ({ kind: 'remote', key })),
    ...extrasRemote.map((key) => ({ kind: 'remote', key })),
    ...ctx.scan.localFiles.map((file) => ({ kind: 'local', file })),
  ]
  if (!targets.length) return '没有需要清理的旧包'

  const failed = []
  let removed = 0

  t.spin = '删除中…'
  for (const item of targets) {
    const label = item.kind === 'remote' ? `图床 ${item.key}` : `本地 ${path.basename(item.file)}`
    try {
      if (item.kind === 'remote') await imgbedDelete(item.key)
      else await unlinkPackage(item.file)
      removed += 1
      t.details.push(label)
    } catch (e) {
      failed.push(`${label}: ${firstLine(e.message)}`)
    }
  }

  if (failed.length) {
    for (const line of failed.slice(0, 3)) t.details.push(line)
    if (failed.length > 3) t.details.push(`…另有 ${failed.length - 3} 项失败`)
    if (failed.length === targets.length) throw new Error('旧包清理全部失败（图床删除配额可能已耗尽）')
  }
  return failed.length ? `已删 ${removed} 个，失败 ${failed.length} 个` : `已删 ${removed} 个`
}

// ────────────────────────────── 主流程 ──────────────────────────────

let ui = null

async function main() {
  checkConfig()

  if (onlyDb) {
    addTask(() => '读取线上清单', async (t) => {
      const info = await readManifestRetry()
      if (!info.version) throw new Error('线上还没有清单，无法补更新 version_config')
      if (!info.updateUrl) throw new Error('线上清单缺少 update_url')
      ctx.version = info.version
      ctx.downloadUrl = info.updateUrl
      t.details.push(`线上 v${info.version}`)
      return `v${info.version}`
    })
    addTask(() => '更新云端 version_config', tUpdateDb)

    ui = new UI(tasks)
    ui.setHeader(['补写云端版本号（--only-db）', `清单 ${LATEST_URL}`])
    await runAll({ stopAfter: dryRun ? tasks[0] : null })
    finish()
    return
  }

  addTask(() => '预检配置与版本', tPreflight)
  const gate = addTask(() => '比对线上版本', tCompare)
  if (!skipBuild) addTask(() => '构建安装包', tBuild)
  addTask(() => (skipBuild ? '定位本地产物（校验指纹）' : '定位安装包'), tLocate)
  addTask(() => '上传安装包', tUpload)
  addTask(() => '发布 latest.json', tPublish)
  if (!noDb) addTask(() => '更新云端 version_config', tUpdateDb)
  if (makeTag) addTask(() => `推送标签 v${ctx.version}`, tTag, { soft: true })
  addTask(() => '清理旧版安装包', tCleanup, { soft: true })

  ui = new UI(tasks)
  ui.setHeader(
    [
      `发版${dryRun ? '（dry-run）' : ''}`,
      `图床 ${IMGBED_URL}`,
      `清单 ${LATEST_URL}`,
    ],
  )

  await runAll({ stopAfter: dryRun ? gate : null })
  finish()
}

async function runAll({ stopAfter = null } = {}) {
  let failure = null

  ui.start()
  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i]

    if (failure) {
      t.state = 'skip'
      t.note = '因上一步未通过而跳过'
      ui.render()
      if (PLAIN) printSettled(t, i)
      continue
    }

    t.state = 'running'
    t.startedAt = Date.now()
    ui.render()
    if (PLAIN) console.log(`[${i + 1}/${tasks.length}] ${titleOf(t)} … 开始`)

    try {
      t.note = (await t.run(t)) || '完成'
      t.state = 'ok'
    } catch (e) {
      if (e instanceof Abort) {
        t.state = 'abort'
        t.note = firstLine(e.message)
        failure = { task: t, error: e, abort: true }
      } else {
        t.state = 'fail'
        t.note = firstLine(e.message)
        // soft 任务（清理旧包）失败只提示，不拦住流程
        if (!t.soft) failure = { task: t, error: e, abort: false }
      }
    }
    t.endedAt = Date.now()

    ui.render()
    if (PLAIN) printSettled(t, i)

    if (!failure && stopAfter && t === stopAfter) {
      for (let j = i + 1; j < tasks.length; j += 1) {
        tasks[j].state = 'skip'
        tasks[j].note = 'dry-run 未执行'
      }
      ui.render()
      break
    }
  }
  ui.stop()

  return failure
}

function printSettled(t, i) {
  const mark =
    t.state === 'ok' ? SYM.ok : t.state === 'fail' ? SYM.fail : t.state === 'abort' ? SYM.abort : SYM.skip
  const dur = t.startedAt ? ` (${fmtDur((t.endedAt || Date.now()) - t.startedAt)})` : ''
  console.log(`[${i + 1}/${tasks.length}] ${titleOf(t)} ${mark} ${t.note}${dur}`)
  for (const d of clipDetails(t.details)) console.log(`        └ ${d}`)
}

function finish() {
  const hard = tasks.filter((t) => t.state === 'fail' && !t.soft)
  const soft = tasks.filter((t) => t.state === 'fail' && t.soft)
  const aborted = tasks.find((t) => t.state === 'abort')

  const lines = []
  if (hard.length) {
    const t = hard[0]
    lines.push(`${SYM.fail} 发版失败于「${titleOf(t)}」：${t.note}`)
    const name = titleOf(t)
    if (onlyDb) {
      lines.push('   补写 version_config 失败，检查数据库连接后重试 pnpm release --only-db')
    } else if (name.includes('latest.json')) {
      lines.push('   清单未发布成功，排查后直接重跑 pnpm release')
    } else if (name.includes('version_config')) {
      lines.push(`   清单已生效 v${ctx.version}，仅云端 version_config 未同步；执行 pnpm release --only-db 补上`)
    } else if (name.includes('上传')) {
      lines.push('   清单仍指向旧版本，客户端不受影响；排查后重跑')
    }
  } else if (aborted) {
    lines.push(`${SYM.abort} 已中止：${aborted.note}`)
  } else if (dryRun) {
    const stopped = tasks.some((t) => t.state === 'skip' && t.note === 'dry-run 未执行')
    lines.push(
      stopped
        ? `${SYM.ok} dry-run 结束，未做任何改动`
        : `${SYM.warn} dry-run 标记已失效但流程已跑完，请检查脚本`,
    )
  } else if (onlyDb) {
    lines.push(`${SYM.ok} 云端 version_config 已更新 v${ctx.version}`)
  } else {
    lines.push(`${SYM.ok} 发版完成 v${ctx.version}`)
    if (ctx.downloadUrl) lines.push(`   安装包: ${ctx.downloadUrl}`)
    lines.push(`   清单:   ${LATEST_URL}`)
    for (const s of soft) {
      lines.push(`   ${SYM.warn} 「${titleOf(s)}」未完成，不影响本次发版`)
    }
  }

  for (const l of lines) console.log(`\n${l}`)
  process.exitCode = hard.length ? 1 : 0
}

process.on('SIGINT', () => {
  ui?.stop()
  killTree(ctx.child)
  process.stdout.write('\n')
  console.error(`${SYM.abort} 已中断（Ctrl+C）`)
  process.exit(130)
})

main().catch((e) => {
  ui?.stop()
  console.error(`\n${SYM.fail} 发版失败: ${e.message}`)
  // 用 exitCode 而不是 process.exit，让子进程/句柄自然收尾
  process.exitCode = 1
})
