// 楼中楼的"回复对象"没有落库：mod_comments / discussion_comments 只有 parent_id（统一为一楼），
// 提交时传的 reply_to_id 仅用于写通知后即丢弃。唯一残留线索是 handleSubmitReply 拼在内容开头的
// "@昵称 "。这里把它摘出来单独展示——名字可能与当前显示名不同（对方改过名），也可能同名多人，
// 因此这是尽力而为的还原，不是权威数据。
function stripPrefix(text, name) {
  const at = '@' + name
  if (!text.startsWith(at)) return null
  // 名字后必须是空白分隔，否则 "@张三丰" 会误命中 "@张三"
  if (!/\s/.test(text.charAt(at.length))) return null
  return text.slice(at.length).replace(/^\s+/, '')
}

/**
 * 解析回复内容开头的 @提及。
 * @param {string} content 回复原文
 * @param {string[]} names 同楼层参与者昵称（用于处理含空格的长名字，取最长匹配）
 * @returns {{ mention: string|null, body: string }}
 */
export function splitReplyMention(content, names) {
  const text = content || ''
  if (!text.startsWith('@')) return { mention: null, body: text }

  let best = null
  for (const raw of names || []) {
    const name = (raw || '').trim()
    if (!name) continue
    const body = stripPrefix(text, name)
    if (body !== null && (!best || name.length > best.name.length)) best = { name, body }
  }

  // 参与者名单里找不到（被回复人已改名、或其消息不在当前页）时，退化为整段 token 匹配
  if (!best) {
    const m = text.match(/^@(\S{1,32})\s+/)
    if (m) best = { name: m[1], body: text.slice(m[0].length) }
  }

  return best ? { mention: best.name, body: best.body } : { mention: null, body: text }
}
