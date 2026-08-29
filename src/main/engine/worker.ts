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
export class ServerBusyError extends Error {
  readonly statusCode: number

  constructor(statusCode: number) {
    super(`Server refused another connection (${statusCode})`)
    this.name = 'ServerBusyError'
    this.statusCode = statusCode
  }
}

/** 429 is explicit; 503 is what a connection-limited origin sends instead. */
const BUSY_STATUS = new Set([429, 503])

export interface SegmentContext {
  url: string
  headers: Record<string, string>
  fh: FileHandle
  limiter: RateLimiter
  timeoutMs: number
  retryLimit: number
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
  const range = openEnded ? `bytes=${seg.position}-` : `bytes=${seg.position}-${seg.end}`

  const res = await request(ctx.url, {
    method: 'GET',
    headers: { ...ctx.headers, range },
    dispatcher: getDispatcher(ctx.timeoutMs),
    signal: ctx.signal
  })

  if (res.statusCode === 200 && seg.position > 0) {
    await res.body.dump().catch(() => {})
    throw new NotResumableError('Server ignored the range request')
  }

  if (BUSY_STATUS.has(res.statusCode)) {
    await res.body.dump().catch(() => {})
    throw new ServerBusyError(res.statusCode)
  }

  if (res.statusCode !== 206 && res.statusCode !== 200) {
    await res.body.dump().catch(() => {})
    throw new Error(`Segment request failed with ${res.statusCode}`)
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
      await ctx.fh.write(slice, 0, slice.length, seg.position)

      seg.position += slice.length
      ctx.onBytes(slice.length)

      // Pay for the bytes only after they are safely written. Awaiting here is
      // what applies backpressure all the way down to the socket.
      await ctx.limiter.consume(slice.length)

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
