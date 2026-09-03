import type {
  Category,
  ColumnId,
  ColumnPref,
  DownloadTask,
  MediaCandidate,
  MediaVariant,
  Queue,
  QueueCompletionAction,
  QueueMode,
  RequestHeaders,
  Segment,
  Settings,
  SortDirection,
  SubtitleTrack,
  TaskKind,
  TaskStatus
} from '@shared/types'
import { sanitizeFilename, filenameFromUrl } from './engine/naming.ts'
import { toFolderName } from './store-sanitize-path.ts'
import { safeDownloadDirectory } from './destination-path.ts'

export const COLUMN_IDS: ColumnId[] = [
  'name', 'size', 'progress', 'status', 'eta', 'speed', 'queue', 'added', 'description'
]
export const TASK_STATUSES: TaskStatus[] = ['queued', 'probing', 'downloading', 'paused', 'done', 'error', 'missing']
export const QUEUE_MODES: QueueMode[] = ['manual', 'onetime', 'periodic']
export const QUEUE_ACTIONS: QueueCompletionAction[] = ['none', 'run', 'exit', 'sleep', 'hibernate', 'shutdown']

export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function safeNonNegativeInt(value: unknown, fallback: number | null = null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function safeTimestamp(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function optionalText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function validUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32768) return null
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function validTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  const match = /^(\d{2}):(\d{2})$/.exec(v)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  return h <= 23 && m <= 59 ? `${match[1]}:${match[2]}` : null
}

function headers(value: unknown): RequestHeaders {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const v = value as Record<string, unknown>
  const extra: Record<string, string> = {}
  if (v.extra && typeof v.extra === 'object' && !Array.isArray(v.extra)) {
    for (const [key, raw] of Object.entries(v.extra as Record<string, unknown>).slice(0, 100)) {
      if (typeof raw === 'string' && key.length <= 200 && raw.length <= 1_000_000) extra[key] = raw
    }
  }
  return {
    ...(typeof v.cookie === 'string' && v.cookie.length <= 1_000_000 ? { cookie: v.cookie } : {}),
    ...(typeof v.referer === 'string' && validUrl(v.referer) ? { referer: v.referer } : {}),
    ...(typeof v.userAgent === 'string' && v.userAgent.length <= 1024 ? { userAgent: v.userAgent } : {}),
    ...(typeof v.authorization === 'string' && v.authorization.length <= 1_000_000 ? { authorization: v.authorization } : {}),
    ...(Object.keys(extra).length ? { extra } : {})
  }
}

export function sanitizeSettings(input: unknown, base: Settings, defaultColumns: () => ColumnPref[]): Settings {
  const source = isRecord(input) ? input : {}
  const columnsValue = Array.isArray(source.columns) ? source.columns : []
  const columns = columnsValue.length ? mergeColumns(columnsValue, defaultColumns) : defaultColumns()
  const speedLimit = typeof source.speedLimit === 'number' && Number.isFinite(source.speedLimit) && source.speedLimit > 0
    ? source.speedLimit
    : null
  // Null is the default and means "stop at maxConnectionsPerTask". Anything
  // else is a deliberate opt-in, so it is only bounded, never second-guessed.
  const adaptiveConnectionCeiling =
    typeof source.adaptiveConnectionCeiling === 'number' &&
    Number.isFinite(source.adaptiveConnectionCeiling) &&
    source.adaptiveConnectionCeiling > 0
      ? Math.min(64, Math.max(1, Math.floor(source.adaptiveConnectionCeiling)))
      : null
  const accent = typeof source.accent === 'string' && /^#[0-9a-f]{6}$/i.test(source.accent)
    ? source.accent.toLowerCase()
    : base.accent
  const proxyUrl = sanitizeProxyUrl(source.proxyUrl)
  const hostConnectionLimits = sanitizeHostConnectionLimits(source.hostConnectionLimits)
  const quotaBytes = typeof source.quotaBytes === 'number' && Number.isSafeInteger(source.quotaBytes) && source.quotaBytes > 0
    ? Math.min(source.quotaBytes, Number.MAX_SAFE_INTEGER)
    : null

  return {
    ...base,
    language: source.language === 'en' || source.language === 'tr' ? source.language : 'system',
    theme: source.theme === 'light' || source.theme === 'system' ? source.theme : 'dark',
    downloadDir: safeDownloadDirectory(source.downloadDir, base.downloadDir),
    maxConcurrentTasks: clamp(source.maxConcurrentTasks, 1, 20, base.maxConcurrentTasks),
    // The ramp is what decides how many of these are actually opened, so the
    // ceiling can be generous: asking for more than a server rewards costs a
    // rung's measurement, not the connections.
    maxConnectionsPerTask: clamp(source.maxConnectionsPerTask, 1, 64, base.maxConnectionsPerTask),
    adaptiveConnectionCeiling,
    minSplitSize: clamp(source.minSplitSize, 64 * 1024, 256 * 1024 * 1024, base.minSplitSize),
    speedLimit,
    proxyUrl,
    hostConnectionLimits,
    quotaBytes,
    quotaWindowMinutes: clamp(source.quotaWindowMinutes, 1, 7 * 24 * 60, base.quotaWindowMinutes),
    antivirusProgram: typeof source.antivirusProgram === 'string' && source.antivirusProgram.trim()
      ? source.antivirusProgram.trim().slice(0, 1000)
      : null,
    antivirusArgs: Array.isArray(source.antivirusArgs)
      ? source.antivirusArgs.filter((arg): arg is string => typeof arg === 'string').slice(0, 30).map((arg) => arg.slice(0, 500))
      : base.antivirusArgs,
    antivirusTimeoutSeconds: clamp(source.antivirusTimeoutSeconds, 5, 3600, base.antivirusTimeoutSeconds),
    updateFeedUrl: safeHttpsUrl(source.updateFeedUrl),
    autoCheckUpdates: typeof source.autoCheckUpdates === 'boolean' ? source.autoCheckUpdates : base.autoCheckUpdates,
    retryLimit: clamp(source.retryLimit, 1, 20, base.retryLimit),
    timeoutMs: clamp(source.timeoutMs, 5_000, 300_000, base.timeoutMs),
    defaultCategoryId: typeof source.defaultCategoryId === 'string' ? source.defaultCategoryId : null,
    confirmDelete: source.confirmDelete !== false,
    closeToTray: source.closeToTray !== false,
    startMinimized: source.startMinimized === true,
    takeoverEnabled: source.takeoverEnabled !== false,
    confirmHandoff: source.confirmHandoff !== false,
    takeoverMinSize: clamp(source.takeoverMinSize, 0, 1024 ** 4, base.takeoverMinSize),
    takeoverExtensions: lowerList(source.takeoverExtensions),
    takeoverExcludeHosts: lowerList(source.takeoverExcludeHosts),
    watchClipboard: source.watchClipboard === true,
    showProgressWindow: source.showProgressWindow !== false,
    accent,
    columns,
    sortColumn: COLUMN_IDS.includes(source.sortColumn as ColumnId) ? source.sortColumn as ColumnId : base.sortColumn,
    sortDirection: source.sortDirection === 'asc' || source.sortDirection === 'desc' ? source.sortDirection as SortDirection : base.sortDirection,
    sidebarSelection: typeof source.sidebarSelection === 'string' ? source.sidebarSelection.slice(0, 200) : base.sidebarSelection
  }
}

function sanitizeProxyUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

function sanitizeHostConnectionLimits(value: unknown): Settings['hostConnectionLimits'] {
  if (!Array.isArray(value)) return []
  const byHost = new Map<string, number>()
  for (const raw of value.slice(0, 200)) {
    if (!isRecord(raw) || typeof raw.host !== 'string') continue
    const host = raw.host.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
    if (!host || host.length > 253 || !/^[a-z0-9.-]+$/i.test(host)) continue
    byHost.set(host, clamp(raw.connections, 1, 16, 1))
  }
  return [...byHost].map(([host, connections]) => ({ host, connections }))
}

function mergeColumns(stored: unknown[], defaultsFactory: () => ColumnPref[]): ColumnPref[] {
  const defaults = defaultsFactory()
  const byId = new Map<ColumnId, ColumnPref>()
  for (const raw of stored) {
    if (!isRecord(raw)) continue
    const id = raw.id
    if (!COLUMN_IDS.includes(id as ColumnId)) continue
    if (byId.has(id as ColumnId)) continue
    byId.set(id as ColumnId, {
      id: id as ColumnId,
      width: clamp(raw.width, 40, 1200, defaults.find((d) => d.id === id)?.width ?? 100),
      visible: raw.visible !== false
    })
  }
  return defaults.map((column) => byId.get(column.id) ?? column)
}

export function sanitizeCategories(input: unknown, fallback: () => Category[]): Category[] {
  if (!Array.isArray(input)) return fallback()
  const seenNames = new Set<string>()
  const seenIds = new Set<string>()
  const result: Category[] = []
  for (const raw of input) {
    if (!isRecord(raw)) continue
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : ''
    if (!name || seenNames.has(name.toLowerCase())) continue
    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 128) : randomFallbackId()
    if (seenIds.has(id)) id = randomFallbackId()
    seenNames.add(name.toLowerCase())
    seenIds.add(id)
    const folderRaw = typeof raw.folder === 'string' && raw.folder.trim() ? raw.folder : name
    result.push({
      id,
      name,
      folder: toFolderName(folderRaw),
      builtin: raw.builtin === true,
      hosts: lowerList(raw.hosts).map((host) => host.replace(/^\.+|\.+$/g, '')).filter((host) => /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(host)),
      extensions: lowerList(raw.extensions).map((e) => e.replace(/^\./, '').slice(0, 32)).filter(Boolean)
    })
  }
  return result.length ? result : fallback()
}

export function sanitizeTasks(input: unknown, defaultDir: string): DownloadTask[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: DownloadTask[] = []

  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.url !== 'string') continue
    const url = validUrl(raw.url)
    const id = raw.id.slice(0, 256)
    if (!url || !id || seen.has(id)) continue
    seen.add(id)

    const size = raw.size === null ? null : safeNonNegativeInt(raw.size)
    const receivedRaw = safeNonNegativeInt(raw.received, 0) ?? 0
    const received = size === null ? receivedRaw : Math.min(receivedRaw, size)
    const status: TaskStatus = TASK_STATUSES.includes(raw.status as TaskStatus) ? raw.status as TaskStatus : 'paused'
    const kind: TaskKind = raw.kind === 'hls' || raw.kind === 'dash' ? raw.kind : 'file'
    const filenameSource = typeof raw.filename === 'string' ? raw.filename : (filenameFromUrl(url) ?? 'download')
    const filename = sanitizeFilename(filenameSource)
    const finalUrl = validUrl(raw.finalUrl) ?? url
    const audioUrl = validUrl(raw.audioUrl) ?? null
    const youtube = sanitizeYouTube(raw.youtube)
    const segments = sanitizeSegments(raw.segments, size)

    out.push({
      id,
      url,
      sourceUrl: validUrl(raw.sourceUrl) ?? youtube?.pageUrl ?? url,
      audioUrl,
      ...(youtube ? { youtube } : {}),
      finalUrl,
      filename,
      filenameLocked: raw.filenameLocked === true,
      dir: safeDownloadDirectory(raw.dir, defaultDir),
      categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : null,
      queueId: typeof raw.queueId === 'string' ? raw.queueId : null,
      queueRetryCount: clamp(raw.queueRetryCount, 0, 20, 0),
      nextQueueAttemptAt: safeTimestamp(raw.nextQueueAttemptAt, null),
      manualPause: raw.manualPause === true,
      kind,
      size,
      received,
      status,
      resumable: raw.resumable === true,
      singleConnectionFallback: raw.singleConnectionFallback === true,
      segments,
      connections: clamp(raw.connections, 1, 16, 1),
      speed: typeof raw.speed === 'number' && Number.isFinite(raw.speed) && raw.speed >= 0 ? raw.speed : 0,
      eta: safeNonNegativeInt(raw.eta),
      error: optionalText(raw.error, 10_000),
      detail: optionalText(raw.detail, 1_000),
      createdAt: safeTimestamp(raw.createdAt, Date.now()) ?? Date.now(),
      startedAt: safeTimestamp(raw.startedAt, null),
      completedAt: safeTimestamp(raw.completedAt, null),
      etag: optionalText(raw.etag, 4096),
      lastModified: optionalText(raw.lastModified, 1024),
      headers: headers(raw.headers),
      subtitles: sanitizeSubtitles(raw.subtitles),
      mimeType: optionalText(raw.mimeType, 1024),
      description: typeof raw.description === 'string' ? raw.description.slice(0, 10_000) : ''
    })
  }
  return out
}

function sanitizeSegments(input: unknown, size: number | null): Segment[] {
  if (!Array.isArray(input)) return []
  const out: Segment[] = []
  for (const raw of input) {
    if (!isRecord(raw)) return []
    const start = safeNonNegativeInt(raw.start)
    const position = safeNonNegativeInt(raw.position)
    const end = raw.end === -1 ? -1 : safeNonNegativeInt(raw.end)
    if (start === null || position === null || end === null) return []
    if (position < start || (end >= 0 && end < start) || (end >= 0 && position > end + 1)) return []
    if (size !== null && end >= size) return []
    out.push({ start, end, position, active: false })
  }
  out.sort((a, b) => a.start - b.start)
  let lastEnd = -1
  for (const seg of out) {
    if (seg.start <= lastEnd) return []
    if (seg.end >= 0) lastEnd = seg.end
  }
  return out
}

function sanitizeYouTube(input: unknown): DownloadTask['youtube'] | undefined {
  if (!isRecord(input)) return undefined
  const pageUrl = validUrl(input.pageUrl)
  const videoFormatId = typeof input.videoFormatId === 'string' ? input.videoFormatId.slice(0, 200) : ''
  if (!pageUrl || !videoFormatId) return undefined
  const audioFormatId = input.audioFormatId === null || input.audioFormatId === undefined
    ? null
    : typeof input.audioFormatId === 'string' ? input.audioFormatId.slice(0, 200) : null
  const role = input.role === 'audio' || input.role === 'video' ? input.role : undefined
  const height = typeof input.height === 'number' && Number.isFinite(input.height) && input.height > 0
    ? Math.min(Math.round(input.height), 100_000)
    : null
  return { pageUrl, videoFormatId, audioFormatId, height, ...(role ? { role } : {}) }
}

export function sanitizeQueues(input: unknown): Queue[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: Queue[] = []
  for (const raw of input) {
    if (!isRecord(raw)) continue
    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 128) : randomFallbackId()
    if (seen.has(id)) id = randomFallbackId()
    seen.add(id)
    const days = Array.isArray(raw.days)
      ? [...new Set(raw.days.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))]
      : []
    out.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : 'Queue',
      taskIds: Array.isArray(raw.taskIds) ? [...new Set(raw.taskIds.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 256)))] : [],
      mode: QUEUE_MODES.includes(raw.mode as QueueMode) ? raw.mode as QueueMode : 'manual',
      startTime: validTime(raw.startTime),
      stopTime: validTime(raw.stopTime),
      days,
      maxConcurrent: clamp(raw.maxConcurrent, 1, 20, 1),
      retryLimit: clamp(raw.retryLimit, 0, 20, 3),
      retryDelaySeconds: clamp(raw.retryDelaySeconds, 0, 86_400, 30),
      onComplete: QUEUE_ACTIONS.includes(raw.onComplete as QueueCompletionAction) ? raw.onComplete as QueueCompletionAction : 'none',
      completionProgram: typeof raw.completionProgram === 'string' && raw.completionProgram.trim()
        ? raw.completionProgram.trim().slice(0, 1000)
        : null,
      completionArgs: Array.isArray(raw.completionArgs)
        ? raw.completionArgs.filter((arg): arg is string => typeof arg === 'string').slice(0, 20).map((arg) => arg.slice(0, 500))
        : [],
      running: false,
      oneTimeCompleted: raw.oneTimeCompleted === true,
      lastResult: raw.lastResult === 'completed' || raw.lastResult === 'completed-with-errors'
        ? raw.lastResult
        : 'idle'
    })
  }
  return out
}

export function sanitizeMedia(input: unknown): MediaCandidate[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: MediaCandidate[] = []
  for (const raw of input) {
    if (!isRecord(raw)) continue
    const id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 256) : randomFallbackId()
    const pageUrl = validUrl(raw.pageUrl)
    const mediaUrl = validUrl(raw.mediaUrl)
    if (!pageUrl || !mediaUrl || seen.has(id)) continue
    seen.add(id)
    const type = raw.type === 'dash' || raw.type === 'file' ? raw.type : 'hls'
    const variants = sanitizeVariants(raw.variants)
    out.push({
      id, pageUrl, mediaUrl,
      pageTitle: typeof raw.pageTitle === 'string' ? raw.pageTitle.slice(0, 1000) : '',
      type,
      variants,
      headers: headers(raw.headers),
      subtitles: sanitizeSubtitles(raw.subtitles),
      discoveredAt: safeTimestamp(raw.discoveredAt, Date.now()) ?? Date.now()
    })
  }
  return out
}

function sanitizeSubtitles(input: unknown): SubtitleTrack[] {
  if (!Array.isArray(input)) return []
  const out: SubtitleTrack[] = []
  const seen = new Set<string>()
  for (const raw of input.slice(0, 20)) {
    if (!isRecord(raw)) continue
    const url = validUrl(raw.url)
    const format = raw.format
    if (!url || seen.has(url) || (format !== 'vtt' && format !== 'srt' && format !== 'ttml')) continue
    seen.add(url)
    out.push({
      url,
      label: typeof raw.label === 'string' ? raw.label.slice(0, 100) : '',
      language: typeof raw.language === 'string' ? raw.language.slice(0, 35) : null,
      format
    })
  }
  return out
}

function sanitizeVariants(input: unknown): MediaVariant[] {
  if (!Array.isArray(input)) return []
  const out: MediaVariant[] = []
  for (const raw of input.slice(0, 50)) {
    if (!isRecord(raw)) continue
    const youtube = isRecord(raw.youtube) && typeof raw.youtube.videoFormatId === 'string' && raw.youtube.videoFormatId
      ? { videoFormatId: raw.youtube.videoFormatId.slice(0, 200), audioFormatId: typeof raw.youtube.audioFormatId === 'string' ? raw.youtube.audioFormatId.slice(0, 200) : null }
      : undefined
    /*
     * A YouTube variant read from the page names its format by itag and has no
     * URL of its own until the download is actually started, so an empty one is
     * legitimate there and only there. Every other variant must still carry a
     * real address, or the entry is worthless and gets dropped.
     */
    const url = validUrl(raw.url) ?? (youtube && raw.url === '' ? '' : null)
    if (url === null) continue
    const audioUrl = validUrl(raw.audioUrl)
    out.push({
      url,
      audioUrl,
      label: typeof raw.label === 'string' ? raw.label.slice(0, 200) : '',
      height: typeof raw.height === 'number' && Number.isSafeInteger(raw.height) && raw.height >= 0 ? raw.height : null,
      bandwidth: typeof raw.bandwidth === 'number' && Number.isSafeInteger(raw.bandwidth) && raw.bandwidth >= 0 ? raw.bandwidth : null,
      codecs: typeof raw.codecs === 'string' ? raw.codecs.slice(0, 1000) : null,
      estimatedSize: safeNonNegativeInt(raw.estimatedSize),
      container: safeContainer(raw.container),
      ...(youtube ? { youtube } : {})
    })
  }
  return out
}

/**
 * The container a variant will be saved as, or null.
 *
 * Kept across a reload rather than recomputed: a page-derived YouTube variant
 * has no URL to infer one from, so dropping it here would leave every rung of a
 * restored ladder claiming `.mp4` - including the ones that will actually be
 * muxed into `.webm` or `.mkv`, which is precisely the disagreement between the
 * label and the file that this field exists to prevent.
 */
function safeContainer(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(text) ? text : null
}

export function lowerList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toLowerCase()).filter(Boolean))].slice(0, 500)
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function randomFallbackId(): string {
  return `migrated-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
