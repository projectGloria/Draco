/**
 * A download session: one engine, one queue, for as long as the caller wants.
 *
 * `draco URL…` opens one, submits its URLs and waits for it to drain. The
 * full-screen UI opens one at start-up and keeps feeding it links, so a second
 * paste queues behind the first instead of waiting for it - and a playlist is
 * just many queued items that run in order.
 */
import { existsSync } from 'node:fs'
import { rmdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { DownloadTask, MediaVariant, RequestHeaders, YouTubeResolution } from '../shared/types.ts'
import { xPostUrl } from '../shared/x-post.ts'
import { normalizeDownloadDirectory } from '../main/destination-path.ts'
import { createTask, deterministicTaskId, filenameForKind, kindForUrl, validateUrl } from '../main/engine/create.ts'
import { closeDispatchers } from '../main/engine/http.ts'
import { DownloadManager, type EngineSettings, type ManagerOptions } from '../main/engine/manager.ts'
import { filenameFromUrl, sanitizeFilename } from '../main/engine/naming.ts'
import { probeUrl } from '../main/engine/probe.ts'
import { intermediatePathsFor } from '../main/engine/workspace.ts'
import { MpdRunner } from '../main/dash/runner.ts'
import { DashRunner } from '../main/hls/dash.ts'
import { JOIN_DETAIL, MUX_DETAIL } from '../main/hls/mux.ts'
import { resolveVariants } from '../main/hls/playlist.ts'
import { HlsRunner } from '../main/hls/runner.ts'
import { flushLogs } from '../main/log.ts'
import { couldBeHtmlPageUrl, isSupportedMediaPageUrl } from '../main/media-url.ts'
import { isPlaylistUrl, singleVideoUrl } from '../main/youtube-playlist.ts'
import { isSupportedYouTubeUrl, youtubeFormatId } from '../main/youtube-url.ts'
import { refreshYouTubeFormat, resolveMediaPage, resolvePlaylist, resolveYouTube } from '../main/youtube.ts'
import { isAudioVariant, pickVariant, type CliOptions, type FormatSpec } from './args.ts'
import { runMediaDownload } from './media-download.ts'
import { formatBytes, formatDuration, friendlyError, transfer, type Transfer } from './progress.ts'
import { cleanTitle, isTemplate, renderTemplate, type TemplateFields } from './template.ts'

/* ------------------------------------------------------------------ */
/* What a URL turned out to be                                         */
/* ------------------------------------------------------------------ */

/**
 * - `direct`: bytes at the URL itself (a file, a stream manifest, a magnet).
 * - `choice`: one item in several formats; `-f` picks one.
 * - `assets`: several distinct items on one page (an album, a gallery); all of
 *   the ones the resolver marks as default go, into a folder named for the page.
 * - `playlist`: a listing whose entries are each a `choice` once resolved.
 */
export type Resolved =
  | { type: 'direct'; url: string }
  | { type: 'choice'; pageUrl: string; title: string; variants: MediaVariant[]; meta: Meta }
  | { type: 'assets'; pageUrl: string; title: string; variants: MediaVariant[]; meta: Meta }
  | { type: 'playlist'; pageUrl: string; title: string; entries: Array<{ url: string; title: string }> }

/** What an output template can say about an item besides its title. */
interface Meta {
  id: string | null
  uploader: string | null
  uploadDate: string | null
}

const NO_META: Meta = { id: null, uploader: null, uploadDate: null }

function metaOf(media: YouTubeResolution): Meta {
  return { id: media.id || null, uploader: media.uploader ?? null, uploadDate: media.uploadDate ?? null }
}

/** One download the engine will run, before it becomes a task. */
interface Planned {
  url: string
  pageUrl: string | null
  dir: string
  filename?: string
  variant?: MediaVariant
  headers?: RequestHeaders
  /** A file whose presence means "already done"; defaults to `filename`, null means never skip. */
  skipIfExists?: string | null
}


/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

const PHOTO_CONTAINERS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])

/**
 * Choice or assets, for a media-page result.
 *
 * Anything yt-dlp extracted is a format of the one item it extracted, so those
 * are a choice - and when the page also had HTML-scraped extras, the extracted
 * item is the one people mean. Only when nothing was extracted are the
 * variants separate files. An explicit `-f` always means "pick one".
 */
function classifyMedia(pageUrl: string, media: YouTubeResolution, formatExplicit: boolean): Resolved {
  const extracted = media.variants.filter((v) => v.youtube)
  if (extracted.length > 0) {
    return { type: 'choice', pageUrl, title: media.title, variants: extracted, meta: metaOf(media) }
  }
  // An X post's syndication result is either one video in several qualities or
  // a gallery; the GUI tells them apart by the same markers.
  const xGallery = Boolean(xPostUrl(pageUrl)) && media.variants.some(
    (v) => PHOTO_CONTAINERS.has((v.container ?? '').toLowerCase()) || v.label.startsWith('Photo') || v.label.startsWith('Video ')
  )
  const single = media.variants.length === 1 || (Boolean(xPostUrl(pageUrl)) && !xGallery)
  return {
    type: single || formatExplicit ? 'choice' : 'assets',
    pageUrl,
    title: media.title,
    variants: media.variants,
    meta: metaOf(media)
  }
}

async function resolveInput(input: string, options: CliOptions, timeoutMs: number, status: Reporter): Promise<Resolved> {
  // Magnets are not URLs `validateUrl` knows; the torrent runner does.
  if (/^magnet:\?/i.test(input)) return { type: 'direct', url: input }
  let url = validateUrl(input)

  if (isPlaylistUrl(url)) {
    const single = options.noPlaylist ? singleVideoUrl(url) : null
    if (single) {
      url = single
    } else {
      status.set('Finding videos in your playlist…')
      const listing = await resolvePlaylist(url)
      return {
        type: 'playlist',
        pageUrl: url,
        title: listing.title,
        entries: listing.entries.map((e) => ({ url: e.url, title: e.title }))
      }
    }
  }

  if (isSupportedYouTubeUrl(url)) {
    status.set('Getting download details…')
    const yt = await resolveYouTube(url, { referer: url })
    return { type: 'choice', pageUrl: url, title: yt.title, variants: yt.variants, meta: metaOf(yt) }
  }

  if (isSupportedMediaPageUrl(url)) {
    status.set('Getting download details…')
    return classifyMedia(url, await resolveMediaPage(url, { referer: url }), options.formatExplicit)
  }

  const kind = kindForUrl(url)
  if (kind === 'hls') {
    // A master playlist is a quality ladder; a media playlist is just itself.
    status.set('Reading your playlist…')
    const variants = await resolveVariants(url, undefined).catch(() => [])
    if (variants.length > 1) {
      return { type: 'choice', pageUrl: url, title: filenameFromUrl(url)?.replace(/\.m3u8$/i, '') || 'stream', variants, meta: NO_META }
    }
    return { type: 'direct', url }
  }
  if (kind !== 'file' || !couldBeHtmlPageUrl(url)) return { type: 'direct', url }

  // No file suffix: could be a file behind a script, could be a page with a
  // player on it. Ask the server, and treat HTML as a page - which is exactly
  // the order the GUI's clipboard inbox takes.
  status.set('Checking your link…')
  let isHtml: boolean
  try {
    const probe = await probeUrl(url, { timeoutMs })
    isHtml = Boolean(probe.mimeType && /^(text\/html|application\/xhtml\+xml)\b/i.test(probe.mimeType))
  } catch {
    // Plenty of sites 403 a probe but serve the page - but only a URL that
    // looks like a page is worth a yt-dlp run on that hunch. `100Mb.dat` on a
    // server that is rate-limiting us is a file; the engine's own probe
    // retries it and reports the real error.
    isHtml = !/\.[a-z0-9]{1,8}$/i.test(filenameFromUrl(url) ?? '')
  }
  if (!isHtml) return { type: 'direct', url }
  status.set('Getting download details…')
  try {
    return classifyMedia(url, await resolveMediaPage(url, { referer: url }), options.formatExplicit)
  } catch {
    return { type: 'direct', url }
  }
}

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

function containerOf(variant: MediaVariant): string {
  return (variant.container || (isAudioVariant(variant) ? 'm4a' : 'mp4')).toLowerCase()
}

/** `-o name` with the variant's extension added when the user left it off. */
function outputName(output: string, variant: MediaVariant | undefined): string {
  if (!variant || /\.[a-z0-9]{2,5}$/i.test(output)) return output
  return `${output}.${containerOf(variant)}`
}

/** Title-based, as the GUI names a resolved video. */
function choiceFilename(title: string, variant: MediaVariant): string {
  return `${cleanTitle(title)}.${containerOf(variant)}`
}

/** Template fields for one chosen format of one item. */
function fieldsFor(title: string, variant: MediaVariant | undefined, meta: Meta, ext?: string | null): TemplateFields {
  return {
    title: cleanTitle(title),
    ext: ext ?? (variant ? containerOf(variant) : null),
    id: meta.id,
    uploader: meta.uploader,
    upload_date: meta.uploadDate,
    height: variant?.height ?? null,
    resolution: variant?.height ? `${variant.height}p` : variant && isAudioVariant(variant) ? 'audio only' : null,
    format_id: variant?.youtube
      ? [variant.youtube.videoFormatId, variant.youtube.audioFormatId].filter(Boolean).join('+')
      : null
  }
}

/** Port of the GUI's page-asset naming: keep real names, prefix generic ones. */
function assetFilename(groupName: string, variant: MediaVariant): string {
  let original = variant.label || 'download'
  try {
    original = decodeURIComponent(new URL(variant.url).pathname.split('/').filter(Boolean).pop() || '') || original
  } catch {}
  const dot = original.lastIndexOf('.')
  const stem = dot > 0 ? original.slice(0, dot) : original
  const extension = dot > 0 ? original.slice(dot).toLowerCase() : `.${containerOf(variant)}`
  if (!/^(?:\d{1,4}p?|video|audio|image|file|download|index|master|playlist|source|main)$/i.test(stem)) return original
  const quality = /^(\d{3,4})p?$/i.exec(stem)?.[1]
  return `${groupName}${quality ? ` - ${quality}p` : ` - ${stem}`}${extension}`
}

/** The name a direct URL will most likely be saved as, when it has a real one. */
function directGuess(url: string): string | null {
  const name = filenameFromUrl(url)
  return name && /\.[a-z0-9]{1,8}$/i.test(name) ? sanitizeFilename(name) : null
}

function folderName(title: string): string {
  return sanitizeFilename(title).replace(/^\.+|[. ]+$/g, '').slice(0, 120) || 'Draco download'
}

/** Same command, same id - so a rerun finds the partial its predecessor left. */
function stableTaskId(plan: Planned): string {
  return deterministicTaskId(
    plan.pageUrl ?? plan.url,
    plan.variant?.youtube ? `${plan.variant.youtube.videoFormatId}+${plan.variant.youtube.audioFormatId ?? ''}` : plan.url,
    plan.dir.toLowerCase(),
    (plan.filename ?? '').toLowerCase()
  )
}

function taskFor(plan: Planned): DownloadTask {
  const v = plan.variant
  const url = validateUrl(plan.url)
  const kind = kindForUrl(url)
  const task = createTask({
    url,
    sourceUrl: plan.pageUrl ?? undefined,
    dir: plan.dir,
    dirLocked: true,
    filename: plan.filename ? filenameForKind(plan.filename, kind) : undefined,
    kind,
    headers: plan.headers,
    audioUrl: v?.audioUrl ?? null,
    audioTracks: v?.audioTracks,
    expectedSize: v?.estimatedSize ?? null,
    youtube: v?.youtube && plan.pageUrl
      ? {
          pageUrl: plan.pageUrl,
          videoFormatId: v.youtube.videoFormatId,
          audioFormatId: v.youtube.audioFormatId ?? null,
          height: v.height,
          role: v.youtube.role ?? 'video'
        }
      : undefined
  })
  task.id = stableTaskId(plan)
  return task
}


/** One engine task as a progress card. */
export function transferOf(task: DownloadTask): Transfer {
  const title = task.filename || 'Your download'
  // Runners mux and join under status 'downloading'; without this the card
  // sat on a frozen full bar for as long as ffmpeg ran.
  if (task.status === 'downloading' && isFinishing(task)) {
    const step = task.detail === MUX_DETAIL ? 'Merging video and audio' : task.detail === JOIN_DETAIL ? 'Joining the pieces' : 'Checking the file'
    return transfer(task.id, title, 'finishing', { step })
  }
  switch (task.status) {
    case 'queued': return transfer(task.id, title, 'waiting')
    case 'probing': return transfer(task.id, title, 'preparing', { step: 'Connecting' })
    case 'processing': return transfer(task.id, title, 'finishing', { step: task.audioUrl ? 'Merging video and audio' : 'Finishing your file' })
    case 'scanning': return transfer(task.id, title, 'finishing', { step: 'Checking the file' })
    default: return transfer(task.id, title, 'downloading', {
      received: task.received, total: task.size ?? null, speed: task.speed || null, eta: task.eta ?? null
    })
  }
}

function printFormats(status: Reporter, title: string, variants: MediaVariant[]): void {
  status.info(`${title} · ${variants.length} format${variants.length === 1 ? '' : 's'}`)
  const rows = variants.map((v, i) => [
    `#${i + 1}`,
    v.label || (v.height ? `${v.height}p` : '-'),
    containerOf(v),
    v.estimatedSize ? formatBytes(v.estimatedSize) : '-',
    v.bandwidth ? `${Math.round(v.bandwidth / 1000)}k` : '-',
    v.codecs ?? '-',
    isAudioVariant(v) ? 'audio only' : v.audioUrl ? 'video+audio (merged)' : 'video'
  ])
  const header = ['ID', 'QUALITY', 'EXT', 'SIZE', 'BITRATE', 'CODECS', 'NOTE']
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)))
  const fmt = (r: string[]): string => r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd()
  status.info(fmt(header))
  status.info(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) status.info(fmt(r))
}


/* ------------------------------------------------------------------ */
/* The session: one engine, one queue                                 */
/* ------------------------------------------------------------------ */

/**
 * Where a session's events go. The plain CLI prints them (`Status` in
 * draco.ts); the full-screen UI draws them.
 */
export interface Reporter {
  /** A one-line "what is happening" shown while nothing is downloading yet. */
  set(message: string | null): void
  info(line: string): void
  error(line: string): void
  /** A finished file. The UI remembers it for F3 (open) and F4 (show in Explorer). */
  saved(path: string, line: string): void
  progress(transfers: Transfer[]): void
  /** What is waiting its turn, in order. */
  queue?(items: QueueItem[]): void
  clear(): void
}

export interface QueueItem { id: string; title: string; group: string | null }

export interface SessionConfig {
  options: CliOptions
  /** Where downloads go unless `submit` names another folder. */
  dir: string
  reporter: Reporter
  /** Asks which quality to take; the UI opens a picker, the plain CLI uses `-f`. */
  choose?: (variants: MediaVariant[], title: string, configured: FormatSpec) => Promise<FormatSpec>
  /** Downloads moving bytes at once. Merging, joining and scanning do not count. */
  lanes: number
  /** Test seams: a stand-in engine, and lookups that need no network. */
  engine?: (options: ManagerOptions) => Engine
  lookups?: { input?: typeof resolveInput; video?: typeof resolveYouTube }
}

/** The part of `DownloadManager` a session drives. */
export type Engine = Pick<DownloadManager, 'add' | 'pause' | 'start' | 'shutdown'>

export interface Session {
  /** Looks the link up and queues what it finds. Resolves once queued, not once downloaded. */
  submit(input: string, dir?: string): Promise<void>
  /** Pauses what is transferring and holds the queue. Merges in progress finish. */
  pause(): Promise<number>
  /** Continues paused downloads, then the queue. */
  resume(): boolean
  readonly paused: boolean
  /** Drops a waiting item. Only items not yet handed to the engine can go. */
  remove(id: string): boolean
  counts(): { transferring: number; finishing: number; waiting: number; resolving: number }
  /** Settles when nothing is resolving, waiting (unless paused) or running. */
  idle(): Promise<void>
  close(): Promise<void>
  readonly failures: number
}

/**
 * Bytes on the wire. A runner that is muxing or joining reports 'downloading'
 * all the way through - only its detail changes - and the manager counts it
 * as active until ffmpeg exits. That is why admission is decided here and not
 * by the manager's own `maxConcurrentTasks`: with the manager deciding, the
 * next video would wait out every merge.
 */
const FINISHING_DETAILS = new Set([MUX_DETAIL, JOIN_DETAIL, 'Verifying checksum...'])

export function isFinishing(task: DownloadTask): boolean {
  return task.status === 'processing' || task.status === 'scanning' ||
    (task.status === 'downloading' && FINISHING_DETAILS.has(task.detail ?? ''))
}

function isTransferring(task: DownloadTask): boolean {
  return (task.status === 'queued' || task.status === 'probing' || task.status === 'downloading') && !isFinishing(task)
}

/**
 * One queued item. `plan` is undefined until it has been looked up: playlist
 * entries are looked up just in time (one ahead), so the signed media URLs of
 * entry 300 are not fetched an hour before they are used.
 */
interface Job {
  id: string
  title: string
  /** Items sharing a group run one at a time - a playlist plays in order. */
  group: string | null
  plan?: Planned | null
  lookup?: () => Promise<Planned | null>
  looking?: Promise<void>
  /** Holds a lane while its lookup finishes, so a later item cannot jump it. */
  admitting?: boolean
  /** yt-dlp mode: the job runs `runMediaDownload` instead of the engine. */
  media?: { input: string; dir: string }
}

let jobCounter = 0

/** The person closed the quality picker: not a failure, nothing to retry. */
export class CancelledError extends Error {
  constructor() { super('Cancelled') }
}

export function createSession(config: SessionConfig): Session {
  const { options, reporter } = config
  const lanes = Math.max(1, config.lanes)
  const template = options.output && isTemplate(options.output) ? options.output : null
  // A literal `-o` stays what it always was: one file name for one URL.
  const literalOutput = template ? null : options.output
  const mediaMode = Object.keys(options.mediaOptions).length > 0
  const settings: EngineSettings = {
    // Admission is ours (see `isTransferring`); the manager just needs room
    // for the lanes plus the merges they leave behind.
    maxConcurrentTasks: lanes + 2,
    maxConnectionsPerTask: options.connections ?? 8,
    minSplitSize: 1024 * 1024,
    retryLimit: options.retries ?? 5,
    timeoutMs: (options.socketTimeout ?? 30) * 1000,
    speedLimit: options.rateLimit,
    proxyUrl: options.proxy ?? null,
    hostConnectionLimits: [],
    quotaBytes: null,
    quotaWindowMinutes: 60,
    antivirusProgram: null,
    antivirusArgs: [],
    antivirusTimeoutSeconds: 120,
    checkDiskSpace: true,
    exponentialBackoff: true,
    // A CLI run ends when its downloads do; seeding would keep it alive forever.
    seedTorrents: false
    // No `tempDir`: the GUI's shared workspace is its to clean up, and partials
    // from a run it knows nothing about would look like orphans there.
  }

  const ours = new Set<string>()
  const reported = new Set<string>()
  const startedAt = new Map<string, number>()
  const groupOf = new Map<string, string | null>()
  const byId = new Map<string, DownloadTask>()
  const pausedIds = new Set<string>()
  const pending: Job[] = []
  let latest: DownloadTask[] = []
  let failures = 0
  let resolving = 0
  let paused = false
  let pausing = false
  let closed = false
  let lookups = 0
  // Lookups run one after another, in submit order, so the queue keeps the
  // order links were pasted in and two quality pickers never open at once.
  let chain: Promise<void> = Promise.resolve()
  let choosing: Promise<unknown> = Promise.resolve()
  let media: { job: Job; controller: AbortController } | null = null

  const managerOptions: ManagerOptions = {
    getSettings: () => settings,
    onTasks: (tasks) => {
      latest = tasks
      byId.clear()
      for (const task of tasks) byId.set(task.id, task)
      report()
      // Every status change is a chance for the next item: a merge starting
      // frees its lane on the very update that says so.
      pump()
    },
    onProgress: () => {},
    createHlsRunner: (task, context) =>
      new HlsRunner(
        task,
        {
          maxConnections: context.maxConnections,
          retryLimit: context.retryLimit,
          timeoutMs: context.timeoutMs,
          tempDir: context.tempDir,
          checkDiskSpace: context.checkDiskSpace,
          exponentialBackoff: context.exponentialBackoff
        },
        { limiter: context.limiter, onUpdate: context.onUpdate, onFinished: context.onFinished, refreshYouTube: context.refreshYouTube, onProbed: context.onProbed }
      ),
    createMpdRunner: (task, context) => new MpdRunner(task, context),
    createDashRunner: (task, context) => new DashRunner(task, context),
    // Same as the GUI's: the audio half of a merged download refreshes its own
    // itag, and the requested height lets a vanished itag resolve to the same
    // quality rather than failing.
    refreshYouTube: async (task, force) => {
      if (!task.youtube) throw new Error('Missing YouTube source metadata')
      const audio = task.youtube.role === 'audio'
      const formatId = youtubeFormatId(task.youtube)
      if (!formatId) throw new Error('Missing YouTube format identity')
      return refreshYouTubeFormat(task.youtube.pageUrl, task.headers, formatId, force, {
        kind: audio ? 'audio' : 'video',
        height: audio ? null : task.youtube.height ?? null,
        delivery: !audio && task.kind === 'hls' ? 'hls' : undefined
      })
    }
  }
  const manager: Engine = config.engine ? config.engine(managerOptions) : new DownloadManager(managerOptions)
  const lookInput = config.lookups?.input ?? resolveInput
  const lookVideo = config.lookups?.video ?? resolveYouTube

  const ticker = setInterval(() => {
    const active = latest.filter((t) => ours.has(t.id) && !reported.has(t.id))
    reporter.progress(active.map(transferOf))
  }, 250)
  ticker.unref?.()

  /** Prints each of our downloads once, the moment it settles. */
  function report(): void {
    for (const task of latest) {
      if (!ours.has(task.id) || reported.has(task.id)) continue
      if (task.status !== 'done' && task.status !== 'error' && task.status !== 'missing' && task.status !== 'paused') continue
      reported.add(task.id)
      const where = join(task.dir, task.filename)
      if (task.status === 'paused' && pausing) {
        // Our own pause, not a failure: the partial is on disk to resume from.
        pausedIds.add(task.id)
        reporter.info(`Paused ${task.filename} · ${formatBytes(task.received)}${task.size ? ` of ${formatBytes(task.size)}` : ''} kept`)
      } else if (task.status === 'done') {
        const took = (Date.now() - (startedAt.get(task.id) ?? Date.now())) / 1000
        reporter.saved(where, `Saved ${task.filename} · ${formatBytes(task.size ?? task.received)} in ${formatDuration(took) ?? '0s'}`)
      } else {
        failures++
        reporter.error(`Could not download ${task.filename || task.url}: ${friendlyError(task.error || task.detail || task.status)}`)
      }
    }
  }

  /** Our tasks that are still the engine's business, by what they are doing. */
  function live(): { transferring: DownloadTask[]; finishing: number; unseen: string[] } {
    const transferring: DownloadTask[] = []
    const unseen: string[] = []
    let finishing = 0
    for (const id of ours) {
      if (reported.has(id)) continue
      const task = byId.get(id)
      if (!task) unseen.push(id) // added a moment ago; the next `onTasks` will show it
      else if (isTransferring(task)) transferring.push(task)
      else if (isFinishing(task)) finishing++
    }
    return { transferring, finishing, unseen }
  }

  function emitQueue(): void {
    reporter.queue?.(pending.map(({ id, title, group }) => ({ id, title, group })))
  }

  /**
   * Hands waiting items to the engine while there are free lanes. Synchronous
   * and idempotent, so it is safe to call from every engine update.
   */
  let pumping = false
  let pumpAgain = false

  function pump(): void {
    if (closed) return
    // Handing a task to the engine emits `onTasks`, which calls back in here.
    // A nested pass would work from the outer pass's stale view of the queue,
    // so it is deferred and run once the outer pass is done.
    if (pumping) { pumpAgain = true; return }
    pumping = true
    try {
      do {
        pumpAgain = false
        pumpOnce()
      } while (pumpAgain && !closed)
    } finally { pumping = false }
  }

  function pumpOnce(): void {
    if (mediaMode) { pumpMedia(); return }
    if (paused) { emitQueue(); return }
    const { transferring, unseen } = live()
    const busyGroups = new Set(transferring.map((t) => groupOf.get(t.id)).filter(Boolean))
    for (const id of unseen) if (groupOf.get(id)) busyGroups.add(groupOf.get(id)!)
    let free = lanes - transferring.length - unseen.length
    // Items picked by an earlier pass hold their lane (and their playlist's
    // turn) until they are handed over, looked up or not.
    for (const job of pending) {
      if (!job.admitting) continue
      free--
      if (job.group) busyGroups.add(job.group)
    }
    for (const job of [...pending]) {
      if (job.admitting) {
        if (job.plan !== undefined) admit(job)
        continue
      }
      // A lookup that failed (already reported) leaves nothing to run.
      if (job.plan === null) { admit(job); continue }
      if (free <= 0) continue
      if (job.group && busyGroups.has(job.group)) continue
      free--
      if (job.group) busyGroups.add(job.group)
      if (job.plan !== undefined) admit(job)
      else { job.admitting = true; lookUp(job) }
    }
    prefetch()
    emitQueue()
  }

  function admit(job: Job): void {
    const index = pending.indexOf(job)
    if (index < 0) return
    pending.splice(index, 1)
    if (job.plan) enqueue(job.plan, job.group)
  }

  function lookUp(job: Job): void {
    if (job.looking || !job.lookup) return
    lookups++
    job.looking = job.lookup().then(
      (plan) => { job.plan = plan },
      (error: unknown) => {
        job.plan = null
        if (error instanceof CancelledError) { reporter.info(`Skipped ${job.title}`); return }
        // One private or removed video must not sink the other 199.
        failures++
        reporter.error(`Skipped ${job.title}: ${friendlyError(error instanceof Error ? error.message : String(error))}`)
      }
    ).finally(() => { lookups--; pump() })
  }

  /**
   * Looks up the next unresolved item while the current one downloads, so the
   * handoff at merge time is instant instead of waiting on yt-dlp. One ahead
   * only: signed URLs expire, and a 400-entry playlist should not be 400
   * yt-dlp runs before the first byte.
   */
  function prefetch(): void {
    if (lookups > 0 || paused) return
    // Already one ready and waiting: that is the "one ahead".
    if (pending.some((job) => !job.admitting && job.plan)) return
    const next = pending.find((job) => job.plan === undefined && !job.looking)
    if (next) lookUp(next)
  }

  function enqueue(plan: Planned, group: string | null): void {
    const existing = plan.skipIfExists === undefined ? plan.filename : plan.skipIfExists
    if (existing && !options.force && existsSync(join(plan.dir, existing))) {
      reporter.saved(join(plan.dir, existing), `Already downloaded: ${existing} (use --force to download it again)`)
      return
    }
    const task = taskFor(plan)
    if (ours.has(task.id)) {
      // The same download again: a retry when the last attempt settled,
      // a duplicate when it is still running.
      if (!reported.has(task.id)) { reporter.info(`Already downloading ${task.filename}`); return }
      reported.delete(task.id)
      pausedIds.delete(task.id)
    }
    ours.add(task.id)
    groupOf.set(task.id, group)
    startedAt.set(task.id, Date.now())
    manager.add(task)
  }

  function push(job: Omit<Job, 'id'>): void {
    pending.push({ id: `q${++jobCounter}`, ...job })
  }

  /** Prints `-g` output for one variant, fetching a signed URL if needed. */
  async function printUrls(pageUrl: string, variant: MediaVariant): Promise<void> {
    let url = variant.url
    if (!url && variant.youtube) {
      url = await refreshYouTubeFormat(pageUrl, { referer: pageUrl }, variant.youtube.videoFormatId, false, {
        kind: isAudioVariant(variant) ? 'audio' : 'video',
        height: variant.height
      })
    }
    process.stdout.write(url + '\n')
    if (variant.audioUrl) process.stdout.write(variant.audioUrl + '\n')
  }

  async function choose(variants: MediaVariant[], title: string): Promise<MediaVariant> {
    if (config.choose) {
      // One picker at a time: a prefetch must not open a second one over the first.
      const asked = choosing.then(() => config.choose!(variants, title, options.format))
      choosing = asked.catch(() => {})
      options.format = await asked
    }
    const picked = pickVariant(variants, options.format)
    if (!picked) {
      throw new Error(
        options.format.kind === 'bestaudio'
          ? `${title}: no audio-only format available (see -F)`
          : `${title}: requested format not available (see -F)`
      )
    }
    return picked
  }

  /**
   * Where one item goes: under `base`, at the path the `-o` template names
   * (its folders included), or at `fallback` when there is no template.
   */
  function place(base: string, fields: TemplateFields, fallback: string | undefined): { dir: string; filename?: string } {
    if (!template) return { dir: base, filename: fallback }
    const full = resolve(base, renderTemplate(template, fields))
    return { dir: normalizeDownloadDirectory(dirname(full)), filename: basename(full) }
  }

  /** Looks one link up and turns it into queued jobs. */
  async function take(input: string, dir: string): Promise<void> {
    const busy = live().transferring.length > 0 || pending.length > 0
    const resolved = await lookInput(input, options, settings.timeoutMs, reporter)
    reporter.set(null)
    const verb = busy ? 'Queued' : 'Found'
    switch (resolved.type) {
      case 'direct': {
        if (options.listFormats) {
          reporter.info(`${resolved.url}: a direct download, so there is only one format`)
        } else if (options.getUrl) {
          process.stdout.write(resolved.url + '\n')
        } else {
          // The server may still rename it (Content-Disposition), but the
          // URL's own name is what a rerun of the same command produced -
          // without this, every rerun re-downloaded into "name (1).ext".
          // Only a name with an extension: "download" or "index" from a
          // script URL is too generic to treat as proof of anything.
          const guess = directGuess(resolved.url)
          // A template needs a title and an extension to work with, so it
          // only applies when the URL carries a real file name; otherwise
          // the server's name is the better answer than "NA.NA".
          const dot = guess ? guess.lastIndexOf('.') : -1
          const target = template && guess
            ? place(dir, fieldsFor(guess.slice(0, dot), undefined, NO_META, guess.slice(dot + 1)), undefined)
            : { dir, filename: literalOutput ?? undefined }
          if (busy) reporter.info(`${verb} ${target.filename ?? guess ?? resolved.url}`)
          push({
            title: target.filename ?? guess ?? resolved.url,
            group: null,
            plan: { url: resolved.url, pageUrl: null, dir: target.dir, filename: target.filename, skipIfExists: target.filename ?? guess }
          })
        }
        break
      }

      case 'choice': {
        if (options.listFormats) {
          printFormats(reporter, resolved.title, resolved.variants)
          break
        }
        const variant = await choose(resolved.variants, resolved.title)
        if (options.getUrl) {
          await printUrls(resolved.pageUrl, variant)
          break
        }
        reporter.info(`${verb} ${resolved.title} · ${variant.label || containerOf(variant)}${variant.audioUrl ? ' with audio' : ''}`)
        const target = place(
          dir,
          fieldsFor(resolved.title, variant, resolved.meta),
          literalOutput ? outputName(literalOutput, variant) : choiceFilename(resolved.title, variant)
        )
        push({
          title: resolved.title,
          group: null,
          plan: {
            url: variant.url || resolved.pageUrl,
            pageUrl: resolved.pageUrl,
            dir: target.dir,
            filename: target.filename,
            variant,
            headers: { referer: resolved.pageUrl }
          }
        })
        break
      }

      case 'assets': {
        const picked = resolved.variants.filter((v) => v.defaultSelected !== false && v.url)
        if (options.listFormats) {
          printFormats(reporter, resolved.title, resolved.variants)
          break
        }
        if (options.getUrl) {
          for (const v of picked) await printUrls(resolved.pageUrl, v)
          break
        }
        const group = folderName(resolved.title)
        const target = picked.length > 1 ? join(dir, group) : dir
        reporter.info(`${verb} ${resolved.title} · ${picked.length} file${picked.length === 1 ? '' : 's'}`)
        for (const v of picked) {
          const name = assetFilename(group, v)
          const dot = name.lastIndexOf('.')
          // Under a template each asset is its own item, named by its own
          // file name; the page title is available as %(playlist)s.
          const placed = template
            ? place(dir, {
                ...fieldsFor(dot > 0 ? name.slice(0, dot) : name, v, resolved.meta, dot > 0 ? name.slice(dot + 1) : null),
                playlist: resolved.title
              }, undefined)
            : { dir: target, filename: name }
          push({
            title: placed.filename ?? name,
            group: null,
            plan: {
              url: v.url,
              pageUrl: resolved.pageUrl,
              dir: placed.dir,
              filename: placed.filename,
              variant: v,
              headers: { referer: resolved.pageUrl }
            }
          })
        }
        break
      }

      case 'playlist': {
        const count = resolved.entries.length
        reporter.info(`${verb} playlist ${resolved.title} · ${count} video${count === 1 ? '' : 's'}`)
        if (options.listFormats) {
          resolved.entries.forEach((e, i) => reporter.info(`#${String(i + 1).padEnd(4)} ${e.title}  ${e.url}`))
          break
        }
        const target = join(dir, folderName(resolved.title))
        const indexWidth = String(count).length
        const group = `playlist:${++jobCounter}`
        for (const [i, entry] of resolved.entries.entries()) {
          const index = String(i + 1).padStart(indexWidth, '0')
          const lookup = async (): Promise<Planned | null> => {
            const yt = await lookVideo(entry.url, { referer: entry.url })
            const variant = await choose(yt.variants, yt.title)
            if (options.getUrl) {
              await printUrls(entry.url, variant)
              return null
            }
            // Without a template: `<playlist>/<NN> - <title>.<ext>`, numbered so
            // the folder sorts in playlist order. With one, the template decides.
            const placed = template
              ? place(dir, {
                  ...fieldsFor(yt.title, variant, metaOf(yt)),
                  playlist: resolved.title,
                  playlist_index: index
                }, undefined)
              : { dir: target, filename: `${index} - ${choiceFilename(yt.title, variant)}` }
            return {
              url: variant.url || entry.url,
              pageUrl: entry.url,
              dir: placed.dir,
              filename: placed.filename,
              variant,
              headers: { referer: entry.url }
            }
          }
          push({ title: entry.title, group, lookup })
        }
        break
      }
    }
  }

  /* ---- yt-dlp mode: draco.cfg asked for yt-dlp's own post-processing ---- */

  function pumpMedia(): void {
    if (paused || media || !pending.length) { emitQueue(); return }
    const job = pending.shift()!
    const controller = new AbortController()
    media = { job, controller }
    emitQueue()
    void runMediaDownload({ ...options, urls: [job.media!.input], dir: job.media!.dir }, reporter, controller.signal)
      .then((code) => {
        if (controller.signal.aborted) pending.unshift(job) // paused: it goes first on resume
        else if (code !== 0) failures++
      }, (error: unknown) => {
        failures++
        reporter.error(`Could not download: ${friendlyError(error instanceof Error ? error.message : String(error))}`)
      })
      .finally(() => { media = null; pump() })
  }

  /* ---- The public face ---- */

  function isIdle(): boolean {
    if (resolving > 0 || media) return false
    if (!paused && pending.length > 0) return false
    return [...ours].every((id) => reported.has(id))
  }

  return {
    async submit(input, dir = config.dir) {
      if (closed) return
      if (mediaMode) {
        push({ title: input, group: null, media: { input, dir } })
        pump()
        return
      }
      resolving++
      const run = chain.then(() => take(input, dir))
      chain = run.catch(() => {})
      try {
        await run
      } catch (error) {
        reporter.set(null)
        if (error instanceof CancelledError) { reporter.info('Cancelled.'); return }
        failures++
        const message = error instanceof Error ? (options.verbose ? error.stack ?? error.message : friendlyError(error.message)) : String(error)
        reporter.error(`Could not download: ${message}`)
        throw error
      } finally {
        resolving--
        pump()
      }
    },

    async pause() {
      if (paused) return 0
      paused = true
      if (media) {
        media.controller.abort()
        emitQueue()
        return 1
      }
      // Only what is moving bytes: a merge already in progress is local work
      // that would have to start over, so it is left to finish.
      const ids = live().transferring.map((t) => t.id)
      pausing = true
      try { await manager.pause(ids, true) }
      finally { pausing = false }
      report()
      emitQueue()
      return ids.length
    },

    resume() {
      if (!paused) return false
      paused = false
      const ids = [...pausedIds]
      pausedIds.clear()
      for (const id of ids) reported.delete(id)
      if (ids.length) manager.start(ids)
      pump()
      return true
    },

    get paused() { return paused },

    remove(id) {
      const index = pending.findIndex((job) => job.id === id && !job.admitting)
      if (index < 0) return false
      pending.splice(index, 1)
      pump()
      return true
    },

    counts() {
      const { transferring, finishing, unseen } = live()
      return {
        transferring: transferring.length + unseen.length + (media ? 1 : 0),
        finishing,
        waiting: pending.length,
        resolving
      }
    },

    idle() {
      return new Promise<void>((done) => {
        const check = (): void => {
          report()
          if (closed || isIdle()) done()
          else setTimeout(check, 200)
        }
        check()
      })
    },

    async close() {
      if (closed) return
      closed = true
      clearInterval(ticker)
      media?.controller.abort()
      pausing = true
      await manager.shutdown().catch(() => {})
      report()
      pausing = false
      reporter.clear()
      // The engine leaves its (now empty) `.draco-tasks` workspace behind in each
      // destination. Harmless in the GUI's download folder; litter in whatever
      // directory someone happened to run a command from. `rmdir` only removes an
      // empty directory, so a failed download's partial - the thing a rerun
      // resumes from - is never touched.
      const finished = latest.filter((t) => ours.has(t.id))
      for (const task of finished) {
        // Each task's own leaf first (plus the `-v`/`-a` leaves a merged download
        // uses), straight from the engine so the list cannot drift from it.
        for (const leaf of intermediatePathsFor(task).dirs) await rmdir(leaf).catch(() => {})
      }
      for (const taskDir of new Set(finished.map((t) => t.dir))) {
        await rmdir(join(taskDir, '.draco-tasks')).catch(() => {})
      }
      await closeDispatchers().catch(() => {})
      await flushLogs()
    },

    get failures() { return failures }
  }
}
