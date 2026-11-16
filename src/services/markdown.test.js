import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('行首独占的 </br> 不会吞掉后面的图片语法', () => {
    const html = renderMarkdown('文字\n\n</br>\n![图](https://c/a.png)')
    expect(html).toContain('<img src="https://c/a.png"')
    expect(html).not.toContain('![图]')
  })

  it('行首独占的 <br> / <br/> 同理', () => {
    for (const br of ['<br>', '<br/>', '<br />']) {
      const html = renderMarkdown(`文字\n\n${br}\n![图](https://c/a.png)`)
      expect(html, br).toContain('<img src="https://c/a.png"')
      expect(html, br).not.toContain('![图]')
    }
  })

  it('行首的行内标签（span/a/b）不再开启 HTML block', () => {
    const html = renderMarkdown('<span class="x">a</span>\n![图](https://c/a.png)')
    expect(html).toContain('<img src="https://c/a.png"')
  })

  it('块级标签仍按 HTML block 原样输出', () => {
    // CommonMark：<div> 这类块级标签开启 HTML block，块内不做 Markdown 解析
    const html = renderMarkdown('文字\n\n<div>x</div>\n\n![图](https://c/a.png)')
    expect(html).toContain('<div>x</div>')
    // 空行隔开后，后面的图片照常解析
    expect(html).toContain('<img src="https://c/a.png"')
  })

  it('script / pre 的内容保持原样输出', () => {
    expect(renderMarkdown('文字\n\n<script>alert(1)</script>')).toContain('<script>alert(1)</script>')
    expect(renderMarkdown('文字\n\n<pre>a\nb</pre>')).toContain('<pre>a\nb</pre>')
  })

  it('行内 br 仍渲染成 <br>', () => {
    expect(renderMarkdown('文字<br>更多')).toBe('<p>文字<br>更多</p>\n')
  })

  it('普通图片语法不受影响', () => {
    expect(renderMarkdown('文字\n![图](https://c/a.png)')).toBe(
      '<p>文字\n<img src="https://c/a.png" alt="图"></p>\n',
    )
  })
})