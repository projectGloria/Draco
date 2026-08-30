import type { FileHandle } from 'node:fs/promises'
import { request } from 'undici'
import type { Segment } from '../../shared/types.ts'
import { getDispatcher } from './http.ts'
import type { RateLimiter } from './limiter.ts'
import { Segmenter } from './segmenter.ts'

/**
 * One connection pulling one byte range straight onto disk.
 *
 * Writes are positioned (`fh.write(chunk, 0, len, position)`), so all of the
 * connections share a single file handle without seeking over each other -
 * segments never overlap, so there is nothing to lock.
 */

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

/**
 * The server is up but refusing this many parallel connections.
 *
 * Distinct from a generic failure on purpose: plenty of hosts happily serve two
 * connections and answer the third with 429. Failing the download over that
 * would be wrong - the right answer is to use fewer connections, which is what
 * the task runner does when it sees this.
 */
export class HttpStatusError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, statusText = '') {
    super(`HTTP ${statusCode}${statusText ? ` ${statusText}` : ''}`)
    this.name = 'HttpStatusError'
    this.statusCode = statusCode
  }
}

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
  expectedSize: number | null
  signal: AbortSignal
  /** Called after every write so the task can update speed and journal state. */
  onBytes(count: number): void
}

export async function runSegment(seg: Segment, ctx: SegmentContext): Promise<void> {
  let attempt = 0

  for (;;) {
    if (ctx.signal.aborted) throw new AbortedError()

    try {
      await attemptSegment(seg, ctx)
      return
    } catch (err) {
      if (err instanceof AbortedError || ctx.signal.aborted) throw new AbortedError()
      if (err instanceof NotResumableError) throw err

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

      attempt++
      if (attempt >= ctx.retryLimit) throw err

      // Exponential backoff with jitter, so a flaky server does not get hit by
      // every segment in lockstep on the same schedule.
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1))
      await delay(backoff + Math.random() * 250, ctx.signal)
    }
  }
}

async function attemptSegment(seg: Segment, ctx: SegmentContext): Promise<void> {
  const openEnded = seg.end < 0
  const requestedStart = seg.position
  const requestedEnd = seg.end
  const range = openEnded ? `bytes=${requestedStart}-` : `bytes=${requestedStart}-${requestedEnd}`

  const res = await request(ctx.url, {
    method: 'GET',
    headers: { ...ctx.headers, range },
    dispatcher: getDispatcher(ctx.timeoutMs),
    signal: ctx.signal
  })

  // A non-resumable server is allowed to return the complete file for the
  // initial single-connection request. What is unsafe is a 200 that ignores a
  // partial/split range, because accepting that body would overlap other work.
  const isWholeFileRequest =
    requestedStart === 0 &&
    requestedEnd >= 0 &&
    ctx.expectedSize !== null &&
    requestedEnd + 1 === ctx.expectedSize
  if (res.statusCode === 200 && (requestedStart > 0 || (requestedEnd >= 0 && !isWholeFileRequest))) {
    await res.body.dump().catch(() => {})
    throw new NotResumableError('Server ignored the requested byte range')
  }

  if (BUSY_STATUS.has(res.statusCode)) {
    const retryAfterMs = parseRetryAfterMs(res.headers['retry-after'])
    await res.body.dump().catch(() => {})
    throw new ServerBusyError(res.statusCode, retryAfterMs)
  }

  if (res.statusCode !== 206 && res.statusCode !== 200) {
    // undici exposes no reason phrase; the status code is the whole signal.
    await res.body.dump().catch(() => {})
    throw new HttpStatusError(res.statusCode)
  }

  if (res.statusCode === 206) {
    const contentRange = res.headers['content-range']
    const match = typeof contentRange === 'string'
      ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange)
      : null
    if (!match) {
      await res.body.dump().catch(() => {})
      throw new Error('Server returned 206 without a valid Content-Range')
    }

    const rangeStart = Number(match[1])
    const rangeEnd = Number(match[2])
    const total = match[3] === '*' ? null : Number(match[3])
    if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) || rangeEnd < rangeStart) {
      await res.body.dump().catch(() => {})
      throw new Error('Server returned an invalid Content-Range')
    }
    if (rangeStart !== requestedStart || (requestedEnd >= 0 && rangeEnd !== requestedEnd)) {
      await res.body.dump().catch(() => {})
      throw new Error('Server returned a range different from the requested bytes')
    }
    if (total !== null && (!Number.isSafeInteger(total) || total < rangeEnd + 1)) {
      await res.body.dump().catch(() => {})
      throw new Error('Server returned an invalid Content-Range total')
    }
    if (ctx.expectedSize !== null && total !== null && total !== ctx.expectedSize) {
      await res.body.dump().catch(() => {})
      throw new Error('Server reported a different resource size than the probe')
    }
  }

  // Read chunks with a pull-based loop instead of `for await...of`.
  //
  // The async iterator pauses undici's internal HTTP parser when JS is busy
  // (writing to disk, awaiting the rate limiter). If the server closes the
  // socket while the parser is paused, `parser.finish()` hits
  // `assert(!this.paused)` and crashes the process (undici #3816 / v7).
  //
  // Using `readableStream.getReader()` on the web ReadableStream avoids
  // engaging undici's internal pause/resume and keeps the parser unpaused.
  // A socket close during an async gap becomes a normal stream error instead
  // of a fatal assertion.
  const reader = ReadableStream.from(res.body).getReader()
  try {
    for (;;) {
      if (ctx.signal.aborted) throw new AbortedError()

      const { done, value } = await reader.read()
      if (done) break

      const buf = value as Buffer

      // The segment's `end` can move backwards underneath us: the segmenter
      // shrinks it when it hands our tail to a newly-idle connection. Anything
      // past the current end now belongs to another worker.
      const allowed = seg.end < 0 ? buf.length : Math.min(buf.length, seg.end - seg.position + 1)
      if (allowed <= 0) break

      const slice = allowed === buf.length ? buf : buf.subarray(0, allowed)
      await writeAtFully(ctx.fh, slice, seg.position)

      seg.position += slice.length
      ctx.onBytes(slice.length)

      // Pay for the bytes only after they are safely written. Awaiting here is
      // what applies backpressure all the way down to the socket.
      await ctx.limiter.consume(slice.length, ctx.signal)

      if (allowed < buf.length) break
    }
  } finally {
    reader.releaseLock()
    await res.body.dump().catch(() => {})
  }

  if (!openEnded && Segmenter.remaining(seg) > 0) {
    throw new Error(
      `Connection closed with ${Segmenter.remaining(seg)} bytes of the range outstanding`
    )
  }
}

async function writeAtFully(fh: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const result = await fh.write(buffer, offset, buffer.length - offset, position + offset)
    const written = result.bytesWritten
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('File write made no progress')
    }
    offset += written
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
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
