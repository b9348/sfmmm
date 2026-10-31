#!/usr/bin/env node
/**
 * 一次性清理图床孤儿文件（默认 dry-run，只打印报告，不动任何文件）。
 *
 * 背景：历史上编辑/删除帖子不会清理图床，导致大量无引用文件。
 * 运行时新逻辑已接管增量清理，这个脚本负责存量。
 *
 * 依赖：本机 `mysql` CLI 与 `curl`（Windows 10+ 自带）。
 * 配置：读取 src-tauri/.env 的 DB_URL / DB_ENC_KEY / IMGBED_URL / IMGBED_TOKEN。
 *
 * 用法：
 *   node scripts/cleanup-imgbed-orphans.mjs
 *   node scripts/cleanup-imgbed-orphans.mjs --categories=packages,installers --delete --yes
 *   node scripts/cleanup-imgbed-orphans.mjs --categories=packages,installers,comment-images,description-images,discussion-images
 *
 * 选项：
 *   --categories=a,b,c  默认 packages,installers（保守）。可选：
 *                       packages / installers / comment-images / description-images /
 *                       discussion-images / other-images / misc
 *   --delete            真正执行删除（必须配合 --yes 或交互输入 DELETE）
 *   --yes               跳过交互确认
 *   --limit=N           最多删除 N 个（抽样验证用）
 *   --out=path          把完整报告写成 JSON
 *   --proxy=URL         代理地址，默认 http://127.0.0.1:7890
 *   --no-proxy          不走代理
 *   --force             候选超过总数 70% 时仍继续（默认中止）
 */

import { spawn, spawnSync } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CATEGORIES = ['packages', 'installers']
const ALL_CATEGORIES = [
  'packages', 'installers', 'comment-images', 'description-images',
  'discussion-images', 'other-images', 'misc',
]
const ARCHIVE_RE = /\.(zip|7z|rar)$/i
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i
// 图床文件 key（不含 file/ 前缀）：URL 中的 /file/<key> 或正文里直接出现的裸路径
const REF_RE = /(?:https?:\/\/[^\s"'<>()\]]+\/file\/(sfm(?:mm)?\/[^\s"'<>()\]]+))|(?:\b(sfm(?:mm)?\/[^\s"'<>()\]]+))/g
// 运行时也依赖这些目录/文件，禁止脚本删除（仓库静态扫描之外的兜底）
const STATIC_WHITELIST_PREFIXES = [
  'sfm/thanks/',
  'sfm/BepInEx/',
  'sfm/BepInEx6/',
  'sfm/installer/latest.json',
]

// ────────────────────────────── 参数与环境 ──────────────────────────────

function parseArgs(argv) {
  const opts = {
    categories: DEFAULT_CATEGORIES,
    delete: false,
    yes: false,
    limit: Infinity,
    out: '',
    proxy: 'http://127.0.0.1:7890',
    force: false,
  }
  for (const arg of argv) {
    if (arg === '--delete') opts.delete = true
    else if (arg === '--yes' || arg === '-y') opts.yes = true
    else if (arg === '--no-proxy') opts.proxy = ''
    else if (arg === '--force') opts.force = true
    else if (arg.startsWith('--categories=')) {
      opts.categories = arg.slice('--categories='.length).split(',').map(s => s.trim()).filter(Boolean)
    } else if (arg.startsWith('--limit=')) {
      opts.limit = Number(arg.slice('--limit='.length))
    } else if (arg.startsWith('--out=')) {
      opts.out = arg.slice('--out='.length)
    } else if (arg.startsWith('--proxy=')) {
      opts.proxy = arg.slice('--proxy='.length)
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  for (const c of opts.categories) {
    if (!ALL_CATEGORIES.includes(c)) throw new Error(`未知分类: ${c}`)
  }
  if (opts.categories.length === 0) throw new Error('--categories 不能为空')
  if (opts.limit !== Infinity && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    throw new Error('--limit 必须是正整数')
  }
  return opts
}

function printHelp() {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''))
}

function loadEnv() {
  const out = {}
  const file = join(ROOT, 'src-tauri', '.env')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      let val = m[2]
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      out[m[1]] = val
    }
  }
  for (const k of ['DB_URL', 'DB_ENC_KEY', 'IMGBED_URL', 'IMGBED_TOKEN']) {
    if (process.env[k]) out[k] = process.env[k]
  }
  for (const k of ['DB_URL', 'DB_ENC_KEY', 'IMGBED_URL', 'IMGBED_TOKEN']) {
    if (!out[k]) throw new Error(`缺少 ${k}（src-tauri/.env 或环境变量）`)
  }
  return out
}

// ────────────────────────────── 解密 ──────────────────────────────

function makeDecryptor(hexKey) {
  const key = Buffer.from(hexKey.trim(), 'hex')
  if (key.length !== 32) throw new Error('DB_ENC_KEY 必须是 64 位十六进制（32 字节）')
  return (s) => {
    if (s == null || s === '') return ''
    if (!s.startsWith('enc1:')) return s
    try {
      const blob = Buffer.from(s.slice(5), 'base64')
      if (blob.length <= 12) throw new Error('密文长度异常')
      const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
      d.setAuthTag(blob.subarray(blob.length - 16))
      return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString('utf8')
    } catch {
      // 解不开就中止：把密文当明文会让引用集偏小，进而误删仍在使用的图片
      throw new Error(`密文解密失败（DB_ENC_KEY 不匹配或数据损坏）：${s.slice(0, 24)}…`)
    }
  }
}

// ────────────────────────────── MySQL ──────────────────────────────

// 不能用 --raw：字段内的换行/制表符会原样输出，按行切分就会错位。
// 批量模式下 mysql 会把 \n、\t、\0、\\ 转义，这里逐字符还原（NULL 单元格 → 空串）。
function unescapeBatch(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') { out += c; continue }
    const n = s[++i]
    if (n === 'n') out += '\n'
    else if (n === 't') out += '\t'
    else if (n === '0') out += '\0'
    else if (n === '\\') out += '\\'
    else out += n === undefined ? '\\' : n
  }
  return out
}

function makeSql(env) {
  const u = new URL(env.DB_URL)
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(u.username)
  const password = decodeURIComponent(u.password)
  return (sql) => {
    const r = spawnSync('mysql', [
      '-h', u.hostname, '-P', u.port || '3306', '-u', user, db,
      '--ssl-mode=DISABLED', '--batch', '--skip-column-names',
      '--default-character-set=utf8mb4', '-e', sql,
    ], {
      env: { ...process.env, MYSQL_PWD: password },
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    })
    if (r.error) throw new Error(`无法执行 mysql：${r.error.message}`)
    if (r.status !== 0) throw new Error(`mysql 查询失败：${(r.stderr || '').trim()}`)
    return r.stdout
      .split('\n')
      .map(line => line.replace(/\r$/, ''))
      .filter(Boolean)
      .map(line => line.split('\t').map(cell => unescapeBatch(cell === 'NULL' ? '' : cell)))
  }
}

// ────────────────────────────── 图床 HTTP ──────────────────────────────

function makeHttp(opts, env) {
  const base = env.IMGBED_URL.replace(/\/+$/, '')
  const token = env.IMGBED_TOKEN

  function curlArgs(url) {
    const args = ['-sS', '--max-time', '120']
    if (opts.proxy) args.push('-x', opts.proxy)
    args.push('-H', `Authorization: Bearer ${token}`, url)
    return args
  }

  function get(url) {
    const r = spawnSync('curl', curlArgs(url), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
    if (r.error) throw new Error(`无法执行 curl：${r.error.message}`)
    if (r.status !== 0) throw new Error(`curl 失败：${(r.stderr || '').trim()}`)
    return r.stdout
  }

  function getAsync(url) {
    return new Promise((resolvePromise, reject) => {
      const p = spawn('curl', curlArgs(url))
      let out = ''
      let err = ''
      p.stdout.on('data', d => { out += d })
      p.stderr.on('data', d => { err += d })
      p.on('error', reject)
      p.on('close', code => {
        if (code === 0) resolvePromise(out)
        else reject(new Error(err.trim() || `curl exit ${code}`))
      })
    })
  }

  async function list(root) {
    const url = `${base}/api/manage/list?count=-1&dir=${encodeURIComponent(root)}&recursive=true`
    const body = get(url)
    let data
    try { data = JSON.parse(body) } catch { throw new Error(`列表响应不是 JSON（${root}）：${body.slice(0, 200)}`) }
    if (!Array.isArray(data.files)) throw new Error(`列表响应缺少 files 字段（${root}）`)
    return data.files
  }

  async function remove(key) {
    const url = `${base}/api/manage/delete/${encodeURI(key)}`
    const body = await getAsync(url)
    let data
    try { data = JSON.parse(body) } catch { throw new Error(`删除响应不是 JSON：${body.slice(0, 200)}`) }
    if (data.success !== true) throw new Error(data.error || body.slice(0, 200))
    return { existed: data.existed !== false }
  }

  return { get, list, remove }
}

// ────────────────────────────── 引用集 ──────────────────────────────

function normKey(raw) {
  let k = String(raw).trim().replace(/[.,;:'"!?]+$/, '')
  k = k.split(/[?#]/)[0]
  try { k = decodeURIComponent(k) } catch { /* 保留原样 */ }
  return k.replace(/^\/+/, '').replace(/^file\//, '')
}

function keysInText(text, into) {
  for (const m of text.matchAll(REF_RE)) {
    const key = normKey(m[1] || m[2] || '')
    if (key) into.add(key)
  }
}

/** 扫描仓库源码/配置里的硬编码图床引用，避免漏掉感谢名单、前置依赖等静态文件 */
function scanRepoReferences(into) {
  const roots = [join(ROOT, 'src'), join(ROOT, 'src-tauri', 'src'), join(ROOT, 'scripts')]
  const extRe = /\.(js|jsx|mjs|cjs|ts|tsx|json|md|rs|html|css)$/i
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === 'target') continue
        walk(p)
      } else if (extRe.test(name)) {
        try { keysInText(readFileSync(p, 'utf8'), into) } catch { /* 忽略不可读文件 */ }
      }
    }
  }
  for (const r of roots) walk(r)
  for (const f of ['.env', 'agents.md', 'AGENTS.md', 'README.md', join('src-tauri', 'tauri.conf.json')]) {
    const p = join(ROOT, f)
    if (existsSync(p)) {
      try { keysInText(readFileSync(p, 'utf8'), into) } catch { /* ignore */ }
    }
  }
}

function buildReferenceSet(env, sql, decrypt, http) {
  const refs = new Set()

  // 1) 被 mod_files 引用的包/安装包
  for (const row of sql('SELECT file_url FROM mod_files')) {
    if (row[0] && row[0] !== 'NULL') {
      try {
        const p = new URL(row[0]).pathname
        refs.add(normKey(p))
      } catch { /* 非法 URL 跳过 */ }
    }
  }

  // 2) 所有有效内容（软删除的讨论帖及其评论/boost/投票选项已排除）
  const textQueries = [
    ['SELECT name, description, instructions, changelog FROM mod_translations', 4],
    ['SELECT content FROM mod_comments', 1],
    ["SELECT title, content FROM discussions WHERE status = 'active'", 2],
    ['SELECT c.content FROM discussion_comments c JOIN discussions d ON d.id = c.discussion_id WHERE d.status = \'active\'', 1],
    ['SELECT b.content FROM discussion_boosts b JOIN discussions d ON d.id = b.discussion_id WHERE d.status = \'active\'', 1],
    ['SELECT o.label FROM discussion_poll_options o JOIN discussion_polls p ON p.id = o.poll_id JOIN discussions d ON d.id = p.discussion_id WHERE d.status = \'active\'', 1],
    ["SELECT avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''", 1],
    ['SELECT reason FROM edit_applications', 1],
  ]
  for (const [q, cols] of textQueries) {
    for (const row of sql(q)) {
      if (row.length !== cols) {
        // 行解析异常时绝不能继续：少算引用就会误删
        throw new Error(`查询结果列数异常（期望 ${cols}，实际 ${row.length}）：${q.slice(0, 80)}`)
      }
      for (const cell of row) keysInText(decrypt(cell), refs)
    }
  }

  // 3) 仓库硬编码引用 + 固定白名单目录
  scanRepoReferences(refs)

  // 4) 最新安装包：latest.json 里 update_url 所在目录整体保留（含签名等附属文件）
  const prefixes = [...STATIC_WHITELIST_PREFIXES]
  try {
    const latest = http.get(`${env.IMGBED_URL.replace(/\/+$/, '')}/file/sfm/installer/latest.json`)
    refs.add('sfm/installer/latest.json')
    for (const m of latest.matchAll(/sfm\/installer\/[^\s"'<>]+/g)) {
      const key = normKey(m[0])
      refs.add(key)
      const dir = key.slice(0, key.lastIndexOf('/') + 1)
      if (dir) prefixes.push(dir)
    }
  } catch (e) {
    console.warn(`[warn] 读取 latest.json 失败（将白名单整个 sfm/installer/ 以防误删）：${e.message}`)
    prefixes.push('sfm/installer/')
  }

  return { refs, prefixes }
}

// ────────────────────────────── 分类与报告 ──────────────────────────────

function classify(name) {
  if (name.startsWith('sfmmm/')) return IMAGE_RE.test(name) ? 'discussion-images' : 'misc'
  if (!name.startsWith('sfm/')) return 'misc'
  const rest = name.slice(4)
  if (rest.startsWith('installer/')) return 'installers'
  const seg = rest.split('/')
  const underMod = /^\d+$/.test(seg[0] || '')
  if (underMod && ARCHIVE_RE.test(name)) return 'packages'
  if (underMod && seg[1] === 'comments' && IMAGE_RE.test(name)) return 'comment-images'
  if (underMod && seg[1] === 'images' && IMAGE_RE.test(name)) return 'description-images'
  if (IMAGE_RE.test(name)) return 'other-images'
  return 'misc'
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function printCategoryTable(byCategory) {
  console.log('\n分类统计（未被任何有效内容引用）:')
  console.log('  分类\t数量\t大小\t示例')
  let total = 0
  for (const cat of ALL_CATEGORIES) {
    const items = byCategory.get(cat) || []
    total += items.length
    const size = items.reduce((s, f) => s + (Number(f.metadata?.FileSizeBytes) || 0), 0)
    const sample = items.slice(0, 3).map(f => f.name).join('  |  ')
    console.log(`  ${cat}\t${items.length}\t${formatBytes(size)}\t${sample}`)
  }
  return total
}

// ────────────────────────────── 主流程 ──────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const decrypt = makeDecryptor(env.DB_ENC_KEY)
  const sql = makeSql(env)
  const http = makeHttp(opts, env)

  console.log('== 1/4 读取图床列表 ==')
  const files = []
  for (const root of ['sfm', 'sfmmm']) {
    const list = await http.list(root)
    console.log(`  ${root}: ${list.length} 个文件`)
    files.push(...list)
  }
  if (files.length === 0) throw new Error('图床列表为空，已中止（检查 IMGBED_URL / Token / 网络）')
  const listed = new Set(files.map(f => f.name))

  console.log('== 2/4 构建引用集（解密全库文本）==')
  const { refs, prefixes } = buildReferenceSet(env, sql, decrypt, http)
  console.log(`  引用集合计 ${refs.size} 个 key（含仓库硬编码与 latest.json）`)

  const isWhitelisted = (name) =>
    refs.has(name) || prefixes.some(p => name.startsWith(p))

  console.log('== 3/4 分类候选 ==')
  const byCategory = new Map(ALL_CATEGORIES.map(c => [c, []]))
  for (const f of files) {
    if (isWhitelisted(f.name)) continue
    byCategory.get(classify(f.name)).push(f)
  }
  const candidateCount = printCategoryTable(byCategory)
  console.log(`  被有效内容/白名单引用而保留: ${files.length - candidateCount}`)

  const selected = []
  for (const cat of opts.categories) selected.push(...(byCategory.get(cat) || []))
  const limited = selected.slice(0, Number.isFinite(opts.limit) ? opts.limit : selected.length)
  const selectedSize = limited.reduce((s, f) => s + (Number(f.metadata?.FileSizeBytes) || 0), 0)
  console.log(`\n本次选中分类 [${opts.categories.join(', ')}]：${limited.length} 个文件，约 ${formatBytes(selectedSize)}`)

  if (!opts.delete) {
    console.log('\n[dry-run] 未删除任何文件。确认无误后加 --delete --yes 执行。')
    writeReport(opts, { mode: 'dry-run', files: limited, categories: opts.categories })
    return
  }

  // ── 安全闸 ──
  if (limited.length === 0) {
    console.log('\n没有可删除的文件。')
    return
  }
  if (limited.length > files.length * 0.7 && !opts.force) {
    throw new Error(`候选（${limited.length}）超过图床文件总数（${files.length}）的 70%，已中止；确认无误可加 --force`)
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error('非交互环境执行删除必须加 --yes')
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`即将永久删除 ${limited.length} 个文件。输入 DELETE 确认：`)
    rl.close()
    if (answer.trim() !== 'DELETE') { console.log('已取消。'); return }
  }

  console.log('== 4/4 执行删除 ==')
  const result = await deleteMany(http, limited, 4)
  console.log(`\n完成：删除 ${result.deleted.length}，其中本就不存在 ${result.absent}；失败 ${result.failed.length}`)
  if (result.aborted) console.warn('[warn] 连续失败过多，已提前中止')
  for (const f of result.failed.slice(0, 20)) console.warn(`  失败 ${f.name}: ${f.error}`)
  writeReport(opts, { mode: 'delete', ...result, categories: opts.categories })
}

async function deleteMany(http, files, concurrency) {
  const deleted = []
  const failed = []
  let absent = 0
  let aborted = false
  let consecutiveFailures = 0
  let index = 0

  async function worker() {
    while (!aborted) {
      const i = index++
      if (i >= files.length) return
      const f = files[i]
      let lastErr
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await http.remove(f.name)
          if (!r.existed) absent++
          deleted.push(f.name)
          consecutiveFailures = 0
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          if (attempt === 0) await new Promise(r => setTimeout(r, 500))
        }
      }
      if (lastErr) {
        failed.push({ name: f.name, error: lastErr.message })
        consecutiveFailures++
        if (consecutiveFailures >= 5) aborted = true
      }
      const done = deleted.length + failed.length
      if (done % 25 === 0 || done === files.length) {
        console.log(`  进度 ${done}/${files.length}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return { deleted, failed, absent, aborted }
}

function writeReport(opts, report) {
  if (!opts.out) return
  const payload = {
    generatedAt: new Date().toISOString(),
    ...report,
    files: (report.files || []).map(f => f.name || f),
  }
  writeFileSync(opts.out, JSON.stringify(payload, null, 2))
  console.log(`报告已写入 ${opts.out}`)
}

main().catch(e => {
  console.error(`\n[error] ${e.message}`)
  process.exit(1)
})
