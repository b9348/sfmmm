/**
 * CI 发布上传：安装包与 latest.json 直接写 R2。
 * 用法：node scripts/release-upload-r2.mjs <安装包目录>
 * 环境变量：NEW_VERSION / IMGBED_URL / R2_ENDPOINT / R2_BUCKET /
 *          R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 * 输出：安装包公网直链（最后一行），供 workflow 写 version_config。
 */
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createR2Store } from './r2-store.mjs'

const exeDir = path.resolve(process.argv[2] || 'dist/desktop')
const version = String(process.env.NEW_VERSION || '').trim()
const publicBase = String(process.env.IMGBED_URL || '').replace(/\/+$/, '')
const store = createR2Store({
  endpoint: String(process.env.R2_ENDPOINT || '').trim(),
  bucket: String(process.env.R2_BUCKET || '').trim(),
  accessKeyId: String(process.env.R2_ACCESS_KEY_ID || '').trim(),
  secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || '').trim(),
})

if (!version) throw new Error('NEW_VERSION is required')
if (!publicBase) throw new Error('IMGBED_URL is required')
if (!store.enabled) throw new Error('R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are required')

const files = (await readdir(exeDir)).filter(
  (name) => name.toLowerCase().endsWith('.exe') && name.includes(`_${version}_`),
)
if (files.length === 0) throw new Error(`No .exe installer for v${version} found in ${exeDir}`)
const exeName = files.sort()[0]
const exePath = path.join(exeDir, exeName)
if ((await stat(exePath)).size === 0) throw new Error(`Installer is empty: ${exeName}`)

const installerKey = `sfm/installer/v${version}/${exeName}`
const downloadUrl = `${publicBase}/file/${installerKey}`
await store.put(exePath, installerKey)

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sfmmm-r2-'))
const manifestPath = path.join(tmpDir, 'latest.json')
await writeFile(manifestPath, JSON.stringify({ version, update_url: downloadUrl }), 'utf8')
await store.put(manifestPath, 'sfm/installer/latest.json')

// 公网回读：R2 自定义域可能短暂缓存旧清单，只校验安装包可访问。
for (let attempt = 1; attempt <= 10; attempt += 1) {
  const res = await fetch(`${downloadUrl}?t=${Date.now()}`, { method: 'HEAD', cache: 'no-store' })
  if (res.ok) {
    process.stdout.write(`${downloadUrl}\n`)
    process.exit(0)
  }
  if (attempt === 10) throw new Error(`Installer is not reachable after upload: HTTP ${res.status}`)
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
