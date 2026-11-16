import { describe, it, expect } from 'vitest'
import { applyPublishedVersions, normalizeManifestEntryPath, normalizeManifestFiles } from './modFileUtils'

describe('applyPublishedVersions（发布版本与写库版本一致）', () => {
  const form = () => ({
    zh: { name: '模组', version: '2.0.0', description: 'd' },
    en: { name: 'mod', version: '2.0.0', description: 'd' },
  })

  it('幂等 / 清单自愈：写回后端保持的基线版本，不按表单新版本写库', () => {
    const written = applyPublishedVersions(form(), { zh: '1.1.0' })
    expect(written.zh.version).toBe('1.1.0')
    expect(written.en.version).toBe('2.0.0')
  })

  it('静默降级场景：表单填更低版本、发布端保持基线，最终写库仍是基线版本', () => {
    const written = applyPublishedVersions(form(), { zh: '3.0.0' })
    expect(written.zh.version).toBe('3.0.0')
  })

  it('正常发布（内容有变化）：发布版本就是本次上传使用的版本，照常升版本', () => {
    const written = applyPublishedVersions(form(), { zh: '2.0.0' })
    expect(written.zh.version).toBe('2.0.0')
  })

  it('不改动未发布的语言，也不修改传入对象', () => {
    const input = form()
    const written = applyPublishedVersions(input, { zh: '1.1.0' })
    expect(input.zh.version).toBe('2.0.0')
    expect(written.en).toEqual(input.en)
  })
})

describe('normalizeManifestEntryPath（与 Rust normalize_entry_path 同口径）', () => {
  it('dll：剥掉 BepInEx/plugins 前缀，不区分大小写、可重复剥叠加前缀', () => {
    expect(normalizeManifestEntryPath('BepInEx/plugins/foo.dll', 'dll', 'm')).toBe('foo.dll')
    expect(normalizeManifestEntryPath('bepinex/PLUGINS/foo.dll', 'dll', 'm')).toBe('foo.dll')
    expect(normalizeManifestEntryPath('BepInEx/plugins/BepInEx/plugins/x.dll', 'dll', 'm')).toBe('x.dll')
    expect(normalizeManifestEntryPath('foo/bar.dll', 'dll', 'm')).toBe('foo/bar.dll')
  })

  it('dll：安装根本身/上级目录归一为空并丢弃', () => {
    expect(normalizeManifestEntryPath('BepInEx/plugins/', 'dll', 'm')).toBe('')
    expect(normalizeManifestEntryPath('BepInEx/', 'dll', 'm')).toBe('')
    expect(normalizeManifestEntryPath('BepInEx/plugins/sub/', 'dll', 'm')).toBe('sub/')
  })

  it('反斜杠与 `.` 段按规范折叠', () => {
    expect(normalizeManifestEntryPath('.\\BepInEx\\plugins\\x.dll', 'dll', 'm')).toBe('x.dll')
    expect(normalizeManifestEntryPath('.', 'dll', 'm')).toBe('')
    expect(normalizeManifestEntryPath('', 'dll', 'm')).toBe('')
  })

  it('v1：剥掉 CustomMissions 前缀，叠加前缀重复剥', () => {
    expect(normalizeManifestEntryPath('CustomMissions/01.json', 'v1', '')).toBe('01.json')
    expect(normalizeManifestEntryPath('CustomMissions/', 'v1', '')).toBe('')
    expect(normalizeManifestEntryPath('CustomMissions/CustomMissions/a.json', 'v1', '')).toBe('a.json')
  })

  it('v2：合法 modKey 才剥 CustomMissions2/<key> 前缀', () => {
    expect(normalizeManifestEntryPath('CustomMissions2/mymod/a.json', 'v2', 'mymod')).toBe('a.json')
    expect(normalizeManifestEntryPath('CustomMissions2/mymod/', 'v2', 'mymod')).toBe('')
    // 非法 modKey（含 / \ .. 或为空）不剥前缀，条目原样保留
    expect(normalizeManifestEntryPath('CustomMissions2/mymod/a.json', 'v2', 'a/../b')).toBe('CustomMissions2/mymod/a.json')
    expect(normalizeManifestEntryPath('CustomMissions2/mymod/a.json', 'v2', 'a/b')).toBe('CustomMissions2/mymod/a.json')
    expect(normalizeManifestEntryPath('CustomMissions2/mymod/a.json', 'v2', '')).toBe('CustomMissions2/mymod/a.json')
  })

  it('composite / 未知类型：不剥前缀，目录条目保留末尾斜杠', () => {
    expect(normalizeManifestEntryPath('any/path.bin', 'composite', 'm')).toBe('any/path.bin')
    expect(normalizeManifestEntryPath('any/dir/', 'composite', 'm')).toBe('any/dir/')
    expect(normalizeManifestEntryPath('BepInEx/plugins/x.dll', 'composite', 'm')).toBe('BepInEx/plugins/x.dll')
  })
})

describe('normalizeManifestFiles（文件列表预览：只留文件条目）', () => {
  it('归一后丢弃目录条目，保留文件条目', () => {
    const raw = JSON.stringify(['BepInEx/plugins/a.dll', 'BepInEx/plugins/sub/', 'other.bin'])
    expect(normalizeManifestFiles(raw, 'dll', 'm')).toEqual(['a.dll', 'other.bin'])
  })

  it('非法 JSON 与非字符串条目被过滤，返回空数组兜底', () => {
    expect(normalizeManifestFiles('not json', 'dll', 'm')).toEqual([])
    expect(normalizeManifestFiles(JSON.stringify([1, null, 'x.dll']), 'dll', 'm')).toEqual(['x.dll'])
    expect(normalizeManifestFiles(null, 'dll', 'm')).toEqual([])
  })

  it('manifest 全是目录条目时返回空数组', () => {
    expect(normalizeManifestFiles(JSON.stringify(['a/', 'a/b/']), 'v1', '')).toEqual([])
  })
})
