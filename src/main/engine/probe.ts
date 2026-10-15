import type { ProbeResult, RequestHeaders } from '../../shared/types.ts'
import type { HttpAuthenticator } from './auth.ts'
import { fetchGuarded } from '../fetch-guard.ts'
import { isEmptyRangeResponse } from './probe-helpers.ts'
import { filenameFromDisposition, filenameFromUrl, sanitizeFilename } from './naming.ts'
import { localTorrentDescriptor } from './torrent-store.ts'
import { HttpStatusError } from './worker.ts'

/**
 * Turns a URL into a download plan: where it really lives, how big it is, what
 * to call it, and - the part that decides everything else - whether the server
 * will actually serve byte ranges.
 *
 * The guarded fetch reports the final URL and checks every redirect before
 * connecting, including redirects into local or private addresses.
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export interface ProbeOptions {
  /** Resume validation must observe the current resource, not a dialog's preview. */
  fresh?: boolean
  headers?: RequestHeaders
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * Answers a 401 challenge. Shared with the task that follows the probe, so a
   * download does not have to be challenged a second time to learn what the
   * probe already found out.
   */
  auth?: HttpAuthenticator
}

/** Flattens our captured-header shape into a plain header bag. */
export function buildHeaders(headers: RequestHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {
    'user-agent': headers?.userAgent || DEFAULT_USER_AGENT,
    accept: '*/*',
    // Identity encoding matters more than it looks: over a compressed transfer
    // Content-Length describes the *compressed* size, so byte ranges would stop
    // lining up with offsets in the file being assembled.
    'accept-encoding': 'identity'
  }

  if (headers?.cookie) out.cookie = headers.cookie
  if (headers?.referer) out.referer = headers.referer
  if (headers?.authorization) out.authorization = headers.authorization
  for (const [k, v] of Object.entries(headers?.extra ?? {})) out[k.toLowerCase()] = v

  return out
}

/** `bytes 0-0/12345` -> 12345. Returns null for `*` or anything malformed. */
export function totalFromContentRange(value: string | null): number | null {
  if (!value) return null
  const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(value)
  if (!match) return null
  const total = Number(match[1])
  return Number.isSafeInteger(total) && total >= 0 ? total : null
}

const probeCache = new Map<string, { result: ProbeResult; expiresAt: number }>()
const PROBE_CACHE_MAX = 500

/**
 * Reads through the cache, dropping an entry that has aged out.
 *
 * Expiry used to be checked only at the call site, so a stale entry sat in the
 * map holding a slot until five hundred newer probes had pushed it out - which,
 * with the eviction below, they could not reliably do.
 */
function getProbeCache(key: string): ProbeResult | null {
  const entry = probeCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    probeCache.delete(key)
    return null
  }
  // Re-insert so the eviction order below is by *use*, not by first sighting.
  probeCache.delete(key)
  probeCache.set(key, entry)
  return entry.result
}

function setProbeCache(key: string, value: { result: ProbeResult; expiresAt: number }) {
  // Delete first: re-setting an existing key keeps its original position in a
  // Map, so a hot URL refreshed in place would still be the first one evicted.
  probeCache.delete(key)
  probeCache.set(key, value)

  while (probeCache.size > PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value
    if (oldest === undefined) break
    probeCache.delete(oldest)
  }
}

export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  options.signal?.throwIfAborted()
  if (isTorrentSource(url)) return probeTorrent(url, options)

  const cacheKey = url + JSON.stringify(options.headers || {})
  if (!options.fresh) {
    const cached = getProbeCache(cacheKey)
    if (cached) return cached
  }

  const timeoutMs = options.timeoutMs ?? 30_000
  const headers = buildHeaders(options.headers)

  /**
   * `fetch`, plus the one retry a 401 challenge is worth.
   *
   * The probe is where a protected download is first met, so answering here is
   * what makes Add URL work at all on one - and the authenticator is shared
   * with the task that follows, which therefore starts already knowing.
   */
  const authedFetch = async (
    target: string,
    init: { method: 'HEAD' | 'GET'; headers: Record<string, string>; signal?: AbortSignal }
  ): Promise<Response> => {
    const send = (): Promise<Response> => {
      return fetchGuarded(target, {
        method: init.method,
        headers: init.headers,
        headersForHop: (address, base) => {
          const authorization = options.auth?.headerFor(address.href, init.method)
          return authorization ? { ...base, authorization } : base
        },
        signal: init.signal,
        timeoutMs
      })
    }

    const first = await send()
    if (first.status !== 401) return first
    const challengedUrl = first.url || target
    if (!options.auth?.challenged(challengedUrl, first.headers.get('www-authenticate') ?? undefined)) return first

    await first.body?.cancel().catch(() => {})
    return send()
  }

  let finalUrl = url
  let size: number | null = null
  let etag: string | null = null
  let lastModified: string | null = null
  let mimeType: string | null = null
  let disposition: string | null = null

  // HEAD first: free when supported, and plenty of servers answer it with
  // everything needed.
  try {
    const head = await authedFetch(url, {
      method: 'HEAD',
      headers,
      signal: options.signal
    })

    if (head.ok) {
      finalUrl = head.url || finalUrl
      const len = head.headers.get('content-length')
      if (len && /^\d+$/.test(len)) {
        const parsed = Number(len)
        if (Number.isSafeInteger(parsed)) size = parsed
      }
      etag = head.headers.get('etag')
      lastModified = head.headers.get('last-modified')
      mimeType = head.headers.get('content-type')
      disposition = head.headers.get('content-disposition')
    }
  } catch {
    // Servers that 405 a HEAD, or hang up on it, are common enough that this is
    // an expected path rather than an error - the ranged GET below covers us.
  }

  // The authoritative check. `Accept-Ranges: bytes` is advisory and regularly
  // lies, especially behind CDNs and PHP download scripts; a real 206 does not.
  // Reopen the caller's stable URL instead of reusing the destination learned
  // from HEAD. Some media CDNs issue method-specific or single-use redirects;
  // a ranged GET against the HEAD destination can therefore return 404 even
  // though following the original URL again succeeds.
  const ranged = await authedFetch(url, {
    method: 'GET',
    headers: { ...headers, range: 'bytes=0-0' },
    signal: options.signal
  })

  try {
    const rangedUrl = ranged.url || url
    const sameHeadTarget = rangedUrl === finalUrl
    finalUrl = rangedUrl
    // GET is authoritative. HEAD may describe another version or even another
    // redirect target; retaining its length can silently truncate a chunked GET.
    size = null
    etag = ranged.headers.get('etag')
    lastModified = ranged.headers.get('last-modified')
    mimeType = ranged.headers.get('content-type') ?? (sameHeadTarget ? mimeType : null)
    disposition = ranged.headers.get('content-disposition') ?? (sameHeadTarget ? disposition : null)

    // Empty resources commonly answer `Range: bytes=0-0` with 416 and
    // `Content-Range: bytes */0`.
    if (isEmptyRangeResponse(ranged.status, ranged.headers.get('content-range'))) {
        etag = ranged.headers.get('etag') ?? etag
        lastModified = ranged.headers.get('last-modified') ?? lastModified
        mimeType = ranged.headers.get('content-type') ?? mimeType
        disposition = ranged.headers.get('content-disposition') ?? disposition
        const result = {
          finalUrl,
          filename: resolveFilename(disposition, finalUrl, url, mimeType),
          size: 0,
          resumable: false,
          etag,
          lastModified,
          mimeType,
          statusCode: 416
        }
        setProbeCache(cacheKey, { result, expiresAt: Date.now() + 60_000 })
        return result
      }

    if (!ranged.ok) {
      // Some download endpoints forbid byte ranges as an anti-hotlink measure
      // but still serve an ordinary GET. A probe must not turn that into a
      // false "file is forbidden" result: accept the endpoint as a
      // non-resumable download and let the single-stream worker fetch it.
      if (ranged.status === 403 || ranged.status === 405 || ranged.status === 416) {
        const plain = await authedFetch(url, {
          method: 'GET',
          headers,
          signal: options.signal
        })
        try {
          if (plain.ok) {
            finalUrl = plain.url || finalUrl
            size = null
            const len = plain.headers.get('content-length')
            if (len && /^\d+$/.test(len)) {
              const parsed = Number(len)
              if (Number.isSafeInteger(parsed)) size = parsed
            }
            etag = plain.headers.get('etag')
            lastModified = plain.headers.get('last-modified')
            mimeType = plain.headers.get('content-type')
            disposition = plain.headers.get('content-disposition')
            const result = {
              finalUrl,
              filename: resolveFilename(disposition, finalUrl, url, mimeType),
              size,
              resumable: false,
              etag,
              lastModified,
              mimeType,
              statusCode: plain.status
            }
            setProbeCache(cacheKey, { result, expiresAt: Date.now() + 60_000 })
            return result
          }
        } finally {
          await plain.body?.cancel().catch(() => {})
        }
      }
      throw new HttpStatusError(ranged.status, ranged.statusText)
    }

    const resumable = ranged.status === 206

    if (resumable) {
      const total = totalFromContentRange(ranged.headers.get('content-range'))
      if (total !== null) size = total
    } else {
      // A 200 to a ranged request means the whole body is coming, so
      // Content-Length is the file size and resuming is off the table.
      const len = ranged.headers.get('content-length')
      if (len && /^\d+$/.test(len)) {
        const parsed = Number(len)
        if (Number.isSafeInteger(parsed)) size = parsed
      }
    }

    etag = ranged.headers.get('etag') ?? etag
    lastModified = ranged.headers.get('last-modified') ?? lastModified
    mimeType = ranged.headers.get('content-type') ?? mimeType
    disposition = ranged.headers.get('content-disposition') ?? disposition

    const result = {
      finalUrl,
      filename: resolveFilename(disposition, finalUrl, url, mimeType),
      size,
      resumable,
      etag,
      lastModified,
      mimeType,
      statusCode: ranged.status
    }

    setProbeCache(cacheKey, { result, expiresAt: Date.now() + 60_000 })
    return result
  } finally {
    // Always drain: an unconsumed body holds its socket out of the pool.
    await ranged.body?.cancel().catch(() => {})
  }
}

function isTorrentSource(url: string): boolean {
  if (url.startsWith('magnet:')) return true
  try {
    return /\.torrent$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

async function probeTorrent(url: string, options: ProbeOptions): Promise<ProbeResult> {
  const cacheKey = `torrent:${url}`
  if (!options.fresh) {
    const cached = getProbeCache(cacheKey)
    if (cached) return cached
  }

  // An imported `.torrent` already says what is inside it. Asking the swarm
  // would be up to 45 seconds of peer discovery to learn what is sitting in a
  // file on this disk - and it would fail outright for a torrent with no live
  // peers, which is precisely when someone has the descriptor to hand.
  const local = await localTorrentDescriptor(url)
  if (local) {
    const result = torrentProbeResult(url, local.metadata)
    setProbeCache(cacheKey, { result, expiresAt: Date.now() + 5 * 60_000 })
    return result
  }

  const { default: WebTorrent } = await import('webtorrent')
  const client = new WebTorrent()
  const timeoutMs = Math.max(options.timeoutMs ?? 45_000, 45_000)

  try {
    const torrent = await new Promise<TorrentProbeMetadata>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const candidate = client.add(url, { deselect: true })

      const finish = (metadata?: TorrentProbeMetadata, error?: unknown): void => {
        if (settled) return
        if (!metadata && !error) return
        settled = true
        if (timer) clearTimeout(timer)
        candidate.removeListener('metadata', onMetadata)
        candidate.removeListener('error', onError)
        client.removeListener('error', onError)
        options.signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(metadata!)
      }
      const onMetadata = (): void => finish(metadataFromWebTorrent(candidate))
      const onError = (error: unknown): void => finish(undefined, error)
      const onAbort = (): void => finish(undefined, new Error('Torrent metadata request was cancelled'))

      candidate.once('metadata', onMetadata)
      candidate.once('error', onError)
      client.once('error', onError)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => finish(undefined, new Error(
          'No peers currently advertise this torrent. Try again later or provide its .torrent file.'
        )),
        timeoutMs
      )
      // Public metadata caches retain the small .torrent descriptor even when
      // a swarm temporarily has no live peer. This runs alongside DHT/tracker
      // discovery, is size-bounded, and is accepted only when its info hash
      // exactly matches the requested magnet.
      void fetchCachedTorrentDescriptor(url, options.signal)
        .then((cached) => finish(cached?.metadata))
        .catch(() => {})
      if (options.signal?.aborted) onAbort()
    })

    const result = torrentProbeResult(url, torrent)
    setProbeCache(cacheKey, { result, expiresAt: Date.now() + 5 * 60_000 })
    return result
  } finally {
    client.destroy()
  }
}

function torrentProbeResult(url: string, torrent: TorrentProbeMetadata): ProbeResult {
  return {
    finalUrl: url,
    size: Number(torrent.length),
    resumable: true,
    etag: null,
    lastModified: null,
    mimeType: 'application/x-bittorrent',
    filename: torrent.name || 'torrent_download',
    statusCode: 200,
    torrentFiles: torrent.files.map((file) => ({
      path: String(file.path),
      size: Number(file.length)
    }))
  }
}

export interface TorrentProbeMetadata {
  name: string
  length: number
  files: Array<{ path: string; length: number }>
}

function metadataFromWebTorrent(torrent: any): TorrentProbeMetadata {
  return {
    name: String(torrent.name || 'torrent_download'),
    length: Number(torrent.length),
    files: torrent.files.map((file: any) => ({ path: String(file.path), length: Number(file.length) }))
  }
}

/** A `.torrent` descriptor is kilobytes; this is already absurdly generous. */
const MAX_DESCRIPTOR_BYTES = 10 * 1024 * 1024

/**
 * Reads a response body, giving up the moment it exceeds `limit` rather than
 * once it has already been held in memory.
 */
async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) return null
      chunks.push(value)
    }
  } finally {
    // Also what tears down a body abandoned over the limit.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  if (total === 0) return null
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export async function fetchCachedTorrentDescriptor(
  magnetUrl: string,
  signal: AbortSignal | undefined
): Promise<{ metadata: TorrentProbeMetadata; torrentId: Uint8Array } | undefined> {
  if (!magnetUrl.startsWith('magnet:')) return undefined
  const { default: parseTorrent } = await import('parse-torrent')
  const requested = await parseTorrent(magnetUrl)
  if (!/^[a-f0-9]{40}$/i.test(requested.infoHash)) return undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let response: Response | undefined
  try {
    response = await fetchGuarded(
      `https://itorrents.org/torrent/${requested.infoHash.toUpperCase()}.torrent`,
      {
        headers: { accept: 'application/x-bittorrent', 'user-agent': DEFAULT_USER_AGENT },
        signal: requestSignal,
        timeoutMs: 10_000
      }
    )
    if (!response.ok) return undefined
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_DESCRIPTOR_BYTES) return undefined
    // The declared length is only a claim, and a response that omits it made no
    // claim at all - so the cap has to be enforced while reading rather than
    // after. `arrayBuffer()` here would buffer whatever the host chose to send,
    // in the main process, before anything got to check it.
    const bytes = await readBounded(response, MAX_DESCRIPTOR_BYTES)
    if (!bytes) return undefined
    const parsed = await parseTorrent(bytes)
    if (parsed.infoHash.toLowerCase() !== requested.infoHash.toLowerCase() || !parsed.files) return undefined
    return {
      torrentId: bytes,
      metadata: {
        name: parsed.name || 'torrent_download',
        length: Number(parsed.length ?? parsed.files.reduce((sum, file) => sum + file.length, 0)),
        files: parsed.files.map((file) => ({ path: file.path, length: file.length }))
      }
    }
  } finally {
    clearTimeout(timer)
    await response?.body?.cancel().catch(() => {})
  }
}

function resolveFilename(
  disposition: string | null,
  finalUrl: string,
  originalUrl: string,
  mimeType: string | null
): string {
  const candidate =
    filenameFromDisposition(disposition ?? undefined) ??
    filenameFromUrl(finalUrl) ??
    filenameFromUrl(originalUrl)

  const name = sanitizeFilename(candidate ?? 'download')

  // A path like /downloads/latest gives a name with no extension. Guessing one
  // from the MIME type keeps category assignment and Explorer both happy.
  if (!name.includes('.')) {
    const ext = extensionForMime(mimeType)
    if (ext) return `${name}.${ext}`
  }

  return name
}

const MIME_EXTENSIONS: Record<string, string> = {
  'application/zip': 'zip',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/msword': 'doc',
  'application/x-msdownload': 'exe',
  'application/x-msi': 'msi',
  'application/octet-stream': 'bin',
  'application/x-iso9660-image': 'iso',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'text/plain': 'txt'
}

export function extensionForMime(mimeType: string | null): string | null {
  if (!mimeType) return null
  const base = mimeType.split(';')[0].trim().toLowerCase()
  return MIME_EXTENSIONS[base] ?? null
}
