import { randomUUID } from 'node:crypto'
import type { DownloadTask, NewDownload, RequestHeaders, SubtitleTrack, TaskKind, TorrentFile } from '../../shared/types.ts'
import { filenameFromUrl, sanitizeFilename } from './naming.ts'
import { normalizeDownloadDirectory } from '../destination-path.ts'

/**
 * Builds a task record. The filename here is only a placeholder - the probe
 * replaces it with whatever Content-Disposition says once the request is made.
 */
export function createTask(input: {
  url: string
  sourceUrl?: string
  groupId?: string
  groupName?: string
  groupFolder?: string
  dir: string
  filename?: string
  categoryId?: string | null
  queueId?: string | null
  headers?: RequestHeaders
  subtitles?: SubtitleTrack[]
  description?: string
  expectedChecksum?: string | null
  postProcess?: 'none' | 'mp4' | 'mp3'
  selectedFiles?: string[]
  torrentFiles?: TorrentFile[]
  kind?: TaskKind
  audioUrl?: string | null
  youtube?: { pageUrl: string; videoFormatId: string; audioFormatId?: string | null; height?: number | null; role?: 'video' | 'audio' }
}): DownloadTask {
  const kind = input.kind ?? 'file'
  // Applied to the URL-derived fallback too, not just to a name the caller
  // chose: a stream picked up with no name at all must still not land as .m3u8.
  const filename = sanitizeFilename(
    filenameForKind(input.filename || filenameFromUrl(input.url) || 'download', kind)
  )

  return {
    id: randomUUID(),
    url: input.url,
    sourceUrl: input.sourceUrl,
    groupId: input.groupId,
    groupName: input.groupName,
    groupFolder: input.groupFolder,
    audioUrl: input.audioUrl ?? null,
    youtube: input.youtube ? { ...input.youtube, role: input.youtube.role ?? 'video' } : undefined,
    finalUrl: input.url,
    filename,
    // Only a name the caller chose is authoritative; one guessed from the URL
    // should give way to whatever the server actually calls the file.
    filenameLocked: Boolean(input.filename),
    dir: normalizeDownloadDirectory(input.dir),
    categoryId: input.categoryId ?? null,
    queueId: input.queueId ?? null,
    queueRetryCount: 0,
    nextQueueAttemptAt: null,
    manualPause: false,
    kind,
    size: null,
    received: 0,
    status: 'queued',
    resumable: false,
    singleConnectionFallback: false,
    segments: [],
    connections: 1,
    speed: 0,
    eta: null,
    error: null,
    detail: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    etag: null,
    lastModified: null,
    headers: input.headers ?? {},
    subtitles: input.subtitles?.map((track) => ({ ...track })) ?? [],
    mimeType: null,
    description: input.description ?? '',
    expectedChecksum: input.expectedChecksum ?? undefined,
    postProcess: input.postProcess ?? 'none',
    selectedFiles: input.selectedFiles,
    torrentFiles: input.torrentFiles?.map((file) => ({ ...file }))
  }
}

/**
 * Rejects anything that is not an http(s) URL before it reaches the engine.
 * This runs in main, not just in the UI - the extension and the clipboard
 * watcher both feed this path, and neither is a trusted source.
 */
export function validateUrl(raw: string): string {
  let trimmed = raw.trim()
  if (/^[0-9a-fA-F]{40}$/.test(trimmed)) {
    // A bare hash carries no tracker hints. DHT remains enabled, while these
    // public fallbacks make metadata discovery much less dependent on the
    // local DHT table already being warm.
    const trackers = DEFAULT_TORRENT_TRACKERS
      .map((tracker) => `&tr=${encodeURIComponent(tracker)}`)
      .join('')
    // Keep `urn:btih:` literal. Some BitTorrent parsers do not accept percent
    // escapes in the exact-topic field even though URLSearchParams emits them.
    trimmed = `magnet:?xt=urn:btih:${trimmed.toLowerCase()}${trackers}`
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('That is not a valid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'magnet:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol.replace(':', '')}`)
  }

  return parsed.toString()
}

export const DEFAULT_TORRENT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'wss://tracker.openwebtorrent.com/'
] as const

/**
 * A URL that points at a playlist is a stream, not a file. Downloading it as a
 * file would produce a two-kilobyte text document named `.m3u8` - which is
 * exactly what the browser would have done, and the reason to take it over.
 */
export function kindForUrl(url: string, contentType?: string | null): TaskKind {
  if (
    contentType &&
    (contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl'))
  ) {
    return 'hls'
  }

  if (contentType && contentType.includes('application/dash+xml')) return 'dash'

  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'magnet:') return 'torrent'
    const pathname = parsed.pathname
    if (/\.torrent$/i.test(pathname)) return 'torrent'
    if (/\.(m3u8|m3u)$/i.test(pathname)) return 'hls'
    if (/\.mpd$/i.test(pathname)) return 'dash'
    return 'file'
  } catch {
    return 'file'
  }
}

/**
 * The name a stream should land under, since `.m3u8` is not a video file.
 *
 * Idempotent on purpose: this runs once where the task is placed and again
 * inside `createTask`, and a version that blindly appended turned a perfectly
 * good name into `video 1080p.mp4.mp4.mp4`.
 */
export function filenameForKind(filename: string, kind: TaskKind): string {
  if (kind === 'file' || kind === 'torrent') return filename

  const base = filename.replace(kind === 'hls' ? /\.(m3u8|m3u)$/i : /\.mpd$/i, '')
  // A container the mux can actually produce is left alone; anything else -
  // including no extension at all - becomes the mp4 it is about to be.
  return /\.(mp4|mkv|mov|m4v|webm|ts)$/i.test(base) ? base : base + '.mp4'
}

export function normalizeNewDownload(input: NewDownload, defaultDir: string): NewDownload {
  return {
    ...input,
    url: validateUrl(input.url),
    dir: normalizeDownloadDirectory(input.dir || defaultDir)
  }
}
