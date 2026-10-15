import type { FileHandle } from 'node:fs/promises'
import type { Segment } from '../../shared/types.ts'
import type { HttpAuthenticator } from './auth.ts'
import { discardRequestBody, requestGuarded } from '../fetch-guard.ts'
import { QuotaExceededError, type RateLimiter } from './limiter.ts'
import { logger } from '../log.ts'
import { Segmenter } from './segmenter.ts'
import { isStrongEtag } from './journal.ts'

/**
 * One connection pulling one byte range straight onto disk.
 *
 * Writes are positioned (`fh.write(chunk, 0, len, position)`), so all of the
 * connections share a single file handle without seeking over each other -
 * segments never overlap, so there is nothing to lock.
 */

const log = logger('worker')

export class AbortedError extends Error {
  constructor() {
    super('aborted')
    this.name = 'AbortedError'
  }
}

/** Raised when resuming is impossible and the task has to start over. */
export class NotResumableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotResumableError'
  }
}

/** Any status the transfer cannot proceed from, carried so callers can branch
 * on the code - 401/403/410 mean a signed URL expired, not that the file is
 * gone. */
export class HttpStatusError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, statusText = '') {
    super(`HTTP ${statusCode}${statusText ? ` ${statusText}` : ''}`)
    this.name = 'HttpStatusError'
    this.statusCode = statusCode
  }
}

/**
 * The server is up but refusing this many parallel connections.
 *
 * Distinct from a generic failure on purpose: plenty of hosts happily serve two
 * connections and answer the third with 429. Failing the download over that
 * would be wrong - the right answer is to use fewer connections, which is what
 * the task runner does when it sees this.
 */
export class ServerBusyError extends Error {
  readonly statusCode: number
  readonly retryAfterMs: number | null

  constructor(statusCode: number, retryAfterMs: number | null = null) {
    super(`Server refused another connection (${statusCode})`)
    this.name = 'ServerBusyError'
    this.statusCode = statusCode
    this.retryAfterMs = retryAfterMs
  }
}

/** 429 is explicit; 503 is what a connection-limited origin sends instead. */
const BUSY_STATUS = new Set([429, 503])

/** Parses either form allowed by HTTP: delay-seconds or an absolute HTTP date. */
export function parseRetryAfterMs(value: string | string[] | undefined, now = Date.now()): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null

  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, seconds * 1000)

  const date = Date.parse(raw)
  if (!Number.isFinite(date)) return null
  return Math.min(300_000, Math.max(0, date - now))
}

export interface SegmentContext {
  url: string
  headers: Record<string, string>
  fh: FileHandle
  limiter: RateLimiter
  timeoutMs: number
  retryLimit: number
  exponentialBackoff: boolean
  expectedSize: number | null
  /** Strong validator from the fresh probe, used to guard ranged responses. */
  expectedEtag?: string | null
  /** False for servers that reject ranges and for compatibility restarts. */
  useRanges?: boolean
  /** Request the entire file as one range without allowing partial retries or splitting. */
  requestFullRange?: boolean
  /** Bounded requests for one fixed signed YouTube resource; no cross-run resume. */
  sequentialRanges?: boolean
  signal: AbortSignal
  /**
   * How much this connection may hold back before issuing one positioned
   * write. Never larger than the segmenter's minimum split - see the read loop.
   */
  writeBufferBytes: number
  /** Called after every write so the task can update speed and journal state. */
  onBytes(count: number): void
  /**
   * Shared with every other connection on this task, so the first one to be
   * challenged teaches all of them - eight connections should not each have to
   * be told "no" by the server before they say who they are.
   */
  auth?: HttpAuthenticator
}

function isGoogleVideoUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return /(^|\.)googlevideo\.com$/i.test(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * YouTube / googlevideo drops or throttles TCP connections for ranges > 10MB.
 * Slicing requests to 10MB matches yt-dlp's default http_chunk_size and keeps
 * downloads smooth and uninterrupted.
 */
const GOOGLE_VIDEO_CHUNK_SIZE = 10 * 1024 * 1024

export async function runSegment(seg: Segment, ctx: SegmentContext): Promise<void> {
  let attempt = 0
  let lastPosition = seg.position

  for (;;) {
    if (ctx.signal.aborted) throw new AbortedError()

    try {
      await attemptSegment(seg, ctx)
      return
    } catch (err) {
      if (err instanceof AbortedError || ctx.signal.aborted) throw new AbortedError()
      if (err instanceof NotResumableError) throw err

      // Retrying would only spend the budget that is already gone, five times
      // over. The task stops and the manager restarts it when the window turns.
      if (err instanceof QuotaExceededError) throw err

      // Do not burn this segment's retry budget arguing with a connection
      // limit. Hand it back so the task can drop a connection and requeue it.
      if (err instanceof ServerBusyError) throw err

      // Signed media URLs commonly return 403/410 as soon as they expire.
      // Let the owning task refresh its stable source identity immediately
      // instead of spending the whole generic retry budget first.
      if (err instanceof HttpStatusError && [401, 403, 410].includes(err.statusCode)) {
        throw err
      }

      // The segment may already be finished even though the stream died - a
      // truncated-but-complete read is a success, not a retry.
      if (Segmenter.remaining(seg) <= 0) return

      // If bytes were committed during this attempt, reset the retry counter:
      // genuine progress was made, so this was not a hard failure loop.
      if (seg.position > lastPosition) {
        attempt = 0
        lastPosition = seg.position
      }

      attempt++
      if (attempt >= ctx.retryLimit) throw err

      // Exponential backoff with jitter, or a fixed delay if disabled
      const baseDelay = ctx.exponentialBackoff ? 500 * 2 ** (attempt - 1) : 2000
      const backoff = Math.min(30_000, baseDelay)
      log.warn(
        `segment ${seg.start}-${seg.end} retry ${attempt}/${ctx.retryLimit} in ${backoff}ms: ${err instanceof Error ? err.message : String(err)}`
      )
      await delay(backoff + Math.random() * 250, ctx.signal)
    }
  }
}

async function attemptSegment(seg: Segment, ctx: SegmentContext): Promise<void> {
  const isGoogleVideo = isGoogleVideoUrl(ctx.url)

  while (seg.end < 0 ? true : Segmenter.remaining(seg) > 0) {
    if (ctx.signal.aborted) throw new AbortedError()

    const openEnded = seg.end < 0
    const requestedStart = seg.position
    let requestedEnd = seg.end
    if (ctx.useRanges === false && !ctx.sequentialRanges && requestedStart > 0) {
      throw new NotResumableError('Server does not support resuming a partial download')
    }

    if ((isGoogleVideo && ctx.useRanges !== false) || ctx.sequentialRanges) {
      const maxSliceEnd = requestedStart + GOOGLE_VIDEO_CHUNK_SIZE - 1
      if (requestedEnd >= 0) {
        requestedEnd = Math.min(requestedEnd, maxSliceEnd)
      } else if (ctx.expectedSize !== null) {
        requestedEnd = Math.min(ctx.expectedSize - 1, maxSliceEnd)
      } else {
        requestedEnd = maxSliceEnd
      }
    }

    const range = requestedEnd < 0 ? `bytes=${requestedStart}-` : `bytes=${requestedStart}-${requestedEnd}`

    const send = async (): Promise<Awaited<ReturnType<typeof requestGuarded>>> => {
      const headers: Record<string, string> = { ...ctx.headers }
      // Captured browser headers must not reintroduce a range on a plain GET.
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'range') delete headers[key]
      }
      if (ctx.useRanges !== false || ctx.sequentialRanges || (ctx.requestFullRange && requestedStart === 0 &&
          ctx.expectedSize !== null && requestedEnd + 1 === ctx.expectedSize)) {
        headers.range = range
        if (ctx.expectedEtag?.startsWith('"') && ctx.expectedEtag.endsWith('"')) {
          headers['if-range'] = ctx.expectedEtag
        }
      }
      return requestGuarded(ctx.url, {
        method: 'GET',
        headers,
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal,
        // A redirected destination may be the host that challenged during the
        // probe. Rebuild its header at that hop; never carry source credentials.
        headersForHop: (url, base) => {
          const authorization = ctx.auth?.headerFor(url.href, 'GET')
          return authorization ? { ...base, authorization } : base
        }
      })
    }

    let sent = await send()
    let res = sent.response

    // A 401 that names a challenge is a server saying who it wants to hear from,
    // not a signed URL that expired. `challenged` answers false when there is no
    // password for it, or when this exact nonce has already been refused - so a
    // wrong password fails once rather than being retried until the account locks.
    if (res.statusCode === 401 && ctx.auth?.challenged(sent.finalUrl, res.headers['www-authenticate'])) {
      discardRequestBody(res.body)
      sent = await send()
      res = sent.response
    }

    // A non-resumable server is allowed to return the complete file for the
    // initial single-connection request. What is unsafe is a 200 that ignores a
    // partial/split range, because accepting that body would overlap other work.
    const isWholeFileRequest =
      requestedStart === 0 &&
      requestedEnd >= 0 &&
      ctx.expectedSize !== null &&
      requestedEnd + 1 === ctx.expectedSize
    if (res.statusCode === 200 && (requestedStart > 0 || (requestedEnd >= 0 && !isWholeFileRequest))) {
      discardRequestBody(res.body)
      throw new NotResumableError('Server ignored the requested byte range')
    }

    if (BUSY_STATUS.has(res.statusCode)) {
      const retryAfterMs = parseRetryAfterMs(res.headers['retry-after'])
      discardRequestBody(res.body)
      throw new ServerBusyError(res.statusCode, retryAfterMs)
    }

    if (res.statusCode !== 206 && res.statusCode !== 200) {
      // undici exposes no reason phrase; the status code is the whole signal.
      discardRequestBody(res.body)
      throw new HttpStatusError(res.statusCode)
    }

    if (ctx.sequentialRanges && sent.finalUrl !== new URL(ctx.url).href) {
      const origUrl = new URL(ctx.url)
      const finalUrl = new URL(sent.finalUrl)
      const isYouTubeEdgeMirror =
        (origUrl.hostname === 'googlevideo.com' || origUrl.hostname.endsWith('.googlevideo.com')) &&
        (finalUrl.hostname === 'googlevideo.com' || finalUrl.hostname.endsWith('.googlevideo.com')) &&
        origUrl.pathname === finalUrl.pathname &&
        origUrl.searchParams.get('id') === finalUrl.searchParams.get('id') &&
        origUrl.searchParams.get('itag') === finalUrl.searchParams.get('itag')
      if (!isYouTubeEdgeMirror) {
        discardRequestBody(res.body)
        throw new Error('YouTube media redirected to a different resource during transfer')
      }
    }

    // A server can change the object after the probe, or between parallel
    // segments. Never append a response that identifies a different version.
    const responseEtag = res.headers.etag
    if (ctx.useRanges !== false && isStrongEtag(ctx.expectedEtag)) {
      if (typeof responseEtag !== 'string') {
        discardRequestBody(res.body)
        throw new NotResumableError('Server omitted the ETag on a ranged response')
      }
      if (responseEtag !== ctx.expectedEtag) {
        discardRequestBody(res.body)
        throw new Error('Server changed the resource ETag during transfer')
      }
    }

    if (res.statusCode === 206) {
      const contentRange = res.headers['content-range']
      const match = typeof contentRange === 'string'
        ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange)
        : null
      if (!match) {
        discardRequestBody(res.body)
        throw new Error('Server returned 206 without a valid Content-Range')
      }

      const rangeStart = Number(match[1])
      const rangeEnd = Number(match[2])
      const total = match[3] === '*' ? null : Number(match[3])
      if (ctx.sequentialRanges && total !== ctx.expectedSize) {
        discardRequestBody(res.body)
        throw new Error('YouTube media chunk did not confirm the expected resource size')
      }
      if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) || rangeEnd < rangeStart) {
        discardRequestBody(res.body)
        throw new Error('Server returned an invalid Content-Range')
      }
      if (rangeStart !== requestedStart || (requestedEnd >= 0 && rangeEnd > requestedEnd)) {
        discardRequestBody(res.body)
        throw new Error('Server returned a range different from the requested bytes')
      }
      if (total !== null && (!Number.isSafeInteger(total) || total < rangeEnd + 1)) {
        discardRequestBody(res.body)
        throw new Error('Server returned an invalid Content-Range total')
      }
      if (ctx.expectedSize !== null && total !== null && total !== ctx.expectedSize) {
        discardRequestBody(res.body)
        throw new Error('Server reported a different resource size than the probe')
      }
    }

    const reader = ReadableStream.from(res.body).getReader()
    const capacity = Math.max(1, Math.floor(ctx.writeBufferBytes))
    let pending: Uint8Array[] = []
    let buffered = 0
    let sliceBytesRead = 0

    const commit = async (chunks: Uint8Array[], total: number): Promise<boolean> => {
      if (total === 0) return true

      const at = seg.position
      await writeAtFully(ctx.fh, chunks, at)

      const room = seg.end < 0 ? total : Math.max(0, seg.end - at + 1)
      const landed = Math.min(total, room)
      if (landed <= 0) return false

      seg.position = at + landed
      ctx.onBytes(landed)

      // Pay for the bytes only after they are safely written. Awaiting here is
      // what applies backpressure all the way down to the socket.
      await ctx.limiter.consume(landed, ctx.signal)
      return landed === total
    }

    const flushPending = async (): Promise<boolean> => {
      if (buffered === 0) return true
      const chunks = pending
      const total = buffered
      pending = []
      buffered = 0
      return commit(chunks, total)
    }

    try {
      for (;;) {
        if (ctx.signal.aborted) throw new AbortedError()

        const { done, value } = await reader.read()
        if (done) break

        const buf = value as Uint8Array
        sliceBytesRead += buf.length

        // The segment's `end` can move backwards underneath us: the segmenter
        // shrinks it when it hands our tail to a newly-idle connection. Anything
        // past the current end now belongs to another worker. Gathered chunks
        // have not moved `position` yet, so they count against the room this one
        // has left.
        let offset = 0
        while (offset < buf.length) {
          const room = seg.end < 0 ? buf.length : seg.end - (seg.position + buffered) + 1
          const allowed = Math.min(buf.length - offset, capacity - buffered, Math.max(0, room))
          if (allowed <= 0) break

          pending.push(buf.subarray(offset, offset + allowed))
          buffered += allowed
          offset += allowed

          // A network chunk can exceed the split margin. Never let one write
          // cross that margin while the segmenter is handing our tail away.
          if (buffered === capacity && !(await flushPending())) break
        }

        if (offset < buf.length || Segmenter.remaining(seg) <= 0) break
      }

      // Only on the way out cleanly. An abort or a stream error drops whatever is
      // still gathered, which costs at most one batch of re-downloading and keeps
      // `position` describing bytes that reached the disk and nothing else.
      await flushPending()
    } finally {
      // Splitting or a failed disk write must release the response immediately;
      // draining it can wait on a stalled peer and spend uncharged body bytes.
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }

    if (openEnded) {
      if (sliceBytesRead === 0 || res.statusCode === 200) {
        break
      }
      if (ctx.expectedSize !== null && seg.position >= ctx.expectedSize) {
        break
      }
    } else {
      if (sliceBytesRead === 0 && Segmenter.remaining(seg) > 0) {
        throw new Error(
          `Connection closed with ${Segmenter.remaining(seg)} bytes of the range outstanding`
        )
      }
    }
  }

  if (seg.end >= 0 && Segmenter.remaining(seg) > 0) {
    throw new Error(
      `Connection closed with ${Segmenter.remaining(seg)} bytes of the range outstanding`
    )
  }
}

/**
 * Writes every gathered chunk at `position`, retrying whatever a short write
 * leaves behind. One chunk goes through `write`, which skips assembling the
 * iovec for the common case of a batch that filled on its first read.
 */
async function writeAtFully(fh: FileHandle, chunks: Uint8Array[], position: number): Promise<void> {
  let index = 0
  let within = 0
  let offset = 0
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)

  while (offset < total) {
    const head = chunks[index]
    const rest = within > 0 ? [head.subarray(within), ...chunks.slice(index + 1)] : chunks.slice(index)

    const written = rest.length === 1
      ? (await fh.write(rest[0], 0, rest[0].length, position + offset)).bytesWritten
      : (await fh.writev(rest, position + offset)).bytesWritten

    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('File write made no progress')
    }
    offset += written

    // Walk the cursor past whatever the short write did land.
    let remaining = written
    while (remaining > 0) {
      const left = chunks[index].length - within
      if (remaining < left) {
        within += remaining
        remaining = 0
      } else {
        remaining -= left
        index++
        within = 0
      }
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new AbortedError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      reject(new AbortedError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}
