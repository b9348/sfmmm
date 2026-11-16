/**
 * 构建产物指纹：把 NSIS 安装包与生成它的源码提交、编译期配置绑定。
 *
 *   写入方：scripts/tauri.mjs —— `pnpm tauri build` 成功后落 <exe>.meta.json
 *   校验方：scripts/release-local.mjs —— `--skip-build` 复用本地产物前先比对指纹
 *
 * 包名里的版本号只能证明「声称是哪个版本」，证明不了它是用当前源码编的：版本号随
 * 提交递增，提交后忘了重新构建的话，旧版本号的包会一直躺在 target 里等着被复用。
 * src-tauri/.env 被 .gitignore 忽略，改动不会体现在 git status 上，
 * 所以指纹同时记 head、dirty 与两个 .env 的哈希。
 *
 * 信任边界：依赖 cargo 自身的增量构建判定，它认为无需重编时会复用旧 exe。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const META_SUFFIX = '.meta.json'

const GIT = process.platform === 'win32' ? 'git.exe' : 'git'

function gitOut(cwd, args) {
  return execFileSync(GIT, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

/** .env 都在 .gitignore 里，改动不体现在 git status，只能靠内容哈希发现 */
function hashIf(file) {
  if (!existsSync(file)) return null
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
}

export function fingerprint(root) {
  return {
    head: gitOut(root, ['rev-parse', 'HEAD']),
    dirty: gitOut(root, ['status', '--porcelain']).length > 0,
    envTauri: hashIf(path.join(root, 'src-tauri', '.env')),
    envWeb: hashIf(path.join(root, '.env')),
  }
}

/** 找版本号对应的安装包；同版本有多个时取修改时间最新的一个 */
export function locateInstaller(root, version) {
  const dir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
  if (!existsSync(dir)) return null
  const hits = readdirSync(dir)
    .filter((name) => name.startsWith(`sfmmm_${version}_`) && name.toLowerCase().endsWith('.exe'))
    .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return hits.length ? path.join(dir, hits[0].name) : null
}

export function writeBuildMeta(root, version) {
  const exe = locateInstaller(root, version)
  if (!exe) return null
  const meta = { version, builtAt: new Date().toISOString(), ...fingerprint(root) }
  writeFileSync(exe + META_SUFFIX, JSON.stringify(meta, null, 2) + '\n')
  return { exe, meta }
}

export function readBuildMeta(exe) {
  const file = exe + META_SUFFIX
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}
