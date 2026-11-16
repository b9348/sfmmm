/**
 * 本地发版（替代 GitHub Actions 的 release.yml）：
 *   比对版本 → 构建 NSIS 安装包 → 上传图床 → 发布 latest.json → 同步夸克网盘 → 更新云端 version_config（HK 服务端 + 源库） → 清理旧包
 *
 * 用法（仓库根目录）：
 *   pnpm release                       # 本地版本高于线上才发版，相等/落后直接中止
 *   pnpm release --dry-run             # 只跑到版本比对，打印后续将做什么
 *   pnpm release --skip-build          # 跳过构建，复用 target 里本版本的安装包（校验构建指纹）
 *   pnpm release --no-db               # 跳过云端 version_config（HK 与源库都不写）
 *   pnpm release --no-src-db           # 只跳过源库 version_config，仍写 HK 服务端
 *   pnpm release --tag                 # 额外创建并推送 v{version} 标签
 *   pnpm release --force               # 线上版本相同时也强制重发
 *   pnpm release --force-online-unreachable  # 读不到线上清单时仍继续（危险）
 *   pnpm release --only-db             # 故障恢复：只按线上清单补更新 version_config（HK + 源库）
 *   pnpm release --only-quark          # 故障恢复：只把本地安装包补传夸克网盘
 *   pnpm release --keep-old=1          # 清理旧包时保留最近 1 个旧版本
 *   pnpm release --no-quark            # 跳过上传夸克网盘 sfmmm 目录
 *   pnpm release --only-baidu          # 故障恢复：只把本地安装包补传百度网盘
 *   pnpm release --no-baidu            # 跳过上传百度网盘
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
 * 安装包发布成功后会再传一份到夸克网盘根目录的 sfmmm 文件夹（备用下载渠道），
 * 走内置的 scripts/vendor/quark/ 官方 CLI；第一次用需先 `pnpm quark login` 授权。
 * 百度网盘同理：免申请的官方 bdpan CLI（vendor 在 scripts/vendor/baidu/），
 * 落点「我的应用数据 > bdpan > sfmmm」（官方沙盒限制）；首次使用 pnpm baidu install +
 * pnpm baidu login（浏览器 OOB 授权）。
 *
 * 任何非清理步骤失败都会中止后续步骤（不再让镜像失败后继续写库/清理）；
 * 不需要镜像渠道时用 --no-quark / --no-baidu 显式跳过。
 *
 * 配置全部取自本地文件或环境变量：
 *   src-tauri/.env → IMGBED_URL（仅发布脚本拼公开直链用）、DB_URL（源库直连地址，用于更新源库 version_config；可用 SFMMM_SRC_DB_URL 覆盖）
 *   SFMMM_CLOUD_ENV → 指向 AxumVue 仓**根目录**的 .env（服务端已上移到仓根，不再是 server/.env），
 *                     取 PUBLIC_BASE_URL / ADMIN_TOKEN / SFMMM_RELEASE_BASE / R2_*
 *                     （也可直接用同名环境变量 SFMMM_RELEASE_BASE / SFMMM_ADMIN_TOKEN / R2_* 提供）
 *   .env           → VITE_LATEST_URL（构建时注入前端，同时作为清单回读地址）
 */

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { META_SUFFIX, fingerprint, readBuildMeta } from './build-meta.mjs'
import mysql from 'mysql2/promise'
import { createR2Store } from './r2-store.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const TAURI_DIR = path.join(ROOT, 'src-tauri')
// 服务端（AxumVue）已是独立仓库：不再按固定路径读 server/.env，
// 由 SFMMM_CLOUD_ENV 指向那份配置；未设置则视为没有该文件，改用同名环境变量。
const CLOUD_ENV_FILE = String(process.env.SFMMM_CLOUD_ENV || '').trim()
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
const noSrcDb = has('--no-src-db')
const makeTag = has('--tag')
const force = has('--force')
const forceOnlineUnreachable = has('--force-online-unreachable')
const onlyDb = has('--only-db')
const onlyQuark = has('--only-quark')
const noQuark = has('--no-quark')
const onlyBaidu = has('--only-baidu')
const noBaidu = has('--no-baidu')
const verbose = has('--verbose')
const keepOld = Number(argValue('--keep-old') ?? 0)

// 哪些镜像步骤会真的执行：--only-* 只跑其一，--no-* 显式关闭。
// 预检与主流程共用这一份判断，避免「预检放过了、实跑却失败」。
const wantQuark = onlyQuark || (!onlyDb && !onlyBaidu && !noQuark)
const wantBaidu = onlyBaidu || (!onlyDb && !onlyQuark && !noBaidu)

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
const serverEnv = CLOUD_ENV_FILE ? readEnvFile(CLOUD_ENV_FILE) : {}
const webEnv = readEnvFile(path.join(ROOT, '.env'))

const IMGBED_URL = (tauriEnv.IMGBED_URL || '').replace(/\/+$/, '')
// 发版上传/删除走管理网关（admin 域名）：网关校验 X-Admin-Token 后注入图床令牌，
// 构建机不接触图床长期令牌，图床也不对公网开放写接口。
// 网关地址只从环境读取，不在仓库里写死真实域名。
const RELEASE_BASE = String(process.env.SFMMM_RELEASE_BASE || serverEnv.SFMMM_RELEASE_BASE || '').replace(/\/+$/, '')
const ADMIN_TOKEN = process.env.SFMMM_ADMIN_TOKEN || serverEnv.ADMIN_TOKEN || ''
// 服务端网关基址：拆库后不再从 server/.env 读，改由 SFMMM_PUBLIC_BASE_URL 或 SFMMM_CLOUD_ENV 提供
const PUBLIC_BASE_URL = String(process.env.SFMMM_PUBLIC_BASE_URL || serverEnv.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
// R2 直传：构建机配了 R2_* 时，安装包/清单/清理直接走 S3 API 写桶，
// 文件本体不经服务器（网关只在小版本不支持直传时兜底）。
const r2Store = createR2Store({
  endpoint: String(process.env.R2_ENDPOINT || tauriEnv.R2_ENDPOINT || serverEnv.R2_ENDPOINT || '').trim(),
  bucket: String(process.env.R2_BUCKET || tauriEnv.R2_BUCKET || serverEnv.R2_BUCKET || '').trim(),
  accessKeyId: String(process.env.R2_ACCESS_KEY_ID || tauriEnv.R2_ACCESS_KEY_ID || serverEnv.R2_ACCESS_KEY_ID || '').trim(),
  secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || tauriEnv.R2_SECRET_ACCESS_KEY || serverEnv.R2_SECRET_ACCESS_KEY || '').trim(),
})
const LATEST_URL = webEnv.VITE_LATEST_URL || (IMGBED_URL ? `${IMGBED_URL}/file/sfm/installer/latest.json` : '')
// 源库（旧客户端直连的 MySQL）连接串；只用于发版时同步 version_config，不参与构建。
const SRC_DB_URL = String(process.env.SFMMM_SRC_DB_URL || tauriEnv.DB_URL || '').trim()
const DB_TLS1 = String(process.env.DB_TLS1 || tauriEnv.DB_TLS1 || '').trim().toLowerCase()

// 夸克网盘镜像：内置官方 CLI，登录态由 CLI 自己存在 scripts/vendor/<渠道>/config.json（已 gitignore）
const QUARK_CLI = process.env.SFMMM_QUARK_CLI || path.join(ROOT, 'scripts', 'vendor', 'quark', 'quark-drive.cjs')
const QUARK_DIR = process.env.SFMMM_QUARK_DIR || 'sfmmm'
// 夸克 SDK 的 clientInfo 不入库：环境变量优先，其次 src-tauri/.env（内置 CLI 从这两个变量读取）
const QUARK_CLIENT_ID = process.env.QUARK_CLIENT_ID || tauriEnv.QUARK_CLIENT_ID || ''
const QUARK_SIGN_KEY = process.env.QUARK_SIGN_KEY || tauriEnv.QUARK_SIGN_KEY || ''
// --session-id 只用于服务端质量追踪，同一次发版复用同一个
const QUARK_SESSION_INPUT = 'pnpm release 自动上传安装包到夸克网盘'
const QUARK_SESSION_ID = `${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 8)}`

// 百度网盘镜像：免申请的官方 bdpan CLI（baidu-drive skill 能力，vendor 在 scripts/vendor/baidu/）。
// 落点 /apps/bdpan/<BAIDU_DIR>/，网盘里显示为「我的应用数据 > bdpan > sfmmm」（官方沙盒限制，到不了根目录）。
// 登录态在 ~/.config/bdpan/（CLI 默认，已 gitignore 不可入库）；pnpm baidu install/login 完成初始化。
const BAIDU_EXE =
  process.env.SFMMM_BAIDU_EXE ||
  [path.join(ROOT, 'scripts', 'vendor', 'baidu', 'bin', 'bdpan.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'bdpan', 'bdpan.exe'),
    path.join(os.homedir(), '.local', 'bin', 'bdpan')].find(existsSync) ||
  path.join(ROOT, 'scripts', 'vendor', 'baidu', 'bin', 'bdpan.exe')
const BAIDU_DIR = process.env.SFMMM_BAIDU_DIR || 'sfmmm'
const BAIDU_SESSION_INPUT = 'pnpm release 自动上传安装包到百度网盘'
const BAIDU_SESSION_ID = QUARK_SESSION_ID

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
 * 调夸克 CLI 并解析 NDJSON：CLI 每条进度/结果都是一行 JSON。
 * 返回最后一条 type=result 的行；进程退出码或行内 code 非 0 都按失败处理。
 */
function runQuark(args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [QUARK_CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // CLI 会按「当前 Agent 渠道」隔离登录态，认不出来就直接拒绝运行（-104）；
      // 固定成 workbuddy，普通终端里跑发版也能复用同一份 config.json
      env: {
        ...process.env,
        WORKBUDDY_CONFIG_DIR: path.join(path.dirname(QUARK_CLI), 'workbuddy'),
        QUARK_CLIENT_ID,
        QUARK_SIGN_KEY,
      },
    })
    let buf = ''
    let stderr = ''
    let last = null
    const handleLine = (line) => {
      const s = line.trim()
      if (!s.startsWith('{')) return
      let msg
      try {
        msg = JSON.parse(s)
      } catch {
        return
      }
      if (msg.type === 'result') last = msg
      onLine?.(msg)
    }
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (buf) handleLine(buf)
      if (code !== 0) return reject(new Error(`夸克 CLI 退出码 ${code}${stderr ? `：${firstLine(stderr)}` : ''}`))
      if (!last) return reject(new Error('夸克 CLI 没有返回结果（登录态可能失效）'))
      if (last.code !== 0) return reject(new Error(`夸克：${last.msg || `错误码 ${last.code}`}`))
      resolve(last)
    })
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
  if (r2Store.enabled) {
    await r2Store.delete(key)
    return { existed: true }
  }
  const text = await curl([
    `${RELEASE_BASE}/release/delete/${key}`,
    '-H',
    `X-Admin-Token: ${ADMIN_TOKEN}`,
  ])
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
  // R2 同名 put 是原子覆盖，不会出现 latest(1).json；只有旧网关路径需要先删。
  if (r2Store.enabled) return
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

/**
 * 发版网关的 upload 路由只匹配「恰好三段」的路径（如 sfm/installer/v1.0.0），
 * 两段目录（sfm/installer）会落到静态处理器，POST 返回 405 空响应。
 * 两段目录补一个 %5C 尾段：网关按三段收下，图床再把反斜杠归一化掉，
 * 落点仍是原目录、文件名不变（manifest 必须命中固定的 latest.json）。
 */
const DEPTH_PAD_SEGMENT = '%5C'

async function postUpload(filePath, folder) {
  return curl([
    '-X',
    'POST',
    `${RELEASE_BASE}/release/upload/${folder}`,
    '-H',
    `X-Admin-Token: ${ADMIN_TOKEN}`,
    '-F',
    `file=@${filePath}`,
  ])
}

async function imgbedUpload(filePath, folder) {
  if (r2Store.enabled) {
    const key = `${folder}/${path.basename(filePath)}`.replace(/\/{2,}/g, '/')
    await r2Store.put(filePath, key)
    return `${IMGBED_URL}/file/${key}`
  }
  // 命名方式由网关固定为 origin（保留原文件名），清单和安装包都依赖原文件名
  let text = await postUpload(filePath, folder)

  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    // 网关多段路由只认三段路径：两段目录按历史方式会 405，补段重试一次
    if (folder.split('/').filter(Boolean).length === 2) {
      text = await postUpload(filePath, `${folder}/${DEPTH_PAD_SEGMENT}`)
      try {
        data = JSON.parse(text)
      } catch {
        /* 仍非法则走下面统一报错 */
      }
    }
  }

  if (!data) throw new Error(`图床上传返回非 JSON: ${text.slice(0, 300)}`)
  const raw = Array.isArray(data) ? data[0]?.src : data?.src
  if (!raw) throw new Error(`图床上传返回缺少 src: ${text.slice(0, 300)}`)
  // 图床按请求 Host 生成链接（http），统一收敛到公开 HTTPS 地址
  const key = raw.split('/file/')[1]
  return key ? `${IMGBED_URL}/file/${key}` : raw
}

async function listRemote(prefix, opts) {
  if (r2Store.enabled) return r2Store.list(prefix)
  const url = `${RELEASE_BASE}/release/list`
  const text = await curl([url, '-H', `X-Admin-Token: ${ADMIN_TOKEN}`], opts)
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
  if (!IMGBED_URL) {
    throw new Error('缺少图床公开地址：请在 src-tauri/.env 配置 IMGBED_URL')
  }
  if (!RELEASE_BASE) {
    throw new Error('缺少发版网关地址：请用 SFMMM_CLOUD_ENV 指向 AxumVue 仓根目录的 .env（其中含 SFMMM_RELEASE_BASE），或直接设同名环境变量')
  }
  if (!ADMIN_TOKEN) {
    throw new Error('缺少发版网关令牌：请用 SFMMM_CLOUD_ENV 指向 AxumVue 仓根目录的 .env（其中含 ADMIN_TOKEN），或设 SFMMM_ADMIN_TOKEN')
  }
  if (!noDb && !dryRun && (!ADMIN_TOKEN || !PUBLIC_BASE_URL)) {
    throw new Error('缺少服务端配置：请设置 SFMMM_PUBLIC_BASE_URL / SFMMM_ADMIN_TOKEN（或用 --no-db 跳过）')
  }
  if (!noDb && !noSrcDb && !dryRun) {
    if (!SRC_DB_URL) {
      throw new Error('缺少源库连接：请在 src-tauri/.env 配置 DB_URL（或用 --no-src-db 只写 HK 服务端）')
    }
    sourceDbConfig()
  }
  if (!LATEST_URL) {
    throw new Error('缺少版本清单地址：请在根目录 .env 配置 VITE_LATEST_URL')
  }
}

/**
 * 镜像渠道缺凭据/缺 CLI 属于配置错误，要在预检就中止：
 * 等构建 + 11 MB 上传 + 清单发布完成才报错，等于白跑一遍还留下半截发版。
 */
function checkMirrors() {
  if (wantQuark) {
    if (!existsSync(QUARK_CLI)) throw new Error(`缺少夸克 CLI：${path.relative(ROOT, QUARK_CLI)}`)
    if (!QUARK_CLIENT_ID || !QUARK_SIGN_KEY) {
      throw new Error(
        '缺少 QUARK_CLIENT_ID / QUARK_SIGN_KEY：请在 src-tauri/.env 中配置（或用 --no-quark 跳过夸克镜像）',
      )
    }
  }
  if (wantBaidu && !existsSync(BAIDU_EXE)) {
    throw new Error(
      '尚未安装 bdpan CLI：请先执行 pnpm baidu install（或设 SFMMM_BAIDU_EXE 指向 bdpan.exe），或用 --no-baidu 跳过百度镜像',
    )
  }
}

async function tPreflight(t) {
  checkConfig()
  checkMirrors()

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

/**
 * 安装包同时在夸克网盘留一份备用下载。文件名自带版本号，不会与旧版本重名；
 * 旧版本按约定不清理（夸克 CLI 没有删除命令）。
 */
async function tQuarkUpload(t) {
  if (!existsSync(QUARK_CLI)) throw new Error(`缺少夸克 CLI：${path.relative(ROOT, QUARK_CLI)}`)
  if (!QUARK_CLIENT_ID || !QUARK_SIGN_KEY) {
    throw new Error('缺少 QUARK_CLIENT_ID / QUARK_SIGN_KEY：请在 src-tauri/.env 中配置')
  }
  const common = ['--session-input', QUARK_SESSION_INPUT, '--session-id', QUARK_SESSION_ID]

  t.spin = '定位网盘目录…'
  // create-folder 对同名目录幂等：已存在时直接返回它的 FID，不用先 browse 再判断
  const dir = await runQuark(['create-folder', '--dir-path', QUARK_DIR, '--parent-fid', '0', ...common])
  const fid = dir.data?.fid
  if (!fid) throw new Error('未能解析出网盘目录 FID')
  t.details.push(`目录：${dir.data?.full_path || QUARK_DIR}`)

  const size = fmtSize((await stat(ctx.installer)).size)
  t.spin = '上传中 0%'
  let shown = -1
  const res = await runQuark(['upload', ctx.installer, '--parent-fid', fid, ...common], (msg) => {
    const pct = msg.type === 'progress' ? msg.data?.percent : null
    if (typeof pct === 'number' && pct !== shown) {
      shown = pct
      t.spin = `上传中 ${pct}%`
      ui?.render()
    }
  })

  const data = res.data || {}
  t.details.push(`${path.basename(ctx.installer)}（${size}）`)
  if (data.fullPath) t.details.push(`网盘路径：${data.fullPath}`)
  return data.instantUpload ? '秒传完成' : '上传完成'
}

/**
 * 调官方 bdpan CLI 上传。`--json` 时 stdout 是单个 {code,data,error} 信封；
 * 人读进度走 stderr。未登录返回非 0 → 交给 tBaiduUpload 引导授权。
 */
function runBaidu(args, { interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(BAIDU_EXE, args, {
      cwd: ROOT,
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    if (!interactive) {
      child.stdout.on('data', (d) => (out += d))
    }
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`bdpan 退出码 ${code}${out.trim() ? `：${firstLine(out)}` : ''}`))
      if (interactive) return resolve(null)
      let data
      try {
        data = JSON.parse(out)
      } catch {
        return reject(new Error(`bdpan 输出非 JSON：${out.trim().slice(0, 200)}`))
      }
      // upload/rm 返回 {code,data,error} 信封；whoami 直接返回裸对象，没有 code 字段，
      // 不能把「缺失」当成非 0 错误码（否则未登录检查会被误报成 bdpan 错误码 undefined）
      if (data.code !== undefined && data.code !== 0) {
        return reject(new Error(data.error || `bdpan 错误码 ${data.code}`))
      }
      resolve(data)
    })
  })
}

/** 登录态校验 + 未登录时引导 OOB 授权（浏览器登录后回填 32 位授权码） */
async function ensureBaiduLogin() {
  // whoami 未登录也返回退出码 0，需按 has_valid_token 判断（且输出是裸对象，不在 data 里）
  const check = async () => {
    const res = await runBaidu(['whoami', '--json', '--no-check-update'])
    return (res.data ?? res).has_valid_token === true
  }
  if (await check()) return
  await run(process.execPath, [path.join(ROOT, 'scripts', 'baidu.mjs'), 'login'], ROOT)
  if (!(await check())) throw new Error('百度网盘授权未完成，请重新执行 pnpm release 或手动 pnpm baidu login')
}

/**
 * 安装包同时在百度网盘留一份备用下载，落点 /apps/bdpan/sfmmm/<安装包名>，
 * 网盘里显示为「我的应用数据 > bdpan > sfmmm」。
 * 失败会中止后续步骤（可用 --no-baidu 跳过）。文件名自带版本号，不会重名；旧版本按约定保留不清理。
 */
async function tBaiduUpload(t) {
  if (!existsSync(BAIDU_EXE)) {
    throw new Error('尚未安装 bdpan CLI：请先执行 pnpm baidu install（或设 SFMMM_BAIDU_EXE 指向 bdpan.exe）')
  }

  t.spin = '校验登录态…'
  await ensureBaiduLogin()

  const size = fmtSize((await stat(ctx.installer)).size)
  const remote = `${BAIDU_DIR}/${path.basename(ctx.installer)}`
  t.spin = '上传中…'
  const res = await runBaidu([
    'upload', ctx.installer, remote,
    '--json', '--overwrite', '--no-check-update',
    '--agentname', 'workbuddy',
    '--session-input', BAIDU_SESSION_INPUT,
    '--session-id', BAIDU_SESSION_ID,
  ])

  const data = res.data || {}
  t.details.push(`${path.basename(ctx.installer)}（${size}）`)
  t.details.push(`网盘路径：我的应用数据/bdpan/${remote}`)
  if (data.saved_path) t.details.push(`保存位置：${data.saved_path}`)
  return '上传完成'
}

function sourceDbConfig() {
  if (!SRC_DB_URL) throw new Error('缺少源库连接：请在 src-tauri/.env 配置 DB_URL')
  if (SRC_DB_URL.startsWith('dsn1:') || SRC_DB_URL.startsWith('sec1:')) {
    throw new Error('源库 DB_URL 是加密存储的（dsn1:/sec1: 前缀），发版脚本只支持明文 mysql:// 连接串')
  }
  let dsn
  try {
    dsn = new URL(SRC_DB_URL)
  } catch {
    throw new Error('源库 DB_URL 不是合法连接串，期望 mysql://user:password@host:port/database')
  }
  if (dsn.protocol !== 'mysql:') throw new Error(`源库 DB_URL 协议不支持：${dsn.protocol}`)
  const database = decodeURIComponent(dsn.pathname.replace(/^\//, ''))
  if (!database) throw new Error('源库 DB_URL 里没有数据库名')
  return {
    host: dsn.hostname,
    port: Number(dsn.port || 3306),
    user: decodeURIComponent(dsn.username),
    password: decodeURIComponent(dsn.password),
    database,
    connectTimeout: 10000,
    charset: 'utf8mb4',
    ...(DB_TLS1 === '1' || DB_TLS1 === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
  }
}

/** 与 server/src/db/update_db.rs 的 db_set_version_config 保持同一语义。 */
async function updateSourceVersionConfig() {
  const cfg = sourceDbConfig()
  const label = `${cfg.host}:${cfg.port}/${cfg.database}`
  const sql =
    'INSERT INTO version_config (id, version, update_url) VALUES (1, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE version = VALUES(version), update_url = VALUES(update_url), updated_at = CURRENT_TIMESTAMP'
  const retryable = new Set(['ER_USER_LIMIT_REACHED', 'ETIMEDOUT', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST'])
  let lastErr = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let conn = null
    try {
      conn = await mysql.createConnection(cfg)
      await conn.execute(sql, [ctx.version, ctx.downloadUrl])
      return label
    } catch (e) {
      lastErr = e
      if (!retryable.has(e.code)) break
    } finally {
      if (conn) await conn.end().catch(() => {})
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  throw new Error(
    `源库 ${label} 写入失败：${lastErr?.code ? `${lastErr.code} ` : ''}${firstLine(lastErr?.message || '未知错误')}`,
  )
}

async function tUpdateDb(t) {
  const logPath = path.join(TARGET_DIR, `release-db-${ctx.logStamp}.log`)
  t.spin = '写库中…'
  if (!verbose) t.details.push(`日志：${path.relative(ROOT, logPath)}`)
  const base = PUBLIC_BASE_URL
  const url = `${base}/api/user/rpc/admin_set_version`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': ADMIN_TOKEN,
        // 版本门禁要求 UA 为 sfmmm/<version>（client_gate），脚本以本次发版版本自报
        'User-Agent': `sfmmm/${ctx.version} (release-script)`,
      },
      body: JSON.stringify({ version: ctx.version, update_url: ctx.downloadUrl }),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    await mkdir(TARGET_DIR, { recursive: true })
    await writeFile(logPath, `POST ${url}\nHTTP ${res.status}\n${text}\n`, 'utf8')
    if (!res.ok) {
      throw new Error(`写库失败：HTTP ${res.status} ${text.slice(0, 300)}`)
    }
  } catch (e) {
    const { tail } = await describeBuildFailure(logPath)
    for (const line of tail) t.details.push(line)
    throw e
  }
  t.details.push('HK 服务端 version_config 已更新')
  if (noSrcDb) {
    t.details.push('源库 version_config 已跳过（--no-src-db）')
    return 'HK 已同步，源库跳过'
  }
  const label = await updateSourceVersionConfig()
  t.details.push(`源库 ${label} version_config 已更新`)
  return 'HK 与源库已同步'
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
    addTask(() => `更新云端 version_config（${noSrcDb ? '仅 HK' : 'HK + 源库'}）`, tUpdateDb)

    ui = new UI(tasks)
    ui.setHeader(['补写云端版本号（--only-db）', `清单 ${LATEST_URL}`])
    await runAll({ stopAfter: dryRun ? tasks[0] : null })
    finish()
    return
  }

  if (onlyQuark) {
    addTask(() => '预检配置与版本', tPreflight)
    addTask(() => (skipBuild ? '定位本地产物（校验指纹）' : '定位安装包'), tLocate)
    addTask(() => `上传夸克网盘 ${QUARK_DIR}/`, tQuarkUpload, { id: 'quark' })

    ui = new UI(tasks)
    ui.setHeader(['只补传夸克网盘（--only-quark）', `目录 ${QUARK_DIR}/`])
    await runAll({ stopAfter: dryRun ? tasks[1] : null })
    finish()
    return
  }

  if (onlyBaidu) {
    addTask(() => '预检配置与版本', tPreflight)
    addTask(() => (skipBuild ? '定位本地产物（校验指纹）' : '定位安装包'), tLocate)
    addTask(() => `上传百度网盘 ${BAIDU_DIR}/`, tBaiduUpload, { id: 'baidu' })

    ui = new UI(tasks)
    ui.setHeader(['只补传百度网盘（--only-baidu）', `目录 我的应用数据/${BAIDU_DIR}/`])
    await runAll({ stopAfter: dryRun ? tasks[1] : null })
    finish()
    return
  }

  addTask(() => '预检配置与版本', tPreflight)
  const gate = addTask(() => '比对线上版本', tCompare)
  if (!skipBuild) addTask(() => '构建安装包', tBuild)
  addTask(() => (skipBuild ? '定位本地产物（校验指纹）' : '定位安装包'), tLocate)
  addTask(() => '上传安装包', tUpload, { id: 'upload' })
  addTask(() => '发布 latest.json', tPublish, { id: 'publish' })
  if (wantQuark) addTask(() => `上传夸克网盘 ${QUARK_DIR}/`, tQuarkUpload, { id: 'quark' })
  if (wantBaidu) addTask(() => `上传百度网盘 ${BAIDU_DIR}/`, tBaiduUpload, { id: 'baidu' })
  if (!noDb) addTask(() => `更新云端 version_config（${noSrcDb ? '仅 HK' : 'HK + 源库'}）`, tUpdateDb, { id: 'db' })
  if (makeTag) addTask(() => `推送标签 v${ctx.version}`, tTag)
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
    if (onlyDb) {
      lines.push('   补写 version_config 失败，检查 HK 服务端 / 源库连接后重试 pnpm release --only-db')
    } else if (t.id === 'publish') {
      lines.push('   清单未发布成功，排查后直接重跑 pnpm release')
    } else if (t.id === 'db') {
      lines.push(`   清单已生效 v${ctx.version}，但 version_config 未全部同步（HK / 源库）；执行 pnpm release --only-db 补上`)
      if (!noSrcDb) lines.push('   源库连接数长期占满时，可先用 --no-src-db 只写 HK，或提高 SQLPub 的 max_user_connections')
    } else if (t.id === 'upload') {
      lines.push('   清单仍指向旧版本，客户端不受影响；排查后重跑')
    } else if (t.id === 'quark' || t.id === 'baidu') {
      const flag = t.id === 'quark' ? '--only-quark' : '--only-baidu'
      if (onlyQuark || onlyBaidu) {
        lines.push(`   排查后重跑 pnpm release ${flag}`)
      } else {
        lines.push(`   主更新源已生效 v${ctx.version}，只差这个镜像渠道；修好后执行 pnpm release ${flag} 补传`)
        lines.push('   后续步骤已按失败即停跳过，不影响客户端更新')
      }
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
    lines.push(`${SYM.ok} 云端 version_config 已更新 v${ctx.version}（${noSrcDb ? '仅 HK' : 'HK + 源库'}）`)
  } else if (onlyQuark || onlyBaidu) {
    lines.push(`${SYM.ok} 镜像补传完成 v${ctx.version}（清单未改动）`)
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
