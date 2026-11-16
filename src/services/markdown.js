import { marked } from 'marked'

/**
 * Markdown 渲染的唯一入口。
 *
 * 之所以集中配置 marked 而不是各处直接 `marked(...)`：
 * 我们需要改一条解析规则（见下），预览、正文、讨论区必须表现一致，
 * 分散调用迟早会出现「编辑器预览正常、发出去后显示原文」的分叉。
 */

/**
 * CommonMark HTML block 第 6 类列出的块级标签名。
 *
 * 与 marked 内部 `rules.block.html` 用的是同一份列表（CommonMark 0.31
 * "HTML blocks" 第 6 条）。注意 `br` 不在其中——它是行内标签。
 */
const BLOCK_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col colgroup ' +
    'dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
    'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta ' +
    'nav noframes ol optgroup option p param search section summary table tbody td tfoot ' +
    'th thead title tr track ul'
  ).split(' '),
)

/** 内容按原样输出的标签（HTML block 第 1 类），块语义必须保留 */
const RAW_TAGS = new Set(['script', 'pre', 'style', 'textarea'])

/**
 * 是否「行首出现行内标签」——属于 CommonMark HTML block 第 7 类，但本应用要拦掉。
 *
 * 第 7 类的定义是：一个完整的开标签或闭标签，且该行其余部分只有空白。
 * 命中后会开启 HTML block，直到下一个空行为止，块内内容**原样输出、不做
 * Markdown 解析**。于是用户写出
 *
 *     文字
 *
 *     </br>
 *     ![图](https://…/a.png)
 *
 * 时，图片语法会被当成纯文本显示；而同一个 `</br>` 若跟在文字后面（同一行）就正常。
 * 用户粘贴富文本时经常带出独占一行的 `<br>` / `</br>`，这条规则于是成了
 * 「明明被识别成图片语法、却渲染不出图片」的成因，与编辑器侧的图片高亮无关。
 *
 * 这里只对**行内标签**返回 true（此时不开启 HTML block，行内标签会作为
 * 段落内联 HTML 正常渲染）；块级标签、script/pre/style/textarea、注释、
 * `<?…?>`、`<!DOCTYPE>`、`<![CDATA[…]]>` 一律保留默认的块级行为。
 */
function isInlineTagAtLineStart(src) {
  const m = /^ {0,3}<\/?([a-zA-Z][\w-]*)/.exec(src)
  if (!m) return false
  const tag = m[1].toLowerCase()
  return !BLOCK_TAGS.has(tag) && !RAW_TAGS.has(tag)
}

marked.use({
  tokenizer: {
    // 返回 undefined = 这条 tokenizer 不认领，交由后面的块级规则（paragraph 等）处理；
    // 返回 false 才是「用 marked 自带实现」
    html(src) {
      return isInlineTagAtLineStart(src) ? undefined : false
    },
  },
})

/**
 * 把 Markdown 渲染成 HTML 字符串（同步）。
 *
 * 本项目没有启用 marked 的 async 选项/扩展，返回值恒为 string，可直接放进
 * 渲染期调用。若将来引入 async 扩展，这里会变成 Promise，调用方需补 await。
 */
export function renderMarkdown(markdown) {
  return marked(markdown || '')
}

export { marked }