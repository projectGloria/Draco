import { randomUUID } from 'node:crypto'
import type { DownloadTask, MediaAudioTrack, NewDownload, RequestHeaders, SubtitleTrack, TaskKind, TorrentFile } from '../../shared/types.ts'
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
  audioTracks?: MediaAudioTrack[]
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
    audioTracks: input.audioTracks?.map((track) => ({ ...track })) ?? [],
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
export interface ValidateUrlOptions {
  /**
   * Whether local and private-network addresses are acceptable.
   *
   * True for anything the user typed, pasted or picked: grabbing an intranet
   * site or pulling a file off a NAS at 192.168.x.x is a legitimate thing to
   * ask for. False at the boundaries where the URL came from a web page - see
   * `isPrivateHost`.
   */
  allowPrivate?: boolean
}

export function validateUrl(raw: string, options: ValidateUrlOptions = {}): string {
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

  if (
    options.allowPrivate === false &&
    parsed.protocol !== 'magnet:' &&
    isPrivateHost(parsed.hostname)
  ) {
    throw new Error('Downloads from local and private network addresses are not allowed')
  }

  return parsed.toString()
}

/**
 * Addresses a page must not be able to make the app fetch.
 *
 * This function is the boundary for URLs that did not come from the user: the
 * extension relays whatever a web page handed it, and the extension attaches
 * the browser's cookies for the target. Without this, a page could point Draco
 * at `http://192.168.1.1/` or a service on localhost and have it fetched with
 * whatever credentials the browser holds for that address.
 *
 * Hostnames only - anything that resolves to a private address through DNS is
 * out of scope here and would need a resolve-then-check, which cannot be done
 * without also pinning the socket to the address that was checked.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true

  // IPv6 loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === '::1' || host === '::') return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true
  // An IPv4-mapped IPv6 address is still that IPv4 address.
  // WHATWG URL serialises these in hex (e.g. ::ffff:7f00:1 or ::ffff:c0a8:101).
  let candidate = host
  const mappedDotted = /^(?:0:0:0:0:0:ffff:|::ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host)
  if (mappedDotted) {
    candidate = mappedDotted[1]
  } else {
    const mappedHex = /^(?:0:0:0:0:0:ffff:|::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host)
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16)
      const lo = parseInt(mappedHex[2], 16)
      candidate = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    }
  }

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(candidate)
  if (!octets) return false
  const [a, b] = octets.slice(1).map(Number)
  if (octets.slice(1).some((part) => Number(part) > 255)) return true

  if (a === 0 || a === 10 || a === 127) return true          // this network, private, loopback
  if (a === 169 && b === 254) return true                     // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true            // private
  if (a === 192 && b === 168) return true                     // private
  if (a === 100 && b >= 64 && b <= 127) return true           // carrier-grade NAT
  if (a >= 224) return true                                   // multicast and reserved
  return false
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
