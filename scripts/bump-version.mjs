#!/usr/bin/env node
/**
 * 版本号唯一操作入口：三处版本文件必须一起改，别的地方都读它们。
 *
 *   node scripts/bump-version.mjs              补丁号 +1
 *   node scripts/bump-version.mjs --dry-run    只打印，不落盘
 *   node scripts/bump-version.mjs --set 1.2.3  指定版本
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const TARGETS = [
  {
    file: 'src-tauri/Cargo.toml',
    pattern: /^version = "([^"]+)"/m,
    template: (version) => `version = "${version}"`,
  },
  {
    file: 'src-tauri/tauri.conf.json',
    pattern: /"version": "([^"]+)"/,
    template: (version) => `"version": "${version}"`,
  },
  {
    file: 'src/version.js',
    pattern: /const APP_VERSION = '([^']+)'/,
    template: (version) => `const APP_VERSION = '${version}'`,
  },
]

function loadTargets() {
  return TARGETS.map((target) => {
    const absolute = path.join(ROOT, target.file)
    const content = readFileSync(absolute, 'utf8')
    const match = content.match(target.pattern)
    if (!match) throw new Error(`${target.file} 里找不到版本号`)
    return { ...target, absolute, content, version: match[1] }
  })
}

function bumpPatch(version) {
  const parts = version.split('.')
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`版本号不是 x.y.z 形式：${version}`)
  }
  return `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`
}

/**
 * Cargo.lock 是生成文件，不参与「三处一致」校验，但里面 app 包的版本要保持同步，
 * 否则每次 cargo build 都会把它改脏、并在下一次提交里混进来。
 */
function syncCargoLock(next, dryRun) {
  const file = path.join(ROOT, 'src-tauri', 'Cargo.lock')
  if (!existsSync(file)) return
  const content = readFileSync(file, 'utf8')
  const updated = content.replace(
    /(\[\[package\]\]\r?\nname = "app"\r?\nversion = ")[^"]+(")/,
    `$1${next}$2`,
  )
  if (updated === content) return
  if (!dryRun) writeFileSync(file, updated, 'utf8')
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const setIndex = args.indexOf('--set')
  const explicit = setIndex === -1 ? '' : String(args[setIndex + 1] || '').trim()

  if (setIndex !== -1 && !/^\d+\.\d+\.\d+$/.test(explicit)) {
    throw new Error(`--set 需要 x.y.z 形式的版本号，收到：${explicit || '(空)'}`)
  }

  const entries = loadTargets()
  const versions = [...new Set(entries.map((entry) => entry.version))]
  if (versions.length !== 1) {
    const detail = entries.map((entry) => `${entry.file}=${entry.version}`).join('，')
    throw new Error(`三处版本号不一致：${detail}`)
  }

  const current = versions[0]
  const next = explicit || bumpPatch(current)
  for (const entry of entries) {
    const updated = entry.content.replace(entry.pattern, entry.template(next))
    if (updated === entry.content && next !== entry.version) {
      throw new Error(`${entry.file} 没有写入新版本号`)
    }
    if (!dryRun) writeFileSync(entry.absolute, updated, 'utf8')
  }
  syncCargoLock(next, dryRun)

  console.log(`版本 ${current} → ${next}${dryRun ? '（dry-run，未写入）' : ''}`)
}

try {
  main()
} catch (error) {
  console.error(`✘ ${error.message}`)
  process.exit(1)
}
