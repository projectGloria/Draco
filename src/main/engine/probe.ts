import type { ProbeResult, RequestHeaders } from '../../shared/types.ts'
import { getDispatcher } from './http.ts'
import { isEmptyRangeResponse } from './probe-helpers.ts'
import { filenameFromDisposition, filenameFromUrl, sanitizeFilename } from './naming.ts'

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

export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
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
  const ranged = await fetch(finalUrl, {
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
        return {
          finalUrl,
          filename: resolveFilename(disposition, finalUrl, url, mimeType),
          size: 0,
          resumable: false,
          etag,
          lastModified,
          mimeType,
          statusCode: 416
        }
      }

    if (!ranged.ok) {
      throw new Error(`Server responded ${ranged.status}`)
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

    return {
      finalUrl,
      filename: resolveFilename(disposition, finalUrl, url, mimeType),
      size,
      resumable,
      etag,
      lastModified,
      mimeType,
      statusCode: ranged.status
    }
  } finally {
    // Always drain: an unconsumed body holds its socket out of the pool.
    await ranged.body?.cancel().catch(() => {})
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
