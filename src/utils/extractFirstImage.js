// 从 markdown/html 正文中提取第一张图片 URL（图床图片），并返回去掉图片语法后的纯文本摘要
// 用于列表/卡片类界面的预览：正文里只带图片时不应把 markdown 语法当纯文本裸露出来
export function extractFirstImage(content) {
  if (!content) return { image: null, text: '' }
  const imgRegex = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi
  const matches = [...content.matchAll(imgRegex)]
  const image = matches.length > 0 ? (matches[0][1] || matches[0][2] || null) : null
  // 仅将图片语法替换为空，保留其余正文文本
  const text = content.replace(imgRegex, ' ').replace(/\s+/g, ' ').trim()
  return { image, text }
}

export default extractFirstImage
