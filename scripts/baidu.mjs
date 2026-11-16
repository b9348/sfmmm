/**
 * 百度网盘 bdpan CLI 启动器（免申请官方 CLI，能力来自 baidu-drive skill）。
 *
 *   pnpm baidu install   # 下载官方安装器（SHA256 校验）安装 bdpan.exe
 *   pnpm baidu login     # 浏览器 OOB 授权（32 位授权码回填 stdin）
 *   pnpm baidu whoami    # 查看登录态
 *
 * 全程原生调用（安装器/CLI 均支持 Windows），不依赖 bash。
 * 落点固定 /apps/bdpan/（网盘里显示为「我的应用数据 > bdpan」），
 * Token 由 CLI 自动续期，登录态在 ~/.config/bdpan/config.json（含 Token，绝不入库）。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { chmod, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VENDOR = path.join(HERE, 'vendor', 'baidu')
const REPO = path.resolve(HERE, '..')

// 安装器版本与官方 install.sh 保持同步（scripts/vendor/baidu/bdpan-scripts/install.sh）
const INSTALLER_VERSION = '3.8.4'
const INSTALLER_SHA256 = '194f5174bbb3d9260cc5b7d465c4f98d6b9279e028db136dc1e57cc3bc1f49a0'
const CDN_BASE = `https://issuecdn.baidupcs.com/issue/netdisk/ai-bdpan/installer/${INSTALLER_VERSION}`

function findBdpan() {
  const candidates = [
    process.env.SFMMM_BAIDU_EXE,
    path.join(VENDOR, 'bin', 'bdpan.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'bdpan', 'bdpan.exe'),
    path.join(os.homedir(), '.local', 'bin', 'bdpan'),
  ].filter(Boolean)
  return candidates.find((c) => existsSync(c)) || null
}

const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl'

function curlTo(file, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(CURL, ['-fSL', '--retry', '3', '--retry-delay', '2', '-o', file, url], { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`curl 下载失败（退出码 ${code}）`))))
  })
}

// 安装器 ~15MB，同步读一次即可，无需流式
function sha256Sync(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref?.()
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref?.()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref?.()
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a) }))
}

async function cmdInstall() {
  const osType = os.type()
  const platform = osType === 'Windows_NT' ? 'windows' : osType === 'Darwin' ? 'darwin' : 'linux'
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
  const name = `bdpan-installer-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`
  const url = `${CDN_BASE}/${name}`
  const tmp = path.join(os.tmpdir(), name)

  console.log(`下载 bdpan 安装器 v${INSTALLER_VERSION}（${platform}-${arch}）…`)
  await curlTo(tmp, url)

  const actual = sha256Sync(tmp)
  if (actual !== INSTALLER_SHA256) {
    await unlink(tmp).catch(() => {})
    console.error(`SHA256 校验失败，文件可能被篡改：\n  期望 ${INSTALLER_SHA256}\n  实际 ${actual}`)
    process.exit(1)
  }
  if (platform !== 'windows') await chmod(tmp, 0o755).catch(() => {})

  console.log('校验通过，开始安装…')
  const r = spawnSync(tmp, ['--yes'], { stdio: 'inherit' })
  await unlink(tmp).catch(() => {})

  const exe = findBdpan()
  if (r.status !== 0 || !exe) {
    console.error('安装失败或未找到 bdpan 可执行文件')
    process.exit(1)
  }
  const v = spawnSync(exe, ['version'], { encoding: 'utf8' })
  console.log(`✓ bdpan 安装成功：${exe}\n${(v.stdout || '').trim().split('\n')[0]}`)
}

async function cmdLogin() {
  const exe = findBdpan()
  if (!exe) {
    console.error('尚未安装 bdpan CLI：请先执行 pnpm baidu install')
    process.exit(1)
  }

  // OOB 授权：CLI 打印授权链接 → 浏览器登录拿 32 位授权码 → 经 stdin 传回（不进进程参数）
  const urlRes = spawnSync(exe, ['login', '--get-auth-url', '--accept-disclaimer'], { encoding: 'utf8' })
  const authUrl = (urlRes.stdout || '').trim()
  if (urlRes.status !== 0 || !authUrl) {
    console.error(`获取授权链接失败：${(urlRes.stderr || urlRes.stdout || '').trim().slice(0, 300)}`)
    process.exit(1)
  }
  console.log(`\n请在浏览器打开以下地址完成登录（链接约 10 分钟有效）：\n  ${authUrl}\n`)
  openBrowser(authUrl)

  const code = await ask('请输入浏览器中显示的 32 位授权码: ')
  if (!/^[a-fA-F0-9]{32}$/.test(code.trim())) {
    console.error('授权码格式不正确（应为 32 位十六进制字符）')
    process.exit(1)
  }
  const r = spawnSync(exe, ['login', '--set-code-stdin', '--accept-disclaimer'], {
    input: `${code.trim()}\n`,
    encoding: 'utf8',
  })
  if (r.status !== 0) {
    console.error(`登录失败：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
    process.exit(1)
  }
  console.log((r.stdout || '授权成功').trim())
}

function runPassthrough(args) {
  const exe = findBdpan()
  if (!exe) {
    console.error('尚未安装 bdpan CLI：请先执行 pnpm baidu install')
    process.exit(1)
  }
  const child = spawn(exe, args, { stdio: 'inherit' })
  child.on('error', (e) => {
    console.error(`无法启动 bdpan CLI：${e.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'install') await cmdInstall()
else if (cmd === 'login') await cmdLogin()
else if (cmd) runPassthrough([cmd, '--no-check-update', ...rest])
else {
  console.error('用法：pnpm baidu <install|login|whoami|quota>')
  process.exit(2)
}
