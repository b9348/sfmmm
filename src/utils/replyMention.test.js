import { describe, it, expect } from 'vitest'
import { splitReplyMention } from './replyMention'

describe('splitReplyMention', () => {
  it('命中参与者名单里的名字时摘出提及，正文去掉前缀', () => {
    expect(splitReplyMention('@张三 你说得对', ['一楼', '张三', '李四'])).toEqual({
      mention: '张三',
      body: '你说得对',
    })
  })

  it('同层有前缀重叠的名字时取最长匹配', () => {
    expect(splitReplyMention('@张三丰 内力深厚', ['张三', '张三丰'])).toEqual({
      mention: '张三丰',
      body: '内力深厚',
    })
  })

  it('含空格的长名字靠名单匹配，不被空白截断', () => {
    expect(splitReplyMention('@Jean Luc 早上好', ['Jean Luc'])).toEqual({
      mention: 'Jean Luc',
      body: '早上好',
    })
  })

  it('被回复人不在名单（改名/不在本页）时退化为整段 token', () => {
    expect(splitReplyMention('@旧名字 哈喽', ['别人'])).toEqual({
      mention: '旧名字',
      body: '哈喽',
    })
  })

  it('名单里的名字是别人名字的前缀时，不误命中短的', () => {
    expect(splitReplyMention('@张三丰 好', ['张三'])).toEqual({ mention: '张三丰', body: '好' })
  })

  it('名字后没有分隔符不算提及', () => {
    expect(splitReplyMention('@张三', ['张三'])).toEqual({ mention: null, body: '@张三' })
  })

  it('非 @ 开头的内容原样返回', () => {
    expect(splitReplyMention('普通评论 @张三', ['张三'])).toEqual({ mention: null, body: '普通评论 @张三' })
  })

  it('前缀后紧跟换行也能识别', () => {
    expect(splitReplyMention('@张三\n第一条\n第二条', ['张三'])).toEqual({
      mention: '张三',
      body: '第一条\n第二条',
    })
  })

  it('空内容不报错', () => {
    expect(splitReplyMention('', ['张三'])).toEqual({ mention: null, body: '' })
    expect(splitReplyMention(undefined, [])).toEqual({ mention: null, body: '' })
  })
})
