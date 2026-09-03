import type { FileHandle } from 'node:fs/promises'
import { request } from 'undici'
import type { Segment } from '../../shared/types.ts'
import { getDispatcher } from './http.ts'
import { QuotaExceededError, type RateLimiter } from './limiter.ts'
import { logger } from '../log.ts'
import { Segmenter } from './segmenter.ts'

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
  /**
   * How much this connection may hold back before issuing one positioned
   * write. Never larger than the segmenter's minimum split - see the read loop.
   */
  writeBufferBytes: number
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

      attempt++
      if (attempt >= ctx.retryLimit) throw err

      // Exponential backoff with jitter, so a flaky server does not get hit by
      // every segment in lockstep on the same schedule.
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1))
      log.warn(
        `segment ${seg.start}-${seg.end} retry ${attempt}/${ctx.retryLimit} in ${backoff}ms: ${err instanceof Error ? err.message : String(err)}`
      )
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

  /*
   * Socket chunks are gathered and landed with a single vectored write.
   *
   * undici hands over 16-64 KB at a time. Writing each one straight through
   * costs its own libuv threadpool round-trip and, on the sparse part file,
   * its own NTFS extent - thousands of both per second at a gigabit, across
   * every segment of every task. `writev` takes the chunks as they are, so the
   * batching costs no copying: the saving is in syscalls and in an extent map
   * that stays small enough not to punish whoever reads the file afterwards.
   *
   * Holding chunks back means `seg.position` lags reality, and `Segmenter.split`
   * picks its midpoint from exactly that number. The caller therefore caps a
   * batch at the segmenter's minimum split size: a split always leaves at
   * least that much room ahead of the position it read, so bytes in hand stay
   * behind the new end. `commit` re-checks anyway, because `end` can also move
   * while a write is in flight.
   */
  const capacity = Math.max(1, Math.floor(ctx.writeBufferBytes))
  let pending: Uint8Array[] = []
  let buffered = 0

  /**
   * Lands one contiguous run at `seg.position` and accounts for it.
   *
   * The advance is clamped to what the segment still owns once the write
   * returns, not to what it owned when the run was gathered. Anything past
   * that was handed to another connection in the meantime; it is written but
   * not claimed, and the connection that now owns it writes the same bytes at
   * the same offsets. Returns false when the run was cut short that way.
   */
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

      // The segment's `end` can move backwards underneath us: the segmenter
      // shrinks it when it hands our tail to a newly-idle connection. Anything
      // past the current end now belongs to another worker. Gathered chunks
      // have not moved `position` yet, so they count against the room this one
      // has left.
      const room = seg.end < 0 ? buf.length : seg.end - (seg.position + buffered) + 1
      const allowed = Math.min(buf.length, Math.max(0, room))
      if (allowed <= 0) break

      pending.push(allowed === buf.length ? buf : buf.subarray(0, allowed))
      buffered += allowed

      if (buffered >= capacity && !(await flushPending())) break

      if (allowed < buf.length) break
    }

    // Only on the way out cleanly. An abort or a stream error drops whatever is
    // still gathered, which costs at most one batch of re-downloading and keeps
    // `position` describing bytes that reached the disk and nothing else.
    await flushPending()
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
