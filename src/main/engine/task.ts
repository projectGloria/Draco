import { open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DownloadTask, Segment } from '../../shared/types.ts'
import { journalMatches, journalSegmentsValid, readJournal, removeJournal, segmentsForJournal, writeJournal, JOURNAL_VERSION } from './journal.ts'
import { QuotaExceededError, type RateLimiter } from './limiter.ts'
import { uniquePath } from './naming.ts'
import { buildHeaders, probeUrl } from './probe.ts'
import { logger } from '../log.ts'
import { preallocate } from './preallocate.ts'
import { ConnectionRamp } from './ramp.ts'
import { Segmenter } from './segmenter.ts'
import { AbortedError, HttpStatusError, NotResumableError, ServerBusyError, runSegment } from './worker.ts'
import { preparedYouTubeUrl } from '../youtube-url.ts'
import { ensureDownloadDirectory } from '../destination-path.ts'

/**
 * Drives one download: probe, resume-or-start, keep the connection pool fed,
 * and land the finished bytes at their final name.
 */

const log = logger('task')

export interface TaskRunnerConfig {
  maxConnections: number
  /**
   * How far the ramp may climb while connections keep paying for themselves.
   * Absent, or no higher than `maxConnections`, means the configured maximum
   * is also the ceiling - which is the default.
   */
  connectionCeiling?: number
  minSplitSize: number
  retryLimit: number
  timeoutMs: number
}

export interface TaskRunnerDeps {
  limiter: RateLimiter
  /** Fired on status transitions - the points worth persisting. */
  onUpdate(task: DownloadTask): void
  onFinished(task: DownloadTask, error: Error | null): void
  refreshYouTube?(task: DownloadTask, force: boolean): Promise<string>
  /**
   * Called once the probe has settled the real filename and MIME type, before
   * any bytes touch the disk. This is where the app re-files the task into the
   * right category folder - it could not know which one until now.
   */
  onProbed?(task: DownloadTask): void | Promise<void>
}

/**
 * How much can be downloaded between journal flushes before forcing one.
 *
 * A flush is not just a small JSON write: it fsyncs the part file first,
 * because the journal must never claim bytes the disk has not taken. Every
 * connection writing into that file stalls behind the barrier.
 *
 * The tempting change is to flush far less often, and it backfires. The work
 * an fsync does is proportional to the dirty pages waiting for it, so a longer
 * interval does not remove the cost - it collects it into one barrier that
 * blocks every writer for correspondingly longer. Measured over a throttled
 * 400 MB transfer on eight connections, moving this to 64 MB / 5 s took the
 * share of 250 ms progress ticks that advanced almost nothing from ~1% to
 * 15-24%: the same total work, delivered as visible stalls instead of a smooth
 * rate. These numbers are the ones that behave; treat them as measured rather
 * than merely chosen.
 */
const FLUSH_EVERY_BYTES = 8 * 1024 * 1024
const FLUSH_EVERY_MS = 1000

/**
 * Upper bound on what a connection may hold back before writing.
 *
 * Two things bound this from above. The segmenter's split point is derived
 * from a `position` that unflushed bytes have not moved yet, so staying under
 * one minimum split is what keeps those bytes behind it - that is the
 * correctness bound, applied at the call site.
 *
 * This one is about what the number *looks* like. `onBytes` only fires when a
 * batch lands, so the buffer size is also the granularity of every figure the
 * UI derives from it: at one megabyte per connection, `received` advances in
 * steps big enough that a 250 ms progress tick can show no movement at all, and
 * a download transferring perfectly steadily reads as one that keeps stalling.
 * Small enough that a tick always contains several batches costs a handful of
 * extra writes and buys back a speed figure that means something.
 */
const MAX_WRITE_BUFFER_BYTES = 128 * 1024

/**
 * Connections a task opens before it has any evidence that more would help.
 *
 * Most of what parallelism is worth is already collected by the fourth
 * connection, and starting here rather than at the configured ceiling gives
 * `ConnectionRamp` a baseline to judge the rungs above it against.
 */
const RAMP_START_CONNECTIONS = 4
/** Window the smoothed speed is measured over. */
const SPEED_WINDOW_MS = 3000

class UrlRefreshError extends Error {
  readonly url: string

  constructor(url: string) {
    super('The media URL expired and must be refreshed')
    this.name = 'UrlRefreshError'
    this.url = url
  }
}

export class TaskRunner {
  private controller = new AbortController()
  private segmenter: Segmenter | null = null
  private fh: FileHandle | null = null
  private inflight = new Set<Promise<void>>()
  private received = 0
  private samples: Array<{ t: number; received: number }> = []
  private bytesSinceFlush = 0
  private lastFlush = 0
  private flushPromise: Promise<void> | null = null
  private lifecyclePromise: Promise<void> | null = null
  private fatal: Error | null = null
  private restarted = false
  private urlRefreshes = 0
  /** Only one YouTube refresh may be in flight; all expired workers share it. */
  private urlRefreshPromise: Promise<string> | null = null
  /** The URL the last successful refresh produced, so a second expiry can reuse it. */
  private lastRefreshedUrl: string | null = null
  private forcedProbeUrl: string | null = null
  /**
   * Live connection budget. Starts at the configured maximum and ratchets down
   * whenever the server says it will not take another connection.
   */
  private connectionCap = 1
  /** Null whenever the task is pinned to one connection and cannot climb. */
  private ramp: ConnectionRamp | null = null
  private busyRetries = 0

  running = false

  task: DownloadTask
  private config: TaskRunnerConfig
  private deps: TaskRunnerDeps

  constructor(task: DownloadTask, config: TaskRunnerConfig, deps: TaskRunnerDeps) {
    this.task = task
    this.config = config
    this.deps = deps
  }

  get partPath(): string {
    return join(this.task.dir, this.task.filename + '.dracodl')
  }

  get journalPath(): string {
    return this.partPath + '.json'
  }

  async start(): Promise<void> {
    if (this.running) {
      await this.lifecyclePromise
      return
    }

    this.running = true
    this.controller = new AbortController()
    this.fatal = null
    this.samples = []
    this.urlRefreshes = 0
    this.urlRefreshPromise = null
    this.lastRefreshedUrl = null
    this.forcedProbeUrl = null
    this.busyRetries = 0
    this.ramp = null

    const lifecycle = this.runLifecycle()
    this.lifecyclePromise = lifecycle
    try {
      await lifecycle
    } finally {
      this.lifecyclePromise = null
      this.running = false
    }
  }

  private async runLifecycle(): Promise<void> {
    let refreshRestarted = false

    for (;;) {
      try {
        await this.run()
        await this.finish()
        this.deps.onFinished(this.task, null)
        return
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        if (error instanceof UrlRefreshError && this.task.youtube && !refreshRestarted) {
          refreshRestarted = true
          this.task.finalUrl = error.url
          await this.teardown()
          await rm(this.partPath, { force: true })
          await removeJournal(this.journalPath)
          this.segmenter = null
          this.received = 0
          this.task.received = 0
          this.task.segments = []
          this.task.error = null
          this.task.detail = 'Refreshing YouTube stream…'
          this.deps.onUpdate(this.task)
          this.controller = new AbortController()
          this.fatal = null
          this.forcedProbeUrl = error.url
          continue
        }

        await this.teardown()

        // Out of budget, not broken. The partial data and its journal stay
        // exactly as they are; the manager brings the task back when the
        // window turns.
        if (error instanceof QuotaExceededError) {
          this.task.status = 'paused'
          this.task.error = null
          this.task.speed = 0
          this.task.eta = null
          this.task.detail = quotaDetail(error.resumesAt)
          this.deps.onFinished(this.task, error)
          return
        }

        if ((error instanceof AbortedError || this.controller.signal.aborted) && !this.fatal) {
          // A pause is not a failure; pause() has already set the status.
          this.deps.onFinished(this.task, null)
        } else {
          this.task.status = 'error'
          this.task.error = error.message
          this.task.speed = 0
          this.task.eta = null
          this.deps.onFinished(this.task, error)
        }
        return
      }
    }
  }

  /** Stops cleanly, leaving the part file and journal ready to resume from. */
  async pause(): Promise<void> {
    if (!this.running) {
      this.task.status = 'paused'
      this.task.speed = 0
      this.task.eta = null
      this.deps.onUpdate(this.task)
      return
    }

    this.task.status = 'paused'
    this.controller.abort()
    await this.lifecyclePromise?.catch(() => {})
    this.task.speed = 0
    this.task.eta = null
    this.deps.onUpdate(this.task)
  }

  /**
   * Recomputes speed and ETA from the byte counter and opportunistically
   * flushes the journal. Called by the manager on its shared ticker rather than
   * per-chunk - progress is a UI concern and does not belong on the hot path.
   */
  tick(): void {
    if (!this.running) return

    const now = Date.now()
    this.samples.push({ t: now, received: this.received })
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) {
      this.samples.shift()
    }

    const oldest = this.samples[0]
    const elapsed = (now - oldest.t) / 1000
    if (elapsed >= 0.25) {
      this.task.speed = Math.max(0, (this.received - oldest.received) / elapsed)
    }

    this.task.received = this.received
    if (this.segmenter) {
      // Per-segment rates feed the next split; see Segmenter.split.
      this.segmenter.observe(now)
      this.task.segments = this.segmenter.snapshot()
    }

    this.task.eta =
      this.task.size !== null && this.task.speed > 1
        ? Math.max(0, Math.round((this.task.size - this.received) / this.task.speed))
        : null

    // Reading the ramp off the same ticker keeps connection sizing off the hot
    // path, exactly as speed and ETA are.
    if (this.ramp && this.task.status === 'downloading' && this.ramp.sample(now, this.received)) {
      const previous = this.connectionCap
      this.connectionCap = this.ramp.cap
      this.task.connections = this.connectionCap
      // The only thing that changes a transfer's shape mid-flight without any
      // error to go with it, so it does not get to be invisible either.
      log.info(
        `${this.task.filename}: connections ${previous} -> ${this.connectionCap}` +
        ` at ${(this.task.speed / 1048576).toFixed(2)} MB/s` +
        `${this.ramp.settled ? ' (settled)' : ''}`
      )
      // Climbing needs the new slots filled now; stepping back down needs
      // nothing, because `fill` simply stops replacing what retires.
      this.fill()
    }

    const due =
      this.bytesSinceFlush >= FLUSH_EVERY_BYTES || now - this.lastFlush >= FLUSH_EVERY_MS
    if (due) void this.flushJournal(false)
  }

  /* ---------------------------------------------------------------- */

  private async run(): Promise<void> {
    this.task.status = 'probing'
    this.task.error = null
    this.task.detail = null
    this.deps.onUpdate(this.task)

    let probeTarget = this.task.url
    if (this.task.youtube && this.deps.refreshYouTube) {
      /*
       * New YouTube tasks already carry the signed resource prepared before the
       * final confirmation, so the common path goes straight into the probe.
       * Old/restored tasks may still carry only the watch page; those use the
       * extractor fallback, and expired prepared URLs refresh after HTTP errors.
       */
      const requestedItag = Number(this.task.youtube.role === 'audio'
        ? this.task.youtube.audioFormatId?.split('-')[0]
        : this.task.youtube.videoFormatId.split('-')[0])
      const prepared = preparedYouTubeUrl(
        this.task.url,
        Number.isSafeInteger(requestedItag) ? requestedItag : undefined
      )

      if (!this.forcedProbeUrl && !prepared) {
        this.task.detail = 'Getting the download link…'
        this.deps.onUpdate(this.task)
      }
      probeTarget = this.forcedProbeUrl ?? prepared ?? (await this.deps.refreshYouTube(this.task, false))
      this.forcedProbeUrl = null
      this.task.finalUrl = probeTarget
      this.task.detail = null
    }

    let probe: any
    try {
      probe = await probeUrl(probeTarget, {
        headers: this.task.headers,
        timeoutMs: this.config.timeoutMs,
        signal: this.controller.signal
      })
    } catch (err) {
      if (
        this.task.youtube &&
        this.deps.refreshYouTube &&
        err instanceof HttpStatusError &&
        [401, 403, 410].includes(err.statusCode)
      ) {
        if (this.urlRefreshes >= 1) throw new Error('YouTube media URL expired again after a refresh')
        this.urlRefreshes++
        const refreshedUrl = await this.deps.refreshYouTube(this.task, true)
        throw new UrlRefreshError(refreshedUrl)
      }
      throw err
    }

    this.task.finalUrl = probe.finalUrl
    this.task.size = probe.size
    this.task.resumable = probe.resumable
    this.task.etag = probe.etag
    this.task.lastModified = probe.lastModified
    this.task.mimeType = probe.mimeType
    if (!this.task.filenameLocked) this.task.filename = probe.filename

    // The category - and therefore the directory - depends on the extension and
    // MIME type, neither of which was known before the probe.
    await this.deps.onProbed?.(this.task)

    this.task.dir = await ensureDownloadDirectory(this.task.dir)

    const restored = await this.restoreOrReset(probe.size)

    // Only a server that honours ranges *and* told us the length can be split.
    const connectionTarget =
      this.task.resumable && this.task.size !== null
        ? Math.max(this.config.maxConnections, this.config.connectionCeiling ?? 0)
        : 1
    // The configured maximum is a ceiling the ramp climbs towards on evidence,
    // never a number of connections to open on faith.
    this.ramp = new ConnectionRamp(RAMP_START_CONNECTIONS, connectionTarget)
    this.connectionCap = this.ramp.cap
    this.task.connections = this.connectionCap

    if (!restored && process.platform === 'win32' && this.task.size !== null && this.task.size > 0) {
      // Reserving the whole range now is what keeps every segment's offset
      // valid from the first write. Which of the two workable ways it gets is
      // a property of the volume and the privileges to hand - see preallocate.
      const mode = await preallocate(this.partPath, this.task.size)
      log.info(`${this.task.filename}: reserved ${this.task.size} bytes (${mode})`)
    }

    this.fh = await open(this.partPath, restored ? 'r+' : 'w+')

    // A restored file is already this long and a fresh one was just reserved,
    // so this is the safety net for the case where neither held.
    if (this.task.size !== null && this.task.size > 0) {
      await this.fh.truncate(this.task.size)
    }

    this.task.status = 'downloading'
    this.task.startedAt = this.task.startedAt ?? Date.now()
    this.lastFlush = Date.now()
    this.ramp?.begin(Date.now(), this.received)
    this.deps.onUpdate(this.task)

    await this.pumpUntilDone()
  }

  /**
   * Reloads a journal when it still describes the file on the server, otherwise
   * clears the slate. Returns whether existing bytes were adopted.
   */
  private async restoreOrReset(size: number | null): Promise<boolean> {
    const journal = await readJournal(this.journalPath)
    const partExists = await exists(this.partPath)

    if (
      journal &&
      partExists &&
      this.task.resumable &&
      journalSegmentsValid(journal.segments, size) &&
      journalMatches(journal, {
        finalUrl: this.task.finalUrl,
        filename: this.task.filename,
        size: this.task.size,
        resumable: this.task.resumable,
        etag: this.task.etag,
        lastModified: this.task.lastModified,
        mimeType: this.task.mimeType,
        statusCode: 206
      }, { allowFinalUrlChange: Boolean(this.task.youtube) })
    ) {
      this.segmenter = Segmenter.restore(journal.segments, size, this.config.minSplitSize)
      this.received = this.segmenter.received
      this.task.received = this.received
      return true
    }

    // Either nothing to resume, or the remote file moved on. Starting over is
    // the cheap mistake; splicing two different files together is not.
    await rm(this.partPath, { force: true })
    await removeJournal(this.journalPath)
    this.segmenter = new Segmenter(size, this.config.minSplitSize)
    this.received = 0
    this.task.received = 0
    return false
  }

  private async pumpUntilDone(): Promise<void> {
    const segmenter = this.segmenter
    if (!segmenter) throw new Error('segmenter missing')

    for (;;) {
      if (this.fatal) throw this.fatal
      // Worker failures abort their siblings too. Preserve the real failure;
      // treating that shared abort as a user pause would leave the task stuck
      // in its previous visible state and skip compatibility recovery.
      if (this.controller.signal.aborted) throw new AbortedError()
      if (segmenter.complete) break

      this.fill()

      if (this.inflight.size === 0) {
        // Nothing running and nothing splittable while work remains means the
        // segmenter and the workers disagree - fail loudly rather than spin.
        if (!segmenter.complete) throw this.fatal ?? new Error('Download stalled with work outstanding')
        break
      }

      await Promise.race([...this.inflight])
    }

    await Promise.allSettled([...this.inflight])
    if (this.fatal) throw this.fatal
    if (this.controller.signal.aborted) throw new AbortedError()
  }

  /** Hands idle work - or a freshly split tail - to every free connection. */
  private fill(): void {
    const segmenter = this.segmenter
    if (!segmenter || this.controller.signal.aborted || this.fatal) return

    while (segmenter.activeCount < this.connectionCap) {
      const seg = segmenter.nextIdle() ?? segmenter.split()
      if (!seg) break
      this.launch(seg)
    }
  }

  private launch(seg: Segment): void {
    const fh = this.fh
    if (!fh) return

    seg.active = true

    const promise = runSegment(seg, {
      url: this.task.finalUrl,
      headers: buildHeaders(this.task.headers),
      fh,
      limiter: this.deps.limiter,
      timeoutMs: this.config.timeoutMs,
      retryLimit: this.config.retryLimit,
      expectedSize: this.task.size,
      signal: this.controller.signal,
      writeBufferBytes: Math.min(MAX_WRITE_BUFFER_BYTES, this.config.minSplitSize),
      onBytes: (count) => {
        this.received += count
        this.bytesSinceFlush += count
      }
    })
      .then(() => {
        seg.active = false

        // A successful 200 response is valid for an open-ended stream. Its final
        // byte is the first trustworthy size we have, so close the segment and
        // expose that size to the task rather than leaving the pump thinking work
        // is still outstanding forever.
        if (seg.end < 0 && this.task.size === null && this.segmenter) {
          this.segmenter.setSize(seg.position)
          this.task.size = seg.position
          this.task.received = this.received
        }

        this.fill()
      })
      .catch(async (err: Error) => {
        seg.active = false
        if (err instanceof AbortedError) return

        if (
          this.task.youtube &&
          this.deps.refreshYouTube &&
          err instanceof HttpStatusError &&
          [401, 403, 410].includes(err.statusCode)
        ) {
          try {
            if (!this.urlRefreshPromise) {
              if (this.urlRefreshes >= 1) {
                if (this.lastRefreshedUrl) {
                  this.fatal = new UrlRefreshError(this.lastRefreshedUrl)
                  this.controller.abort()
                  return
                }
                throw new Error('YouTube media URL expired again after a refresh')
              }
              this.urlRefreshes++
              log.warn(`${this.task.filename}: media URL expired mid-transfer; refreshing`)
              // Forced: the URL this task holds is the one that just 401'd.
              this.urlRefreshPromise = this.deps.refreshYouTube(this.task, true).then((refreshedUrl) => {
                if (!/^https?:\/\//i.test(refreshedUrl)) {
                  throw new Error('YouTube returned an invalid refreshed media URL')
                }
                this.lastRefreshedUrl = refreshedUrl
                return refreshedUrl
              }).finally(() => {
                this.urlRefreshPromise = null
              })
            }
            const refreshedUrl = await this.urlRefreshPromise
            this.fatal = new UrlRefreshError(refreshedUrl)
            this.controller.abort()
            return
          } catch (refreshErr) {
            err = refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr))
          }
        }

        // The server is capping parallelism rather than failing. Give back a
        // connection and leave the range for whoever frees up next; the work is
        // not lost, it just proceeds narrower.
        if (err instanceof ServerBusyError && this.busyRetries < this.config.retryLimit) {
          this.busyRetries++
          // An explicit refusal outranks anything throughput has to say.
          this.ramp?.stop()
          if (this.connectionCap > 1) this.connectionCap--
          this.task.connections = this.connectionCap
          // Hold the slot open while backing off, so the loop does not spin and
          // immediately re-provoke the same refusal.
          const fallback = Math.min(30_000, 1000 * 2 ** (this.busyRetries - 1))
          const waitMs = err.retryAfterMs ?? fallback
          // This is the one thing that can hold a transfer still for tens of
          // seconds while nothing looks wrong, so it does not get to be silent.
          log.warn(
            `${this.task.filename}: server refused another connection (HTTP ${err.statusCode}); ` +
            `backing off ${Math.round(waitMs / 1000)}s, cap now ${this.connectionCap}, refusal ${this.busyRetries}/${this.config.retryLimit}`
          )
          await delay(waitMs)
          this.fill()
          return
        }

        if (!this.fatal) {
          this.fatal = err
          // One failed segment dooms the file, so stop the others immediately
          // rather than letting them finish work that will be discarded.
          this.controller.abort()
        }
      })
      .finally(() => {
        this.inflight.delete(promise)
      })

    this.inflight.add(promise)
  }

  private async finish(): Promise<void> {
    await this.flushJournal(true)

    if (this.task.size !== null && this.received < this.task.size) {
      throw new Error(
        `Incomplete: got ${this.received} of ${this.task.size} bytes`
      )
    }

    await this.fh?.close()
    this.fh = null

    const target = await uniquePath(this.task.dir, this.task.filename)
    await rename(this.partPath, target)
    // The payload is already safely at its final name. Journal cleanup is
    // recovery metadata, so a transient cleanup failure must not turn a finished
    // download into a visible error.
    await removeJournal(this.journalPath).catch(() => {})

    this.task.filename = basename(target)
    this.task.status = 'done'
    this.task.completedAt = Date.now()
    this.task.speed = 0
    this.task.eta = null
    this.task.received = this.task.size ?? this.received
    if (this.segmenter) this.task.segments = this.segmenter.snapshot()
  }

  private async teardown(): Promise<void> {
    await Promise.allSettled([...this.inflight])
    await this.flushJournal(true)
    await this.fh?.close().catch(() => {})
    this.fh = null
  }

  private async flushJournal(force: boolean): Promise<void> {
    if (!this.segmenter) return
    if (this.task.size === null || !this.task.resumable) return

    // Never let two journal writers race over the same `.tmp` path. This used to
    // be possible when the 250 ms ticker started a flush and pause/shutdown forced
    // another one before the first rename completed.
    if (this.flushPromise) {
      await this.flushPromise
      if (!force) return
    }

    this.bytesSinceFlush = 0
    this.lastFlush = Date.now()

    // The journal may only claim bytes that are actually durable.
    if (this.fh) {
      try {
        await this.fh.sync()
      } catch {
        return
      }
    }

    const run = writeJournal(this.journalPath, {
      version: JOURNAL_VERSION,
      url: this.task.url,
      finalUrl: this.task.finalUrl,
      filename: this.task.filename,
      size: this.task.size,
      etag: this.task.etag,
      lastModified: this.task.lastModified,
      segments: segmentsForJournal(this.segmenter.snapshot()),
      updatedAt: Date.now()
    }).catch(() => {
      // A failed flush costs resume granularity, not the download. Losing the
      // whole task because the journal could not be written would be worse.
    })

    this.flushPromise = run.finally(() => {
      this.flushPromise = null
    })

    await this.flushPromise
  }

  /**
   * Called by the manager when a run failed because the server refused to
   * honour ranges. Wipes the partial data so the retry starts clean.
   */
  async resetForRestart(): Promise<boolean> {
    if (this.restarted) return false
    this.restarted = true
    await rm(this.partPath, { force: true })
    await removeJournal(this.journalPath)
    this.received = 0
    this.task.received = 0
    this.task.resumable = false
    this.task.segments = []
    return true
  }

  static isNotResumable(err: unknown): boolean {
    return err instanceof NotResumableError
  }
}

/** "Transfer quota reached - resumes at 14:30", in the row and the window. */
export function quotaDetail(resumesAt: number): string {
  const time = new Date(resumesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `Transfer quota reached; resumes at ${time}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
