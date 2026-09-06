import type { ProbeResult, RequestHeaders } from '../../shared/types.ts'
import { getDispatcher } from './http.ts'
import { isEmptyRangeResponse } from './probe-helpers.ts'
import { filenameFromDisposition, filenameFromUrl, sanitizeFilename } from './naming.ts'
import { HttpStatusError } from './worker.ts'

/**
 * Turns a URL into a download plan: where it really lives, how big it is, what
 * to call it, and - the part that decides everything else - whether the server
 * will actually serve byte ranges.
 *
 * This uses `fetch` rather than undici's `request` for one reason: `fetch`
 * reports the post-redirect URL as `response.url`. undici's redirect
 * interceptor only records the hops it left behind, so the destination itself
 * would have to be reconstructed by hand.
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

export interface ProbeOptions {
  headers?: RequestHeaders
  timeoutMs?: number
  signal?: AbortSignal
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

function setProbeCache(key: string, value: { result: ProbeResult; expiresAt: number }) {
  probeCache.set(key, value)
  if (probeCache.size > 500) {
    const oldest = probeCache.keys().next().value
    if (oldest !== undefined) probeCache.delete(oldest)
  }
}

export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  if (isTorrentSource(url)) return probeTorrent(url, options)

  const cacheKey = url + JSON.stringify(options.headers || {})
  const cached = probeCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result
  }

  const timeoutMs = options.timeoutMs ?? 30_000
  const headers = buildHeaders(options.headers)
  const dispatcher = getDispatcher(timeoutMs)

  let finalUrl = url
  let size: number | null = null
  let etag: string | null = null
  let lastModified: string | null = null
  let mimeType: string | null = null
  let disposition: string | null = null

  // HEAD first: free when supported, and plenty of servers answer it with
  // everything needed.
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers,
      redirect: 'follow',
      signal: options.signal,
      dispatcher
    } as RequestInit)

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
  const ranged = await fetch(url, {
    method: 'GET',
    headers: { ...headers, range: 'bytes=0-0' },
    redirect: 'follow',
    signal: options.signal,
    dispatcher
  } as RequestInit)

  try {
    finalUrl = ranged.url || finalUrl

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
        const plain = await fetch(url, {
          method: 'GET',
          headers,
          redirect: 'follow',
          signal: options.signal,
          dispatcher
        } as RequestInit)
        try {
          if (plain.ok) {
            finalUrl = plain.url || finalUrl
            const len = plain.headers.get('content-length')
            if (len && /^\d+$/.test(len)) {
              const parsed = Number(len)
              if (Number.isSafeInteger(parsed)) size = parsed
            }
            etag = plain.headers.get('etag') ?? etag
            lastModified = plain.headers.get('last-modified') ?? lastModified
            mimeType = plain.headers.get('content-type') ?? mimeType
            disposition = plain.headers.get('content-disposition') ?? disposition
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
  const cached = probeCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return cached.result

  const { default: WebTorrent } = await import('webtorrent')
  const client = new WebTorrent()
  const timeoutMs = Math.max(options.timeoutMs ?? 45_000, 45_000)

  try {
    const torrent = await new Promise<TorrentProbeMetadata>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const candidate = client.add(url)

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

    const torrentFiles = torrent.files.map((file) => ({
      path: String(file.path),
      size: Number(file.length)
    }))
    const result: ProbeResult = {
      finalUrl: url,
      size: Number(torrent.length),
      resumable: true,
      etag: null,
      lastModified: null,
      mimeType: 'application/x-bittorrent',
      filename: torrent.name || 'torrent_download',
      statusCode: 200,
      torrentFiles
    }
    setProbeCache(cacheKey, { result, expiresAt: Date.now() + 5 * 60_000 })
    return result
  } finally {
    client.destroy()
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
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(
      `https://itorrents.org/torrent/${requested.infoHash.toUpperCase()}.torrent`,
      {
        headers: { accept: 'application/x-bittorrent', 'user-agent': DEFAULT_USER_AGENT },
        redirect: 'follow',
        signal: controller.signal,
        dispatcher: getDispatcher(10_000)
      } as RequestInit
    )
    if (!response.ok) return undefined
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > 10 * 1024 * 1024) return undefined
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) return undefined
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
    signal?.removeEventListener('abort', abort)
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
