import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Card, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Link, MessageBar, MessageBarBody, Select, Spinner, Switch, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import { Channel, invoke } from '@tauri-apps/api/core'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../components/common/EmptyState'
import { ListToolbar } from '../../components/common/ListToolbar'
import { Pagination } from '../../components/common/Pagination'
import { useGridColumns } from '../../hooks/useGridColumns'
import { useMouseBackButton } from '../../hooks/useMouseBackButton'
import { useF95BrowseStyles, useF95CardStyles } from './browseStyles'
import { CachedF95Post } from './CachedF95Post'
import { F95TranslationSettings } from '../settings/F95TranslationSettings'
import { F95TranslatedPost } from './F95TranslatedPost'
import { F95WebPane } from './F95WebPane'
import { ArrowLeft20Regular } from '@fluentui/react-icons'
import { isF95AttachmentLink } from './attachmentLinks'

const PAGE_SIZE = 20
const emptyLikes = { posts: new Set(), openings: {}, loaded: false }

function isModTopic(title) {
  const gameTag = /\[secret[\s-]+flasher[\s-]+manaka\s*\]|「Manaka」/i
  const modPrefix = /^(?:(?:collection|unity|completed)\s+)*(?:mod\b|\[mod\])/i
  return gameTag.test(title) ||
    (modPrefix.test(title) && /\bsecret[\s-]+flasher[\s-]+manaka\b/i.test(title))
}

const useStyles = makeStyles({
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  card: { alignItems: 'stretch', minWidth: 0, textAlign: 'left' },
  title: { flex: '0 0 auto', textAlign: 'left' },
  replyHeader: {
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalS,
    rowGap: tokens.spacingVerticalXXS,
    minWidth: 0,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightRegular,
  },
  replyTopic: { minWidth: 0, maxWidth: '100%' },
  replyFloor: { flexShrink: 0, whiteSpace: 'nowrap' },
  cardFooter: { marginTop: 'auto', alignSelf: 'flex-start', flexWrap: 'wrap' },
  summary: { color: tokens.colorNeutralForeground2 },
  topicPanel: { padding: '12px', gap: tokens.spacingVerticalS },
  topicPanelTitle: { margin: 0, overflowWrap: 'anywhere' },
  topicActions: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  cacheModeField: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  activityBar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  cachedDialog: { width: 'min(900px, calc(100vw - 32px))', maxWidth: 'none' },
  reader: {
    height: '100%', boxSizing: 'border-box', minWidth: 0, padding: '0 2px 8px',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  readerHeading: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM,
    flexShrink: 0, padding: '8px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  readerTitle: {
    margin: 0, fontSize: tokens.fontSizeBase500, lineHeight: tokens.lineHeightBase500,
    overflowWrap: 'anywhere',
  },
  readerBody: { minHeight: 0, minWidth: 0, flex: '1 1 auto', overflow: 'auto' },
  cachedArticle: {
    width: '100%', maxWidth: '1060px', boxSizing: 'border-box', margin: '0 auto',
    padding: tokens.spacingHorizontalL, overflowWrap: 'anywhere',
  },
  cachedActions: {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    flexShrink: 0, gap: tokens.spacingHorizontalS,
  },
  cachedText: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  cachedLinks: { display: 'grid', gap: tokens.spacingVerticalS, overflowWrap: 'anywhere' },
})

export function F95Page({ active = true, likedOnly = false }) {
  const { t } = useTranslation()
  const styles = useStyles()
  const browseStyles = useF95BrowseStyles()
  const cardStyles = useF95CardStyles()
  const action = useRef(false)
  const currentScan = useRef(null)
  const loadedCacheDirectory = useRef(null)
  const attachmentRequest = useRef(false)
  const accountRef = useRef(null)
  const pageRoot = useRef(null)
  const listScroll = useRef(null)
  const [busy, setBusy] = useState(null)
  const [status, setStatus] = useState('signedOut')
  const [error, setError] = useState(null)
  const [given, setGiven] = useState(emptyLikes)
  const [givenPartial, setGivenPartial] = useState(false)
  const [givenUnresolved, setGivenUnresolved] = useState(0)
  const [translationSettingsOpen, setTranslationSettingsOpen] = useState(false)
  const [scans, setScans] = useState({})
  const [stopping, setStopping] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [finished, setFinished] = useState(false)
  const [scanActivity, setScanActivity] = useState(null)
  const [threads, setThreads] = useState(null)
  const [forceContent, setForceContent] = useState(false)
  const [cachedPost, setCachedPost] = useState(null)
  const [original, setOriginal] = useState(null)
  const [accountPage, setAccountPage] = useState(null)
  const [layoutError, setLayoutError] = useState(false)
  const [attachment, setAttachment] = useState(null)
  const [selectedThread, setSelectedThread] = useState(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [source, setSource] = useState('all')
  const [sort, setSort] = useState('floor')
  const [page, setPage] = useState(1)
  const [itemsPerRow, setItemsPerRow] = useState(3)
  const [gridRef, gridColumns] = useGridColumns(itemsPerRow)
  const discovering = busy === 'f95_discover_threads'
  const updatingThreads = busy === 'f95_update_threads'
  const refreshingLikes = busy === 'f95_refresh_likes'
  const syncingGiven = busy === 'f95_given_likes'
  const loading = busy === 'f95_scan_thread' || busy === 'f95_cached_thread'
  const signedIn = status === 'signedIn'
  const fetchingOpening = busy === 'f95_cache_thread_opening'
  const scanning = discovering || updatingThreads || refreshingLikes || busy === 'f95_scan_thread'
  const sample = selectedThread ? scans[selectedThread.url] : null
  const contentMode = forceContent || sample?.mode === 'content'
  const reading = Boolean(cachedPost || original || accountPage)

  // 侧键返回：复用 App 顶层唯一监听的分发机制，按最上层详情逐层关闭（与返回按钮同语义）。
  const handleMouseBack = useCallback(() => {
    if (accountPage) {
      setAccountPage(null)
      return true
    }
    if (original) {
      setOriginal(null)
      return true
    }
    if (cachedPost) {
      setCachedPost(null)
      return true
    }
    return false
  }, [accountPage, original, cachedPost])
  useMouseBackButton(handleMouseBack, { active })

  const activityLabel = fetchingOpening ? t('f95.cachingOpening')
    : discovering ? t('f95.discovering')
    : updatingThreads ? t('f95.updatingThreads')
      : refreshingLikes ? t('f95.refreshingLikes')
        : scanActivity ? t('f95.pageActivity', scanActivity) : t('f95.checkingSample')
  const coverageLabel = sample?.coverage === 'complete' ? 'f95.scanReachedEnd'
    : sample?.coverage === 'partial' ? 'f95.scanIncomplete'
      : sample?.pages ? 'f95.scanCoverageUnknown' : 'f95.scanNotStarted'

  const run = useCallback(async (command, args, canFetch = false) => {
    if (action.current) return
    action.current = true
    setBusy(command)
    setError(null)
    setStopped(false)
    setFinished(false)
    setScanActivity(null)
    const applyScan = snapshot => setScans(previous => {
      const earlier = previous[args.threadUrl]
      const livePreviews = new Map(earlier?.entries.map(entry => [entry.id, entry.preview]))
      const entries = command === 'f95_scan_thread' || command === 'f95_cached_thread' || command === 'f95_cache_thread_opening'
        ? snapshot.entries.map(entry => ({ ...entry, preview: entry.preview || livePreviews.get(entry.id) || '' }))
        : snapshot.entries
      return { ...previous, [args.threadUrl]: { ...snapshot, entries } }
    })
    try {
      if (command === 'f95_given_likes') {
        const result = await invoke(command)
        setGiven(previous => {
          const posts = new Set(result.complete ? result.posts : [...previous.posts, ...result.posts])
          const openings = result.complete && !result.unresolved ? result.openings
            : Object.fromEntries(Object.entries({ ...previous.openings, ...result.openings }).filter(([, id]) => posts.has(id)))
          return { posts, openings, loaded: true }
        })
        setGivenPartial(!result.complete)
        setGivenUnresolved(result.unresolved ?? 0)
        return
      }
      if (command === 'f95_set_post_like') {
        const result = await invoke(command, {
          threadUrl: args.threadUrl, postId: args.postId ?? null, liked: args.liked,
        })
        setGiven(previous => {
          const posts = new Set(previous.posts)
          if (result.liked) posts.add(result.id)
          else posts.delete(result.id)
          const openings = args.isOpening ? { ...previous.openings, [args.threadUrl]: result.id } : previous.openings
          return { ...previous, posts, openings }
        })
        if (result.likes != null) {
          if (args.isOpening) {
            setThreads(previous => previous?.map(thread => thread.url === args.threadUrl
              ? { ...thread, likes: result.likes } : thread))
          }
          setScans(previous => {
            const scan = previous[args.threadUrl]
            if (!scan) return previous
            const entries = scan.entries.map(entry => entry.id === result.id
              ? { ...entry, likes: result.likes } : entry)
            return { ...previous, [args.threadUrl]: { ...scan, entries } }
          })
          setCachedPost(previous => previous?.id === result.id ? { ...previous, likes: result.likes } : previous)
        }
        return
      }
      if (command === 'f95_cached_thread') {
        const cached = await invoke(command, args)
        applyScan(cached)
        if (cached.pages || !canFetch) return
        command = 'f95_scan_thread'
        setBusy(command)
      }
      if (command === 'f95_set_cache_mode') {
        applyScan(await invoke(command, args))
        return
      }
      if (command === 'f95_set_force_content') {
        await invoke(command, { enabled: args.enabled })
        setForceContent(args.enabled)
        const cached = await invoke('f95_cached_threads')
        setScans(cached.scans)
        return
      }
      if (command === 'f95_cache_thread_opening') {
        const { post, scan } = await invoke(command, args)
        applyScan(scan)
        setLayoutError(false)
        setCachedPost({ ...post, threadUrl: args.threadUrl })
        return
      }
      if (command === 'f95_cached_post') {
        const post = await invoke(command, args)
        if (!post) {
          setError('cacheRead')
          return
        }
        setLayoutError(false)
        setCachedPost({ ...post, threadUrl: args.threadUrl })
        if (post.content_html || !canFetch) return
        command = 'f95_refresh_cached_post'
        setBusy(command)
      }
      if (command === 'f95_refresh_cached_post') {
        setLayoutError(false)
        try {
          const post = await invoke(command, args)
          setCachedPost(current => current?.id === post.id && current.threadUrl === args.threadUrl
            ? { ...post, threadUrl: args.threadUrl }
            : current)
        } catch {
          setLayoutError(true)
        }
        return
      }
      if (command === 'f95_discover_threads' || command === 'f95_update_threads' || command === 'f95_refresh_likes') {
        const progress = new Channel(result => {
          if (currentScan.current !== progress) return
          const updates = Array.isArray(result) ? result : [result.thread]
          setThreads(previous => {
            const merged = new Map((previous ?? []).map(thread => [thread.url, thread]))
            for (const thread of updates) merged.set(thread.url, thread)
            return [...merged.values()]
          })
          if (command === 'f95_refresh_likes') {
            setScans(previous => {
              const url = result.thread.url
              const previews = new Map(previous[url]?.entries.map(entry => [entry.id, entry.preview]))
              const entries = result.scan.entries.map(entry => ({
                ...entry, preview: entry.preview || previews.get(entry.id) || '',
              }))
              return { ...previous, [url]: { ...result.scan, entries } }
            })
          } else if (command === 'f95_update_threads') {
            setScans(previous => {
              const next = { ...previous }
              for (const thread of updates) {
                const scan = next[thread.url]
                if (!scan || thread.likes == null) continue
                next[thread.url] = {
                  ...scan,
                  entries: scan.entries.map(entry => entry.first ? { ...entry, likes: thread.likes } : entry),
                }
              }
              return next
            })
          }
        })
        currentScan.current = progress
        await invoke(command, { ...args, onProgress: progress })
        setFinished(true)
        return
      }
      if (command === 'f95_scan_thread') {
        const progress = new Channel(snapshot => {
          if (currentScan.current !== progress) return
          applyScan(snapshot)
          if (snapshot.activity) setScanActivity(snapshot.activity)
        })
        currentScan.current = progress
        await invoke(command, { scan: 'update', ...args, onProgress: progress })
        setFinished(true)
        return
      }
      await invoke(command, args)
      if (command === 'f95_sign_out') {
        currentScan.current = null
        accountRef.current = null
        setGiven(emptyLikes)
        setGivenPartial(false)
        setGivenUnresolved(0)
        setStatus('signedOut')
      }
    } catch (reason) {
      if (String(reason) === 'scanStopped') setStopped(true)
      else if (String(reason) !== 'givenBrowserOpen' || !args?.quiet) setError(String(reason))
      if (command === 'f95_scan_thread') {
        try {
          applyScan(await invoke('f95_cached_thread', { threadUrl: args.threadUrl }))
        } catch {
          // Leave the latest visible snapshot and the original operation error.
        }
      }
    } finally {
      action.current = false
      setStopping(false)
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    let mounted = true
    const scan = currentScan.current
    invoke('f95_cached_threads').then(cached => {
      if (mounted && currentScan.current === scan) {
        const sameDirectory = loadedCacheDirectory.current === cached.directory
        loadedCacheDirectory.current = cached.directory
        setThreads(cached.threads)
        setScans(previous => sameDirectory ? { ...cached.scans, ...previous } : cached.scans)
        if (!sameDirectory) {
          setSelectedThread(null)
          setCachedPost(null)
        }
        setForceContent(cached.forceContent)
      }
    }).catch(reason => {
      if (mounted && !action.current) setError(String(reason))
    })
    return () => { mounted = false }
  }, [active])

  useLayoutEffect(() => {
    if (!active || !listScroll.current) return
    const { container, top } = listScroll.current
    container.scrollTop = reading ? 0 : top
    if (!reading) listScroll.current = null
  }, [active, reading])

  useEffect(() => {
    if (!active) return
    let mounted = true
    let timer
    async function checkStatus() {
      if (!action.current) {
        try {
          const result = await invoke('f95_status')
          if (mounted && !action.current) {
            setStatus(result.status)
            if (result.status === 'signedIn') setAccountPage(null)
            if (accountRef.current !== result.account || result.status !== 'signedIn') {
              accountRef.current = result.account
              setGiven(emptyLikes)
              setGivenPartial(false)
              setGivenUnresolved(0)
            }
          }
        } catch (reason) {
          if (mounted && !action.current) setError(String(reason))
        }
      }
      if (mounted) timer = setTimeout(checkStatus, 1200)
    }
    checkStatus()
    return () => {
      mounted = false
      clearTimeout(timer)
    }
  }, [active])

  function likeButton(threadUrl, postId, isOpening, likes) {
    const liked = given.posts.has(postId)
    return (
      <Button
        size="small"
        appearance={liked ? 'primary' : 'secondary'}
        aria-pressed={liked}
        disabled={!signedIn || Boolean(busy)}
        onClick={() => run('f95_set_post_like', { threadUrl, postId, isOpening, liked: !liked })}
      >
        {t(liked ? 'f95.unlikePost' : 'f95.likePost')}
        {likes != null && ' · ' + t('f95.likeCount', { count: likes })}
      </Button>
    )
  }

  function selectThread(thread) {
    setSelectedThread(thread)
    run('f95_cached_thread', { threadUrl: thread.url }, signedIn)
  }

  async function stopScan() {
    setStopping(true)
    try {
      await invoke('f95_stop_scan')
    } catch (reason) {
      setError(String(reason))
      setStopping(false)
    }
  }

  const downloadAttachment = useCallback(async (url, label) => {
    if (attachmentRequest.current) return
    if (!signedIn) {
      setAttachment({ state: 'login' })
      setAccountPage('login')
      return
    }
    attachmentRequest.current = true
    setAttachment({ state: 'running', label })
    try {
      const path = await invoke('f95_download_attachment', { url })
      setAttachment({ state: 'done', path })
    } catch (reason) {
      if (String(reason) === 'sessionCheck') {
        setAttachment({ state: 'login' })
        setAccountPage('login')
      } else {
        setAttachment({ state: 'error', reason: String(reason) })
      }
    } finally {
      attachmentRequest.current = false
    }
  }, [signedIn])

  useEffect(() => {
    if (attachment?.state !== 'done') return
    const timer = setTimeout(() => {
      setAttachment(current => current === attachment ? null : current)
    }, 8000)
    return () => clearTimeout(timer)
  }, [attachment])

  const attachmentNotice = attachment && (
    <MessageBar intent={attachment.state === 'error' ? 'error' : attachment.state === 'done' ? 'success' : 'info'}>
      <MessageBarBody>
        {attachment.state === 'login' ? t(signedIn ? 'f95.attachmentRetry' : 'f95.attachmentLogin')
          : attachment.state === 'running' ? (
            <Spinner size="tiny" label={[t('f95.attachmentDownloading'), attachment.label].filter(Boolean).join(' ')} />
          )
          : attachment.state === 'done' ? (
            <>
              {t('workshop.downloadOnlyDone')}{' '}
              <Link as="button" onClick={() => invoke('open_folder', { path: attachment.path }).catch(() => setError('attachmentDestination'))}>
                {t('f95.showDownloadedAttachment')}
              </Link>
            </>
          ) : t('f95.errors.' + attachment.reason, { defaultValue: t('workshop.downloadOnlyFailed') })}
      </MessageBarBody>
    </MessageBar>
  )

  const cards = (threads ?? []).flatMap(thread => {
    const scanned = scans[thread.url]?.entries ?? []
    const opening = scanned.find(entry => entry.first)
    return [
      {
        key: 'thread:' + thread.url,
        kind: 'thread',
        thread,
        id: opening?.id ?? given.openings[thread.url],
        number: 1,
        title: thread.title,
        preview: opening?.preview || thread.preview,
        likes: opening?.likes ?? thread.likes,
        hasContent: opening?.hasContent,
      },
      ...scanned.filter(entry => !entry.first && entry.modTitle).map(entry => ({
        ...entry,
        key: 'post:' + entry.id,
        kind: 'reply',
        thread,
        title: t('f95.sampleReply', { number: entry.number }),
      })),
    ]
  }).filter(entry =>
    (!likedOnly || (signedIn && given.posts.has(entry.id) &&
      (entry.kind === 'reply' || isModTopic(entry.thread.title)))) &&
    (source === 'all' || entry.kind === source) &&
    [entry.title, entry.thread.title, entry.preview, entry.modTitle ?? ''].some(value => value.toLocaleLowerCase().includes(filter)),
  )
  cards.sort((a, b) =>
    (sort === 'likes'
      ? (b.likes ?? -1) - (a.likes ?? -1)
      : Number(a.kind === 'reply') - Number(b.kind === 'reply')) ||
    a.thread.title.localeCompare(b.thread.title) ||
    a.thread.url.localeCompare(b.thread.url) ||
    a.number - b.number,
  )
  const totalPages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const entries = cards.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  function rememberListScroll() {
    const container = pageRoot.current?.parentElement?.parentElement
    if (container) listScroll.current = { container, top: container.scrollTop }
  }

  function openAccount(mode) {
    rememberListScroll()
    setAccountPage(mode)
  }

  function openCard(entry) {
    rememberListScroll()
    if (entry.hasContent) {
      run('f95_cached_post', { threadUrl: entry.thread.url, postId: entry.id }, signedIn)
    } else if (entry.kind === 'thread') {
      const cacheContent = forceContent || scans[entry.thread.url]?.mode === 'content'
      if (cacheContent) run('f95_cache_thread_opening', { threadUrl: entry.thread.url })
      else setOriginal({ target: { kind: 'thread', value: entry.thread.url }, title: entry.thread.title })
    } else {
      setOriginal({ target: { kind: 'post', value: entry.id }, title: entry.thread.title, floor: entry.title })
    }
  }

  if (accountPage) {
    return (
      <section className={styles.reader} data-sfmmm-f95-view="">
        <header className={styles.readerHeading}>
          <Button icon={<ArrowLeft20Regular />} onClick={() => setAccountPage(null)}>
            {t(cachedPost ? 'f95.backToCachedPost' : 'f95.backToResults')}
          </Button>
          <h2 className={styles.readerTitle}>{t(accountPage === 'register' ? 'f95.register' : 'f95.accountLogin')}</h2>
        </header>
        {active && <F95WebPane key={accountPage} accountMode={accountPage} />}
      </section>
    )
  }

  if (original || cachedPost) {
    const title = original?.title || threads?.find(thread => thread.url === cachedPost?.threadUrl)?.title || t('f95.cachedContentTitle')
    const floor = original?.floor || (cachedPost?.number > 0 ? t('f95.sampleReply', { number: cachedPost.number }) : '')
    return (
      <section className={styles.reader} data-sfmmm-f95-view="">
        <header className={styles.readerHeading}>
          <Button icon={<ArrowLeft20Regular />} onClick={() => original ? setOriginal(null) : setCachedPost(null)}>
            {t(original && cachedPost ? 'f95.backToCachedPost' : 'f95.backToResults')}
          </Button>
          <div>
            <h2 className={styles.readerTitle}>{title}</h2>
            <Text size="small">{[original ? t('f95.originalPostView') : t('f95.cachedContentTitle'), floor].filter(Boolean).join(' · ')}</Text>
          </div>
        </header>
        {original ? active && <F95WebPane target={original.target} /> : (
          <F95TranslatedPost
            key={cachedPost.id + (cachedPost.content_html ?? cachedPost.content ?? '')}
            postId={cachedPost.id}
            renderLayout={({ actions, notice, body }) => (
              <>
                <div className={styles.cachedActions}>
                  {likeButton(cachedPost.threadUrl, cachedPost.id, cachedPost.first, cachedPost.likes)}
                  {!cachedPost.content_html && signedIn && busy !== 'f95_refresh_cached_post' && (
                    <Button size="small" disabled={Boolean(busy)}
                      onClick={() => run('f95_refresh_cached_post', { threadUrl: cachedPost.threadUrl, postId: cachedPost.id })}>
                      {t('f95.restoreLayout')}
                    </Button>
                  )}
                  <Button size="small" disabled={!signedIn || Boolean(busy)} onClick={() => setOriginal({
                    target: { kind: 'post', value: cachedPost.id }, title, floor,
                  })}>
                    {t('f95.openOriginalPost')}
                  </Button>
                  {actions}
                </div>
                {attachmentNotice}
                {error && <MessageBar intent="error">
                  <MessageBarBody>{t('f95.errors.' + error, { defaultValue: t('f95.errors.unexpected') })}</MessageBarBody>
                </MessageBar>}
                {notice}
                <div className={styles.readerBody}>
                  <article className={styles.cachedArticle} data-f95-cached-article="">
                    {body}
                  </article>
                </div>
              </>
            )}
          >
            {cachedPost.content_html ? (
              <CachedF95Post
                html={cachedPost.content_html}
                baseUrl={cachedPost.threadUrl}
                spoilerLabel={t('f95.cachedSpoiler')}
                onAttachment={downloadAttachment}
                attachmentsDisabled={Boolean(busy) || attachment?.state === 'running'}
              />
            ) : (
              <>
                {busy === 'f95_refresh_cached_post' ? (
                  <div data-sfmmm-translation-status="">
                    <Spinner size="tiny" label={t('f95.restoringLayout')} />
                  </div>
                ) : (
                  <Text size="small" className={styles.summary} data-sfmmm-translation-status="">
                    {t(layoutError ? 'f95.restoreLayoutFailed' : 'f95.plainTextCache')}
                  </Text>
                )}
                {(cachedPost.content ?? '').split(/\n{2,}/).filter(Boolean).map((paragraph, index) => (
                  <Text key={index} as="p" className={styles.cachedText}>{paragraph}</Text>
                ))}
                {cachedPost.links.length > 0 && (
                  <ul className={styles.cachedLinks} data-sfmmm-translation-status="">
                    {cachedPost.links.map(link => (
                      <li key={link.url}>
                        {isF95AttachmentLink(link.url) ? (
                          <Link as="button" disabled={Boolean(busy) || attachment?.state === 'running'}
                            onClick={() => downloadAttachment(link.url, link.label)}>
                            {link.label}
                          </Link>
                        ) : <Link href={link.url}>{link.label}</Link>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </F95TranslatedPost>
        )}
      </section>
    )
  }

  return (
    <div ref={pageRoot} className={browseStyles.root} data-sfmmm-f95-view="">
      <ListToolbar
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={value => { setFilter(value.trim().toLocaleLowerCase()); setPage(1) }}
        onRefresh={() => run('f95_update_threads')}
        refreshLabel={t('f95.updateKnown')}
        refreshDisabled={Boolean(busy) || !signedIn || !threads?.length}
        itemsPerRow={itemsPerRow}
        onItemsPerRowChange={setItemsPerRow}
        status={(
          <>
            {(scanning || fetchingOpening || stopped || finished) && (
              <div className={styles.activityBar} role="status">
                {scanning ? (
                  <>
                    <Spinner size="tiny" label={activityLabel} />
                    <Button size="small" disabled={stopping} onClick={stopScan}>
                      {t(stopping ? 'f95.stoppingScan' : 'f95.stopScan')}
                    </Button>
                  </>
                ) : (
                  <Text size="small">{t(stopped ? 'f95.scanStopped' : 'f95.activityFinished')}</Text>
                )}
              </div>
            )}
            {syncingGiven && <Spinner size="tiny" label={t('f95.syncingGiven')} />}
            {givenPartial && <MessageBar intent="warning">
              <MessageBarBody>{t('f95.givenPartial')}</MessageBarBody>
            </MessageBar>}
            {!givenPartial && givenUnresolved > 0 && <MessageBar intent="info">
              <MessageBarBody>{t('f95.givenMatchUnavailable')}</MessageBarBody>
            </MessageBar>}
            {!cachedPost && attachmentNotice}
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{t('f95.errors.' + error, { defaultValue: t('f95.errors.unexpected') })}</MessageBarBody>
              </MessageBar>
            )}
          </>
        )}
      >
        <Select
          size="small"
          aria-label={t('f95.sourceLabel')}
          value={source}
          onChange={(_, data) => { setSource(data.value); setPage(1) }}
        >
          <option value="all">{t('f95.allSources')}</option>
          <option value="thread">{t('f95.threadSource')}</option>
          <option value="reply">{t('f95.replySource')}</option>
        </Select>
        <Select
          size="small"
          aria-label={t('f95.sortLabel')}
          value={sort}
          onChange={(_, data) => { setSort(data.value); setPage(1) }}
        >
          <option value="floor">{t('f95.sortFloor')}</option>
          <option value="likes">{t('f95.sortLikes')}</option>
        </Select>
        {signedIn && (
          <Button size="small" disabled={Boolean(busy)} onClick={() => run('f95_given_likes')}>
            {t('f95.syncGiven')}
          </Button>
        )}
        <Button size="small" onClick={() => setTranslationSettingsOpen(true)}>
          {t('f95.translation.settingsTitle')}
        </Button>
        {!likedOnly && (
          <>
            <Switch
              label={t('f95.forceContent')}
              checked={forceContent}
              disabled={Boolean(busy) || threads === null}
              onChange={(_, data) => run('f95_set_force_content', { enabled: data.checked })}
            />
            <Button
              size="small"
              appearance="primary"
              disabled={Boolean(busy) || !signedIn}
              onClick={() => run('f95_discover_threads')}
            >
              {t('f95.searchNewThreads')}
            </Button>
            <Button
              size="small"
              disabled={Boolean(busy) || !signedIn || !threads?.length}
              onClick={() => run('f95_refresh_likes', { threadUrl: null })}
            >
              {t('f95.refreshLikes')}
            </Button>
          </>
        )}
        {signedIn ? (
          <Button size="small" disabled={Boolean(busy)} onClick={() => run('f95_sign_out')}>
            {t('f95.signOut')}
          </Button>
        ) : (
          <div className={styles.actions}>
            <Button size="small" disabled={Boolean(busy)} onClick={() => openAccount('login')}>
              {t(status === 'pending' ? 'f95.webLoginResume' : 'f95.login')}
            </Button>
            <Link as="button" disabled={Boolean(busy)} onClick={() => openAccount('register')}>
              {t('f95.register')}
            </Link>
          </div>
        )}
      </ListToolbar>
      {selectedThread && (
        <Card appearance="outline" className={styles.topicPanel}>
          <Text as="h3" weight="semibold" className={styles.topicPanelTitle}>
            {t('f95.scanTarget', { title: selectedThread.title })}
          </Text>
          <div className={styles.topicActions}>
            <label className={styles.cacheModeField}>
              <Text size="small">{t('f95.threadCacheMode')}</Text>
              <Select
                size="small"
                value={forceContent ? 'content' : sample?.mode ?? 'addresses'}
                disabled={Boolean(busy) || forceContent}
                onChange={(_, data) => run('f95_set_cache_mode', { threadUrl: selectedThread.url, mode: data.value })}
              >
                <option value="addresses">{t('f95.cacheAddresses')}</option>
                <option value="content">{t('f95.cacheContent')}</option>
              </Select>
            </label>
            {forceContent && <Text size="small" className={styles.summary}>{t('f95.cacheModeOverridden')}</Text>}
          </div>
          <div className={styles.topicActions}>
            <Button
              size="small"
              disabled={Boolean(busy) || !signedIn}
              onClick={() => run('f95_scan_thread', { threadUrl: selectedThread.url, scan: contentMode ? 'new' : 'update' })}
            >
              {t(contentMode ? 'f95.scanNewPosts' : 'f95.updateKnown')}
            </Button>
            {contentMode && (
              <Button
                size="small"
                disabled={Boolean(busy) || !signedIn || !sample?.entries.length}
                onClick={() => run('f95_scan_thread', { threadUrl: selectedThread.url, scan: 'recheck' })}
              >
                {t('f95.recheckPosts')}
              </Button>
            )}
            <Button
              size="small"
              disabled={Boolean(busy) || !signedIn}
              onClick={() => run('f95_scan_thread', { threadUrl: selectedThread.url, scan: 'full' })}
            >
              {t('f95.fullRescan')}
            </Button>
            <Button
              size="small"
              disabled={Boolean(busy) || !signedIn}
              onClick={() => run('f95_refresh_likes', { threadUrl: selectedThread.url })}
            >
              {t('f95.refreshThreadLikes')}
            </Button>
            <Button size="small" disabled={Boolean(busy)} onClick={() => setSelectedThread(null)}>
              {t('f95.clearScanTarget')}
            </Button>
          </div>
          {!loading && <Text size="small" className={styles.summary}>{t(coverageLabel)}</Text>}
          {sample?.pages > 0 && <Text size="small" className={styles.summary}>{t('f95.sampleResult', sample)}</Text>}
          {!contentMode && <Text size="small" className={styles.summary}>{t('f95.addressCacheHint')}</Text>}
        </Card>
      )}
      <Text size="small" className={styles.summary}>{t('f95.cardCount', { count: cards.length })}</Text>
      {entries.length > 0 ? (
        <>
          <div ref={gridRef} className={browseStyles.grid} style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }}>
            {entries.map(entry => (
              <Card key={entry.key} appearance="outline" className={mergeClasses(cardStyles.card, styles.card)}>
                <Link
                  as="button"
                  className={entry.kind === 'reply'
                    ? mergeClasses(styles.title, styles.replyHeader)
                    : mergeClasses(cardStyles.title, styles.title)}
                  title={entry.kind === 'reply' ? entry.thread.title : undefined}
                  disabled={Boolean(busy) || (!entry.hasContent && !signedIn)}
                  onClick={() => openCard(entry)}
                >
                  {entry.kind === 'reply' ? (
                    <>
                      <Text size={200} className={styles.replyTopic} truncate>{entry.thread.title}</Text>
                      <span className={styles.replyFloor}>{entry.title}</span>
                    </>
                  ) : entry.title}
                </Link>
                {entry.kind === 'reply' && (
                  <Text className={mergeClasses(cardStyles.title, styles.title)} title={entry.modTitle} truncate>
                    {entry.modTitle}
                  </Text>
                )}
                <Text className={cardStyles.description}>
                  {entry.preview || t(entry.hasContent || entry.kind === 'thread'
                    ? 'f95.noPreview'
                    : forceContent || scans[entry.thread.url]?.mode === 'content'
                      ? 'f95.contentNotCached'
                      : 'f95.addressOnlyPreview')}
                </Text>
                <div className={mergeClasses(styles.cardFooter, styles.actions)}>
                  <Text size="small">{t(entry.kind === 'thread' ? 'f95.threadSource' : 'f95.replySource')}</Text>
                  {likeButton(entry.thread.url, entry.id, entry.kind === 'thread', entry.likes)}
                  {!likedOnly && entry.kind === 'thread' && (
                    <Button size="small" disabled={Boolean(busy)} onClick={() => selectThread(entry.thread)}>
                      {t('f95.scanThisThread')}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
          <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
        </>
      ) : !scanning && !loading && !syncingGiven && (
        <EmptyState
          title={likedOnly && !signedIn ? t('f95.givenLikes')
            : filter || source !== 'all' ? t('workshop.noMods')
              : likedOnly && !given.loaded ? t('f95.givenNotLoaded')
                : t(likedOnly ? 'f95.givenEmpty' : 'f95.sampleEmpty')}
          description={filter ? t('workshop.noMatchHint') : !signedIn ? t('f95.signInToSearch')
            : likedOnly && given.loaded && given.posts.size > 0
              ? t('f95.givenUnmatched', { count: given.posts.size }) : undefined}
        />
      )}
      <Dialog open={translationSettingsOpen} onOpenChange={(_, data) => setTranslationSettingsOpen(data.open)}>
        <DialogSurface className={styles.cachedDialog}>
          <DialogBody>
            <DialogTitle>{t('f95.translation.settingsTitle')}</DialogTitle>
            <DialogContent><F95TranslationSettings showTitle={false} /></DialogContent>
            <DialogActions><Button onClick={() => setTranslationSettingsOpen(false)}>{t('f95.closeCachedPost')}</Button></DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
