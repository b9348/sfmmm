#!/usr/bin/env node
/**
 * 把 scripts/git-hooks/ 下的钩子安装到当前仓库的 .git/hooks。
 * 钩子本身不进版本库，换机器或重新 clone 后跑一次 `pnpm hooks:install` 即可。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SOURCE_DIR = path.join(ROOT, 'scripts', 'git-hooks')
const MARKER = 'sfmmm version bump hook'
const HOOKS = ['pre-commit']

function fail(message) {
  console.error(`✘ ${message}`)
  process.exit(1)
}

function main() {
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (!gitDir) fail('当前目录不在 git 仓库里')
  const hooksDir = path.resolve(ROOT, gitDir, 'hooks')
  mkdirSync(hooksDir, { recursive: true })

  const force = process.argv.includes('--force')
  for (const name of HOOKS) {
    const source = path.join(SOURCE_DIR, name)
    const target = path.join(hooksDir, name)
    if (existsSync(target) && !readFileSync(target, 'utf8').includes(MARKER) && !force) {
      fail(`已存在自定义 ${name} 钩子：${target}\n  确认覆盖请加 --force`)
    }
    copyFileSync(source, target)
    try {
      chmodSync(target, 0o755)
    } catch {
      // Windows 上 chmod 基本是空操作，Git 会按 shebang 执行
    }
    console.log(`已安装 ${name} → ${target}`)
  }
}

main()
