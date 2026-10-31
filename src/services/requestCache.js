/**
 * 工坊云/讨论区只读查询的 SQLite 本地缓存
 *
 * 表 request_cache（migration v19）：cache_key = 命令名 + 排序后参数 JSON，
 * payload = 后端返回的完整 JSON（DTO 原样）。断连时回退展示看过的历史内容。
 *
 * 策略：
 * - 缓存优先命令：命中 → 立即返回缓存（标记 __fromCache），并后台请求网络回写，
 *   revalidate promise 随返回值暴露，页面据此刷新视图
 * - 仅回退命令：先请求网络，成功回写缓存；失败时才读取缓存
 * - 网络失败且命中缓存 → 降级返回（页面展示「本地缓存」标注）
 * - 写操作成功后按命令族失效相关缓存（见 dbCall 的 WRITE_FAMILIES）
 *
 * 所有 sqlite 异常均静默：缓存永远不干扰主流程。
 */

import { getDb, getConfig, setConfig } from './dbHelper'

// 保留策略：按总 payload UTF-8 字节数淘汰，而不是固定行数。
// 目标：数据库不可达时尽量保留用户浏览过的历史页面。100MB 对 25MB 级云库的
// 快照缓存足够覆盖长期浏览；MAX_ROWS 仅作为极端参数组合刷爆行数时的兜底。
const MAX_BYTES = 100 * 1024 * 1024
const MAX_ROWS = 5000
// 命中读取后刷新 cached_at 的最小间隔：让真正看过的内容在字节淘汰时保持较新，
// 同时避免每次页面加载都写一次 SQLite。
const TOUCH_INTERVAL_MS = 60 * 60 * 1000
// 实体索引：把列表快照里出现过的 mod/讨论映射到具体 cache_key，
// 避免通知跳转时为了找一个详情而解析所有列表 JSON。表由前端懒创建。
const ENTITY_TABLE = 'request_cache_entities'
// VACUUM 冷却：VACUUM 会重写整个 DB，不能每次裁剪都跑
const VACUUM_INTERVAL_MS = 10 * 60 * 1000
const VACUUM_FREE_RATIO = 0.15
// 实体索引批量插入条数：每条 6 个绑定参数，150 条 = 900 参数，低于 SQLite 999 上限
const ENTITY_INSERT_CHUNK = 150
// 历史缓存回填时每批读取的缓存行数：避免一次性把全部 payload 读进内存
const BACKFILL_BATCH = 100
// 实体索引的“已完成回填”标记。用标记而不是「索引表非空」判断：
// 回填中途失败后仍会重跑，避免旧缓存行永久没有索引、每次都退回全量扫描。
// 索引结构变化时递增这个版本号即可触发一次重建。
const ENTITY_INDEX_VERSION = '2'
const ENTITY_INDEX_MARKER = 'cache_entity_index_version'

// 索引表建表（幂等，首次几次 IPC）与历史回填（重活）分开：
// 写入路径只等建表，回填永远在后台跑，避免首次打开详情时卡住。
let entityTablePromise = null
let entityBackfillPromise = null
let lastVacuumAt = 0
// 缓存总字节的近似值（null = 未校准）。只有超过预算时才做精确统计，
// 避免每次写入都全表 CAST(payload AS BLOB) 求和（100MB 级约 100ms）。
let approxBytes = null

/** 参数键排序后序列化，保证同参同串 */
function stableJson(args) {
  const sorted = {}
  for (const k of Object.keys(args).sort()) sorted[k] = args[k]
  return JSON.stringify(sorted)
}

/** 生成缓存键：参数键排序后 JSON 序列化，保证同参同键 */
export function makeCacheKey(command, args) {
  return `${command}?${stableJson(args)}`
}

/** 命中读取后刷新 cached_at（真正的 LRU）：看过的旧内容不应被当成最旧淘汰 */
function touchCache(db, key, cachedAt) {
  const now = Date.now()
  if (!cachedAt || now - Number(cachedAt) < TOUCH_INTERVAL_MS) return
  try {
    db.execute('UPDATE request_cache SET cached_at = $1 WHERE cache_key = $2', [now, key])
      .catch(() => { /* 静默：时间戳更新失败不影响读取 */ })
  } catch {
    // 静默：同步异常同样不能影响读取
  }
}

/** cache_key 的命令名前缀 */
function commandFromKey(key) {
  const idx = key.indexOf('?')
  return idx >= 0 ? key.slice(0, idx) : key
}

/** 从一条缓存 payload 中提取可索引实体（mod / 讨论） */
function collectEntities(command, payload) {
  const out = []
  const seen = new Set()
  const add = (type, item) => {
    if (!item || typeof item !== 'object') return
    const id = Number(item.id) || Number(item.mod_id) || 0
    const key = item.mod_key ? String(item.mod_key) : ''
    if (!id && !key) return
    const dedupe = `${type}:${id}:${key}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    out.push({ type, id, key })
  }
  const addList = (type, list) => {
    if (Array.isArray(list)) for (const item of list) add(type, item)
  }

  if (command === 'db_get_mod_detail') add('mod', payload?.data?.mod)
  else if (command === 'db_get_discussion_detail') add('discussion', payload?.data?.discussion)
  else if (command.startsWith('db_list_') && command.includes('mods')) {
    addList('mod', payload)
    addList('mod', payload?.mods)
    addList('mod', payload?.data?.mods)
  } else if (command.startsWith('db_list_') && command.includes('discussions')) {
    addList('discussion', payload)
    addList('discussion', payload?.data?.discussions)
    addList('discussion', payload?.discussions)
  }
  return out
}

async function ensureEntityTable(db) {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${ENTITY_TABLE} (
      cache_key TEXT NOT NULL,
      command TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL DEFAULT 0,
      entity_key TEXT NOT NULL DEFAULT '',
      cached_at INTEGER NOT NULL,
      PRIMARY KEY (cache_key, entity_type, entity_id, entity_key)
    )`,
  )
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_request_cache_entities_lookup
     ON ${ENTITY_TABLE} (entity_type, entity_id, entity_key)`,
  )
  // 按 mod_key 定位需要独立的 (entity_type, entity_key) 索引：
  // 复合索引里 entity_key 是第三列，`entity_key = ?` 用不上它，
  // 而 WHERE 里的 OR 也不会让 SQLite 合并两个索引。
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_request_cache_entities_key
     ON ${ENTITY_TABLE} (entity_type, entity_key)`,
  )
}

/**
 * 为一条缓存写入实体索引；无实体（评论/投票等）时直接跳过。
 * 每次都全量刷新：同一 cache_key 的内容（列表页）可能已经变了。
 */
async function indexPayload(db, command, cacheKey, payload, cachedAt) {
  const entities = collectEntities(command, payload)
  if (!entities.length) return
  try {
    await db.execute(`DELETE FROM ${ENTITY_TABLE} WHERE cache_key = $1`, [cacheKey])
    // 批量插入：一条列表缓存可能有几十个实体，逐条 execute 会产生几十次 IPC。
    // 每条 6 个参数，150 条 = 900 参数，低于 SQLite 默认 999 上限。
    for (let i = 0; i < entities.length; i += ENTITY_INSERT_CHUNK) {
      const part = entities.slice(i, i + ENTITY_INSERT_CHUNK)
      const params = []
      const rows = part.map((ent) => {
        const base = params.length
        params.push(cacheKey, command, ent.type, ent.id, ent.key, cachedAt)
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
      })
      await db.execute(
        `INSERT OR REPLACE INTO ${ENTITY_TABLE}
         (cache_key, command, entity_type, entity_id, entity_key, cached_at)
         VALUES ${rows.join(', ')}`,
        params,
      )
    }
  } catch {
    // 静默：索引失败时仍可退回扫列表快照
  }
}

/** 确保实体索引表存在，返回可用的 db；失败返回 null（调用方退回扫描） */
async function ensureEntityTableReady() {
  if (!entityTablePromise) {
    entityTablePromise = (async () => {
      const db = await getDb()
      await ensureEntityTable(db)
      return db
    })().catch(() => {
      entityTablePromise = null
      return null
    })
  }
  return entityTablePromise
}

/**
 * 后台回填实体索引（每个索引版本只做一次）。
 * 用「未完成标记」判断，而不是「索引表非空」：回填中途失败后下次仍会继续，
 * 不会让旧缓存行永久没有索引、导致每次回退都退回全量扫描。
 */
function scheduleEntityBackfill() {
  if (entityBackfillPromise) return entityBackfillPromise
  entityBackfillPromise = (async () => {
    const db = await ensureEntityTableReady()
    if (!db) return
    const marker = await getConfig(ENTITY_INDEX_MARKER)
    if (marker === ENTITY_INDEX_VERSION) return

    // 只挑「完全没有索引行」的缓存：一条 LEFT JOIN 就能筛出待补行，不用逐行探测。
    // 用 cache_key 游标推进，解析失败的坏行也不会让循环卡住。
    let cursor = ''
    for (;;) {
      const rows = await db.select(
        `SELECT r.cache_key, r.payload, r.cached_at
         FROM request_cache r
         LEFT JOIN ${ENTITY_TABLE} e ON e.cache_key = r.cache_key
         WHERE e.cache_key IS NULL AND r.cache_key > $1
         ORDER BY r.cache_key
         LIMIT ${BACKFILL_BATCH}`,
        [cursor],
      )
      if (!rows.length) break
      for (const row of rows) {
        const command = commandFromKey(row.cache_key)
        let payload
        try {
          payload = JSON.parse(row.payload)
        } catch {
          continue
        }
        await indexPayload(db, command, row.cache_key, payload, row.cached_at)
      }
      cursor = String(rows[rows.length - 1].cache_key)
    }
    await setConfig(ENTITY_INDEX_MARKER, ENTITY_INDEX_VERSION)
  })().catch(() => {
    // 失败不写标记：下次继续（已补过的行有索引，不会再被选中）
    entityBackfillPromise = null
  })
  return entityBackfillPromise
}

/**
 * 候选排序：同语言优先，再按缓存时间倒序。
 * 详情类命令的 cache_key 带 lang，跨语言快照的 name/description 是与语言相关的字段，
 * 能命中同语言快照时优先用它；实在没有（例如离线且只浏览过其他语言）才退回最近的快照。
 * 列表命令也带 lang，同样适用。
 */
function orderCandidates(rows, preferLang = null) {
  for (const row of rows) row.args = parseCacheKeyArgs(row.command, row.cache_key)
  rows.sort((a, b) => {
    if (preferLang) {
      const la = a.args?.lang === preferLang ? 1 : 0
      const lb = b.args?.lang === preferLang ? 1 : 0
      if (la !== lb) return lb - la
    }
    return (Number(b.cached_at) || 0) - (Number(a.cached_at) || 0)
  })
  return rows
}

/**
 * 按实体索引查找 cache_key，避免全量 JSON.parse。
 * id 与 mod_key 分成两条查询：WHERE 里用 OR 会让 SQLite 只能吃到
 * entity_type 前缀（实测），分拆后各自走 (entity_type, entity_id) /
 * (entity_type, entity_key) 索引。按 id 通常第一条就命中，key 查询极少发生。
 */
async function findIndexedEntity(entityType, id, entityKey, commands, extract, userId, preferLang = null) {
  try {
    const db = await getDb()
    const conditions = []
    if (id) conditions.push({ column: 'entity_id', value: id })
    if (entityKey) conditions.push({ column: 'entity_key', value: entityKey })
    if (!conditions.length) return null

    const placeholders = commands.map((_, i) => `$${i + 3}`).join(', ')
    const seen = new Set()
    const rows = []
    for (const cond of conditions) {
      const part = await db.select(
        `SELECT r.cache_key, r.payload, r.cached_at, e.command
         FROM ${ENTITY_TABLE} e
         JOIN request_cache r ON r.cache_key = e.cache_key
         WHERE e.entity_type = $1 AND e.${cond.column} = $2
           AND e.command IN (${placeholders})
         ORDER BY r.cached_at DESC, r.cache_key DESC`,
        [entityType, cond.value, ...commands],
      )
      for (const row of part) {
        if (seen.has(row.cache_key)) continue
        seen.add(row.cache_key)
        rows.push(row)
      }
    }
    orderCandidates(rows, preferLang)
    for (const row of rows) {
      const args = row.args
      if (!args || !matchesIdentity(args, userId)) continue
      let payload
      try {
        payload = JSON.parse(row.payload)
      } catch {
        continue
      }
      let item = null
      try {
        item = extract(payload)
      } catch {
        continue
      }
      if (item) {
        touchCache(db, row.cache_key, row.cached_at)
        // 一并带回来源命令与参数：调用方据此判断该快照属于哪个用户视角
        return { item, cachedAt: row.cached_at, command: row.command, args }
      }
    }
    return null
  } catch {
    return null
  }
}

/** 按空闲页比例决定是否 VACUUM，避免数据库文件只增不减 */
async function vacuumIfNeeded(db) {
  const now = Date.now()
  if (now - lastVacuumAt < VACUUM_INTERVAL_MS) return
  try {
    const pageRows = await db.select('SELECT page_count FROM pragma_page_count')
    const freeRows = await db.select('SELECT freelist_count FROM pragma_freelist_count')
    const pages = Number(pageRows?.[0]?.page_count) || 0
    const free = Number(freeRows?.[0]?.freelist_count) || 0
    if (pages <= 0 || free <= 0) return
    if (free / pages < VACUUM_FREE_RATIO) return
    // 先记时间再执行：VACUUM 需要独占数据库，失败（如 database is locked）时
    // 也要进入冷却，避免每次裁剪都重试一次全库重写
    lastVacuumAt = now
    await db.execute('VACUUM')
  } catch {
    // 静默：VACUUM 失败不影响缓存读写
  }
}

/** 精确统计缓存 payload 的 UTF-8 字节总量（全表扫描，只在必要时调用） */
async function measureBytes(db) {
  // 必须按字节算：SQLite 的 length(TEXT) 返回字符数，中文会低估约 3 倍
  const meta = await db.select(
    'SELECT SUM(length(CAST(payload AS BLOB))) AS total FROM request_cache',
  )
  return Number(meta?.[0]?.total) || 0
}

/** 字符串的 UTF-8 字节数（用于维护近似总量） */
function utf8Bytes(text) {
  const s = String(text)
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length
  return s.length * 3
}

/**
 * 写入后裁剪：先按行数兜底，再按总 payload 字节预算淘汰最旧行。
 * 两个检查都先走便宜的判据（COUNT / 内存近似值），只有真的超限才做
 * 全表排序或全表字节统计，避免每次写缓存都扫一遍 100MB 级数据。
 */
async function pruneRequestCache(db) {
  let changed = false
  try {
    const countRows = await db.select('SELECT COUNT(*) AS n FROM request_cache')
    if (Number(countRows?.[0]?.n) > MAX_ROWS) {
      const res = await db.execute(
        `DELETE FROM request_cache WHERE cache_key IN (
           SELECT cache_key FROM request_cache ORDER BY cached_at DESC LIMIT -1 OFFSET ${MAX_ROWS}
         )`,
      )
      if (Number(res?.rowsAffected) > 0) {
        changed = true
        // 行数裁剪删掉的是最旧的一批行，内存里的近似总量不再准确；
        // 置空让下面的字节检查改用 SUM 重新校准（裁剪本身已是重操作，多一次统计无妨）
        approxBytes = null
      }
    }
  } catch {
    // 静默
  }
  try {
    if (approxBytes == null) approxBytes = await measureBytes(db)
    if (approxBytes > MAX_BYTES) {
      const rows = await db.select(
        'SELECT cache_key, length(CAST(payload AS BLOB)) AS size FROM request_cache ORDER BY cached_at DESC, cache_key DESC',
      )
      let total = 0
      let acc = 0
      let dropped = 0
      const drop = []
      for (let i = 0; i < rows.length; i++) {
        const size = Number(rows[i].size) || 0
        total += size
        acc += size
        // 永远保留最新一条：即使单条 payload 超预算，也至少留一条可回退
        if (acc > MAX_BYTES && i > 0) {
          drop.push(rows[i].cache_key)
          dropped += size
        }
      }
      for (let i = 0; i < drop.length; i += 400) {
        const part = drop.slice(i, i + 400)
        const placeholders = part.map((_, j) => `$${j + 1}`).join(', ')
        await db.execute(`DELETE FROM request_cache WHERE cache_key IN (${placeholders})`, part)
      }
      // 裁剪后回到预算内：用精确总量重置近似值，避免下一次又触发全表统计
      approxBytes = Math.max(0, total - dropped)
      if (drop.length) changed = true
    }
  } catch {
    // 静默
  }
  if (!changed) return
  try {
    await db.execute(
      `DELETE FROM ${ENTITY_TABLE} WHERE cache_key NOT IN (SELECT cache_key FROM request_cache)`,
    )
  } catch {
    // 索引表尚未创建时忽略
  }
  // 不阻塞调用方：VACUUM 会重写整个库，失败也无所谓（下次裁剪再试）
  void vacuumIfNeeded(db)
}

// device_id 存在 localStorage，dev（http://localhost:5173）与生产（https://tauri.localhost）
// 属于不同 origin，会各自生成不同的设备 ID；而 request_cache 是两者共用的同一份 SQLite。
// 因此按精确键查找会漏掉「另一来源写入」的缓存。离线开发模式（dev:of）无法联网时，
// 需要忽略 device_id 再匹配一次同命令、同业务参数的缓存。
function omitDeviceId(args) {
  const rest = { ...args }
  delete rest.device_id
  return rest
}

/**
 * 命令名前缀的范围边界：`cmd?` ≤ cache_key < `cmd@`（'@' 紧邻 '?'）。
 * 比 `LIKE 'cmd?%'` 好：LIKE 前缀会让 SQLite 退化成全表扫描（实测），
 * 范围条件则能走 cache_key 主键索引。
 */
function commandRange(command) {
  return [`${command}?`, `${command}@`]
}

/**
 * 忽略 device_id 查找缓存：仅返回业务参数完全一致的最新一条。
 * user_id 等身份参数仍参与比较，避免跨账号展示他人权限/评分数据。
 */
export async function readRequestCacheIgnoringDevice(command, args) {
  if (!args || !('device_id' in args)) return null
  try {
    const db = await getDb()
    const [low, high] = commandRange(command)
    const rows = await db.select(
      'SELECT cache_key, payload, cached_at FROM request_cache WHERE cache_key >= $1 AND cache_key < $2 ORDER BY cached_at DESC',
      [low, high],
    )
    const wanted = stableJson(omitDeviceId(args))
    for (const row of rows) {
      let cachedArgs
      try {
        cachedArgs = JSON.parse(row.cache_key.slice(command.length + 1))
      } catch {
        continue
      }
      if (!cachedArgs || typeof cachedArgs !== 'object') continue
      if (stableJson(omitDeviceId(cachedArgs)) !== wanted) continue
      // 单行 payload 损坏（历史版本写入被截断等）时跳过该行继续找，
      // 不能因为一条坏数据就让整个忽略 device_id 的回退失效
      let payload
      try {
        payload = JSON.parse(row.payload)
      } catch {
        continue
      }
      touchCache(db, row.cache_key, row.cached_at)
      return { payload, cachedAt: row.cached_at }
    }
    return null
  } catch {
    return null
  }
}

/** 读缓存：命中返回 { payload, cachedAt }，未命中/异常返回 null */
export async function readRequestCache(key) {
  try {
    const db = await getDb()
    const rows = await db.select(
      'SELECT payload, cached_at FROM request_cache WHERE cache_key = $1',
      [key],
    )
    if (!rows.length) return null
    const payload = JSON.parse(rows[0].payload)
    touchCache(db, key, rows[0].cached_at)
    return { payload, cachedAt: rows[0].cached_at }
  } catch {
    return null
  }
}

// 缓存写/失效串行化：两者都是后台任务，但交错执行会破坏一致性——
// · 同一 cache_key 并发写时，两方读到相同的「旧行大小」，增量维护的近似总量会漂移；
// · 失效与迟到的写入交错时，刚删掉的缓存行会被旧响应重新写回。
// 串成一条链后顺序确定（先到先执行），调用方仍照常 await 自己的那一步。
let cacheQueue = Promise.resolve()

/** 把缓存任务串到队尾；单条任务内部已静默失败，这里只保证顺序与异常不串线 */
function enqueueCacheTask(task) {
  const run = cacheQueue.then(task)
  cacheQueue = run.then(
    () => {},
    () => {},
  )
  return run
}

/**
 * 写缓存（成功响应原样 JSON），附带字节预算裁剪。
 * cachedAt 用于「由列表快照合成的详情」：它应该沿用原始快照时间，
 * 否则第二次打开时提示的「缓存于 …」会变成刚刚。
 * 调用即入队，返回该次写入完成的 promise。
 */
export function writeRequestCache(key, payload, cachedAt = null) {
  return enqueueCacheTask(() => doWriteRequestCache(key, payload, cachedAt))
}

async function doWriteRequestCache(key, payload, cachedAt) {
  try {
    // 只等建表（幂等）；历史回填放后台，首次要跑几千次索引 IPC 不能阻塞写路径
    const db = (await ensureEntityTableReady()) || (await getDb())
    void scheduleEntityBackfill()
    const now = Number(cachedAt) || Date.now()
    const json = JSON.stringify(payload)
    // 先取旧行大小（主键点查）。INSERT OR REPLACE 覆盖同一 cache_key 时，
    // 若无脑累加新值，近似总量会随重复写入持续虚高，最终误触发淘汰、删掉本不该删的历史。
    // 只在近似值已校准（approxBytes != null）时才多这一次查询。
    let prevBytes = 0
    if (approxBytes != null) {
      try {
        const prev = await db.select(
          'SELECT length(CAST(payload AS BLOB)) AS size FROM request_cache WHERE cache_key = $1',
          [key],
        )
        prevBytes = Number(prev?.[0]?.size) || 0
      } catch {
        // 查不到旧行大小就当作 0：近似值偏大，仍由裁剪时的精确统计自愈
        prevBytes = 0
      }
    }
    await db.execute(
      'INSERT OR REPLACE INTO request_cache (cache_key, payload, cached_at) VALUES ($1, $2, $3)',
      [key, json, now],
    )
    // 精确增减：加上新 payload 的 UTF-8 字节、扣掉被覆盖的旧行
    if (approxBytes != null) approxBytes = Math.max(0, approxBytes + utf8Bytes(json) - prevBytes)
    await indexPayload(db, commandFromKey(key), key, payload, now)
    await pruneRequestCache(db)
  } catch {
    // 静默：写缓存失败不影响请求结果
  }
}

/**
 * 按命令名前缀失效：prefix 即命令名（内部拼 '?'），如 'db_get_comments'。
 * 与写入共用一条队列：排在已入队的写入之后执行，避免「刚失效又被迟到的写复活」。
 */
export function invalidateRequestCache(commandNames) {
  return enqueueCacheTask(() => doInvalidateRequestCache(commandNames))
}

async function doInvalidateRequestCache(commandNames) {
  try {
    const db = await getDb()
    let deleted = 0
    for (const name of commandNames) {
      const [low, high] = commandRange(name)
      const res = await db.execute(
        'DELETE FROM request_cache WHERE cache_key >= $1 AND cache_key < $2',
        [low, high],
      )
      deleted += Number(res?.rowsAffected) || 0
      try {
        await db.execute(
          `DELETE FROM ${ENTITY_TABLE} WHERE cache_key >= $1 AND cache_key < $2`,
          [low, high],
        )
      } catch {
        // 索引表尚未创建时忽略
      }
    }
    // 删掉行后近似总量会偏大，置空让下次写入时重新校准
    if (deleted > 0) approxBytes = null
    // 大量失效（例如删帖/删 mod）同样会留下空闲页；不阻塞用户可见的写操作，
    // VACUUM 自带 try/catch 与冷却
    if (deleted > 100) void vacuumIfNeeded(db)
  } catch {
    // 静默
  }
}

/** 解析缓存键里的参数对象；解析失败返回 null */
function parseCacheKeyArgs(command, cacheKey) {
  try {
    const args = JSON.parse(cacheKey.slice(command.length + 1))
    return args && typeof args === 'object' ? args : null
  } catch {
    return null
  }
}

/**
 * 身份过滤：列表快照可能包含未公开草稿、个人点赞/评分等。
 * 缓存键里出现 user_id/author_id 时，必须与当前用户一致；当前用户未知时
 * 不允许读取任何带身份参数的快照，避免换账号后读到上一个账号的私有内容。
 */
function matchesIdentity(args, userId) {
  const want = userId == null ? null : String(userId)
  for (const field of ['user_id', 'author_id']) {
    const got = args[field]
    if (got == null) continue
    if (want == null || String(got) !== want) return false
  }
  return true
}

/**
 * 在已缓存的列表快照中查找某个实体。
 * 列表 DTO 通常已包含详情页所需的主体字段，详情缓存缺失（例如通知跳转从未打开过该页）
 * 时可用它做只读回退，避免整个详情页打不开。
 * 优先走实体索引；索引还没建好（首次升级后的旧缓存）才回退到扫描。
 * preferLang：命中多个语言的快照时优先同语言（见 orderCandidates）。
 */
async function findCachedInPayloads(entityType, id, entityKey, commands, extract, userId = null, preferLang = null) {
  // 没有任何定位条件时直接返回，避免索引查询退化为匹配所有 entity_id=0 的行
  if (!id && !entityKey) return null
  try {
    // 后台回填，不阻塞这次读取：索引没建好就用下面的扫描兜底
    void scheduleEntityBackfill()
    const indexed = await findIndexedEntity(entityType, id, entityKey, commands, extract, userId, preferLang)
    if (indexed) return indexed

    const db = await getDb()
    const candidates = []
    for (const command of commands) {
      const [low, high] = commandRange(command)
      const rows = await db.select(
        'SELECT cache_key, payload, cached_at FROM request_cache WHERE cache_key >= $1 AND cache_key < $2',
        [low, high],
      )
      for (const row of rows) candidates.push({ ...row, command })
    }
    // 与索引路径一致：同语言优先，再跨命令按缓存时间全局排序，
    // 避免优先取到更旧的列表快照或语言不符的详情
    orderCandidates(candidates, preferLang)
    for (const row of candidates) {
      const args = row.args
      if (!args || !matchesIdentity(args, userId)) continue
      let payload
      try {
        payload = JSON.parse(row.payload)
      } catch {
        continue
      }
      const item = (() => {
        try {
          return extract(payload)
        } catch {
          return null
        }
      })()
      if (item) {
        // 命中时刷新这一行的索引：能扫到说明索引缺失/过期，修复后下次直接走索引
        await indexPayload(db, row.command, row.cache_key, payload, row.cached_at)
        touchCache(db, row.cache_key, row.cached_at)
        return { item, cachedAt: row.cached_at, command: row.command, args }
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 从列表/详情缓存中查找 mod（通知跳转/离线打开详情时用）。
 * lang 用于在多个语言版本的快照里优先选同语言的一条（详情 DTO 的
 * name/description 与请求语言绑定，跨语言展示会与界面语言不一致）。
 */
export function findCachedMod(modId, modKey = null, userId = null, lang = null) {
  const id = Number(modId) || 0
  const pick = (list) => (Array.isArray(list)
    ? list.find((m) => (id && Number(m.id) === id) || (modKey && m.mod_key === modKey))
    : null)
  return findCachedInPayloads(
    'mod', id, modKey || '',
    ['db_list_mods', 'db_list_my_mods', 'db_list_liked_mods', 'db_list_rated_mods', 'db_get_mod_detail'],
    (payload) => pick(payload?.mods) || pick(payload?.data?.mods)
      || (payload?.data?.mod ? pick([payload.data.mod]) : null),
    userId,
    lang,
  )
}

/** 从列表/详情缓存中查找讨论帖（通知跳转/离线打开详情时用） */
export function findCachedDiscussion(discussionId, userId = null) {
  const id = Number(discussionId) || 0
  const pick = (list) => (Array.isArray(list)
    ? list.find((d) => Number(d.id) === id)
    : null)
  return findCachedInPayloads(
    'discussion', id, '',
    ['db_list_discussions', 'db_list_liked_discussions', 'db_list_my_discussions', 'db_get_discussion_detail'],
    (payload) => pick(payload?.data?.discussions) || pick(payload?.discussions)
      || (payload?.data?.discussion ? pick([payload.data.discussion]) : null),
    userId,
  )
}
