/**
 * target 目录瘦身：
 *   统计 src-tauri/target 的体积构成 → 找出可以回收的 incremental 会话目录
 *   （src-tauri/Cargo.toml 里 [profile.dev] incremental = false 之后这些目录不会再增长），
 *   顺带报告 deps 里重复的 rlib 变体（只统计，不删除）。
 *
 * 用法（仓库根目录）：
 *   pnpm clean:target            # 只统计并打印可回收空间，不删除任何东西
 *   pnpm clean:target --apply    # 真正删除 target/<profile>/incremental
 *
 * 注意：
 *   - --apply 请在没有任何 cargo / tauri 构建运行时执行，否则可能中断正在写的产物；
 *   - 删除的只是编译缓存，下次构建会自动重建（首次是完整重编译）。
 */

import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const TARGET = path.join(ROOT, 'src-tauri', 'target')
const apply = process.argv.slice(2).includes('--apply')

const GB = 1024 ** 3
const MB = 1024 ** 2

function human(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function pad(text, width) {
  return String(text).padEnd(width)
}

/** 递归统计目录体积，返回 { bytes, files } */
async function dirSize(dir) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          const info = await stat(full)
          bytes += info.size
          files += 1
        } catch {
          // 文件可能正被占用，忽略
        }
      }
    }
  }
  return { bytes, files }
}

async function listDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

function assertInsideTarget(dir) {
  const resolved = path.resolve(dir)
  if (resolved !== TARGET && !resolved.startsWith(TARGET + path.sep)) {
    throw new Error(`拒绝操作 target 之外的路径：${resolved}`)
  }
  return resolved
}

async function main() {
  if (!existsSync(TARGET)) {
    console.log(`没有找到 ${TARGET}，无需清理。`)
    return
  }

  const total = await dirSize(TARGET)
  console.log(`target: ${TARGET}`)
  console.log(`当前总体积 ${human(total.bytes)} / ${total.files} 个文件\n`)

  const profiles = await listDirs(TARGET)
  const profileRows = []
  for (const profile of profiles) {
    profileRows.push({ name: path.basename(profile), ...(await dirSize(profile)) })
  }
  profileRows.sort((a, b) => b.bytes - a.bytes)
  for (const row of profileRows) {
    console.log(`  ${pad(row.name, 14)} ${human(row.bytes).padStart(10)}  ${row.files} 个文件`)
  }

  // incremental 会话：Cargo 每次构建会新开一个 `<crate>-<hash>` 目录且不清理旧的
  const incrementalDirs = []
  for (const profile of profiles) {
    const incremental = path.join(profile, 'incremental')
    if (!existsSync(incremental)) continue
    const sessions = await listDirs(incremental)
    let bytes = 0
    for (const session of sessions) {
      const size = await dirSize(session)
      bytes += size.bytes
    }
    const ownSize = await dirSize(incremental)
    incrementalDirs.push({
      dir: incremental,
      profile: path.basename(profile),
      sessions: sessions.length,
      bytes: ownSize.bytes,
      sessionBytes: bytes,
    })
  }

  console.log('')
  if (incrementalDirs.length === 0) {
    console.log('incremental: 没有残留目录')
  } else {
    let reclaimable = 0
    for (const item of incrementalDirs) {
      reclaimable += item.bytes
      console.log(
        `incremental(${item.profile}): ${item.sessions} 个会话，${human(item.bytes)} 可回收`,
      )
    }
    console.log(`合计可回收 ${human(reclaimable)}（占 target 的 ${((reclaimable / total.bytes) * 100).toFixed(1)}%）`)
  }

  // deps 里同名 crate 的多个 rlib 变体（不同 feature/hash）——只报告，不自动删
  let duplicateBytes = 0
  let duplicateGroups = 0
  for (const profile of profiles) {
    const deps = path.join(profile, 'deps')
    if (!existsSync(deps)) continue
    const rlibs = new Map()
    for (const file of await readdir(deps).catch(() => [])) {
      const match = /^lib(.+)-[0-9a-f]{16}\.rlib$/.exec(file)
      if (!match) continue
      const info = await stat(path.join(deps, file)).catch(() => null)
      if (!info) continue
      const list = rlibs.get(match[1]) ?? []
      list.push({ file, size: info.size, mtime: info.mtimeMs })
      rlibs.set(match[1], list)
    }
    for (const list of rlibs.values()) {
      if (list.length < 2) continue
      list.sort((a, b) => b.mtime - a.mtime)
      const extra = list.slice(1).reduce((sum, item) => sum + item.size, 0)
      duplicateBytes += extra
      duplicateGroups += 1
    }
  }
  if (duplicateGroups > 0) {
    console.log(
      `\ndeps 重复 rlib 变体：${duplicateGroups} 组，约 ${human(duplicateBytes)}` +
        '（不同 feature/hash 的同一 crate，需要 cargo clean 才会回收）',
    )
  }

  if (incrementalDirs.length === 0) return

  if (!apply) {
    console.log('\n这是 dry-run，未删除任何文件。确认无误后执行：pnpm clean:target --apply')
    return
  }

  console.log('')
  for (const item of incrementalDirs) {
    const dir = assertInsideTarget(item.dir)
    await rm(dir, { recursive: true, force: true })
    console.log(`已删除 ${dir}`)
  }

  const after = await dirSize(TARGET)
  console.log(`\n清理后 target 体积 ${human(after.bytes)} / ${after.files} 个文件`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
