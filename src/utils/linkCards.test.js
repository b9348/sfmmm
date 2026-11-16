import { describe, it, expect } from 'vitest'
import { splitMarkdownWithLinkCards } from './linkCards'

/** 只取出 mention 段，方便断言 */
const mentions = (md) => splitMarkdownWithLinkCards(md).filter((p) => p.type === 'mention')

describe('splitMarkdownWithLinkCards - @提及', () => {
  it('夹在句子中间的提及也切成卡片（生产数据：CanTrash 模组评论）', () => {
    // 真实评论：提及不独占一行，早前退化成编辑器那种行内蓝链
    const md = '可以编辑然后用艾特来提到其他mod [@游戏内自定义动作，结合其他类型模组生成](sfmmm:mod:Seleka2.PoseStudio.)'
    expect(splitMarkdownWithLinkCards(md)).toEqual([
      { type: 'markdown', text: '可以编辑然后用艾特来提到其他mod' },
      {
        type: 'mention',
        kind: 'mod',
        ref: 'Seleka2.PoseStudio.',
        label: '游戏内自定义动作，结合其他类型模组生成',
      },
    ])
  })

  it('独占一行的提及仍然切成卡片', () => {
    expect(mentions('[@游戏内自定义动作](sfmmm:mod:Seleka2.PoseStudio.)')).toEqual([
      { type: 'mention', kind: 'mod', ref: 'Seleka2.PoseStudio.', label: '游戏内自定义动作' },
    ])
  })

  it('一段里多个提及分别成卡片，中间文字保留', () => {
    expect(splitMarkdownWithLinkCards('看这个 [@帖子](sfmmm:discuss:430) 和 [@模组](sfmmm:mod:CanTrash)。')).toEqual([
      { type: 'markdown', text: '看这个' },
      { type: 'mention', kind: 'discussion', ref: '430', label: '帖子' },
      { type: 'markdown', text: '和' },
      { type: 'mention', kind: 'mod', ref: 'CanTrash', label: '模组' },
    ])
  })

  it('ref 里的百分号编码会解码', () => {
    expect(mentions('[@中文模组](sfmmm:mod:%E4%B8%AD%E6%96%87%E6%A8%A1%E7%BB%84)')[0].ref).toBe('中文模组')
  })

  it('提及前后只有标点的残片不单独成段', () => {
    expect(splitMarkdownWithLinkCards('[@模组](sfmmm:mod:CanTrash)。')).toEqual([
      { type: 'mention', kind: 'mod', ref: 'CanTrash', label: '模组' },
    ])
  })
})

describe('splitMarkdownWithLinkCards - 网盘链接成卡片', () => {
  it('每行一组「标签：链接」、不带列表符号也出卡片（生产数据：新手魅魔莉莉娅）', () => {
    // 真实正文：两行都是「网盘链接N：https://…」，早前因为不是列表项整块退回 Markdown
    const md = '网盘链接1：https://pan.quark.cn/s/example1\n网盘链接2：https://pan.quark.cn/s/example2'
    expect(splitMarkdownWithLinkCards(md)).toEqual([
      {
        type: 'cards',
        items: [
          { label: '网盘链接1', url: 'https://pan.quark.cn/s/example1' },
          { label: '网盘链接2', url: 'https://pan.quark.cn/s/example2' },
        ],
      },
    ])
  })

  it('同一行连着写多组「标签 + 链接」逐个拆成卡片', () => {
    const md = '网盘链接1：https://pan.quark.cn/s/example1 网盘链接2：https://pan.quark.cn/s/example2'
    expect(splitMarkdownWithLinkCards(md)).toEqual([
      {
        type: 'cards',
        items: [
          { label: '网盘链接1', url: 'https://pan.quark.cn/s/example1' },
          { label: '网盘链接2', url: 'https://pan.quark.cn/s/example2' },
        ],
      },
    ])
  })

  it('卡片组前后的正文原样保留', () => {
    const md = '更新内容：新增服装14套\n\n网盘链接1：https://pan.quark.cn/s/aaa\n\n解压密码：test-pass'
    expect(splitMarkdownWithLinkCards(md)).toEqual([
      { type: 'markdown', text: '更新内容：新增服装14套' },
      { type: 'cards', items: [{ label: '网盘链接1', url: 'https://pan.quark.cn/s/aaa' }] },
      { type: 'markdown', text: '解压密码：test-pass' },
    ])
  })

  it('列表项写法照旧出卡片', () => {
    const md = '- 夸克 https://pan.quark.cn/s/aaa\n- 百度 https://pan.baidu.com/s/bbb'
    expect(splitMarkdownWithLinkCards(md)).toEqual([
      {
        type: 'cards',
        items: [
          { label: '夸克', url: 'https://pan.quark.cn/s/aaa' },
          { label: '百度', url: 'https://pan.baidu.com/s/bbb' },
        ],
      },
    ])
  })

  it('行文里夹多个链接仍保持行内，不拆成卡片', () => {
    const cases = [
      '看这两个链接 https://a.com/1 https://b.com/2',
      '把资源都下载下来，参考 https://pan.quark.cn/s/aaa 和 https://pan.quark.cn/s/bbb 说明',
    ]
    for (const md of cases) {
      expect(splitMarkdownWithLinkCards(md), md).toEqual([{ type: 'markdown', text: md }])
    }
  })
})

describe('splitMarkdownWithLinkCards - 提及不生效的场景', () => {
  it('行内代码里的 sfmmm: 链接保持原样', () => {
    const md = '写法就是 `[@名字](sfmmm:mod:CanTrash)` 这样'
    expect(mentions(md)).toEqual([])
    expect(splitMarkdownWithLinkCards(md)).toEqual([{ type: 'markdown', text: md }])
  })

  it('代码块里的 sfmmm: 链接整块交给 Markdown', () => {
    const md = '```\n[@名字](sfmmm:mod:CanTrash)\n```'
    expect(splitMarkdownWithLinkCards(md)).toEqual([{ type: 'markdown', text: md }])
  })

  it('引用块与标题里的提及不拆（保持 Markdown 结构）', () => {
    for (const md of ['> 引用 [@帖子](sfmmm:discuss:430)', '## 标题 [@帖子](sfmmm:discuss:430)']) {
      expect(splitMarkdownWithLinkCards(md), md).toEqual([{ type: 'markdown', text: md }])
    }
  })

  it('普通 sfmmm: 链接（不在 [@…] 语法里）不受影响', () => {
    const md = '[普通链接](sfmmm:other:123)'
    expect(mentions(md)).toEqual([])
  })
})
