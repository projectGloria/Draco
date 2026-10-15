import { mkdir, open, rm, stat, statfs, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import type { DownloadTask, Segment } from '../../shared/types.ts'
import { isStrongEtag, journalMatches, journalSegmentsValid, readJournal, removeJournal, segmentsForJournal, writeJournal, JOURNAL_VERSION } from './journal.ts'
import { QuotaExceededError, type RateLimiter } from './limiter.ts'
import { discardReservedPath, uniquePath, moveFile } from './naming.ts'
import { authFailureMessage, type HttpAuthenticator } from './auth.ts'
import { buildHeaders, probeUrl } from './probe.ts'
import { logger } from '../log.ts'
import { clearSparseFlag, preallocate } from './preallocate.ts'
import { ConnectionRamp, getLearnedHostCap, recordLearnedHostCap } from './ramp.ts'
import { Segmenter } from './segmenter.ts'
import { AbortedError, HttpStatusError, NotResumableError, ServerBusyError, runSegment } from './worker.ts'
import { isFixedYouTubeResource, preparedYouTubeUrl, youtubeFormatId } from '../youtube-url.ts'
import { ensureDownloadDirectory } from '../destination-path.ts'
import { partPathFor } from './workspace.ts'
import { verifyExpectedChecksum } from './checksum.ts'
import { QUOTA_DETAIL_PREFIX } from '../../shared/quota.ts'

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
  tempDir?: string
  checkDiskSpace?: boolean
  exponentialBackoff?: boolean
}

export interface TaskRunnerDeps {
  limiter: RateLimiter
  /**
   * Answers 401 challenges for this task. One per task, so the probe and all
   * of its connections share what the first challenge taught them.
   */
  auth?: HttpAuthenticator
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
 * The ceiling the interval backs off to when the barrier turns out to be
 * expensive on this file.
 *
 * The numbers above were measured on a throttled transfer to a freshly
 * allocated file. On an unthrottled link, or against the sparse fallback in
 * `preallocate.ts` - which is what an unelevated run gets, and which leaves a
 * multi-gigabyte file with an extent map thousands of entries long - a single
 * `FlushFileBuffers` can run into hundreds of milliseconds, with every
 * connection queued behind it. Rather than guess, the interval is derived from
 * what the last few syncs actually cost.
 *
 * Backing off costs resume granularity and nothing else, and only up to
 * `FLUSH_EVERY_BYTES` of it, because the byte trigger is unchanged.
 */
const FLUSH_MAX_MS = 5000
/** A sync slower than this is one worth doing less often. */
const SLOW_SYNC_MS = 100

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

class CheckpointWriteError extends Error {
  constructor(cause: unknown) {
    super(`Could not save the resume checkpoint: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'CheckpointWriteError'
  }
}

const CHECKPOINT_WARNING = 'Resume checkpoint could not be saved; retrying…'

export class TaskRunner {
  private controller = new AbortController()
  private segmenter: Segmenter | null = null
  private fh: FileHandle | null = null
  private inflight = new Set<Promise<void>>()
  /** Resolves the pump's wait when any connection settles - see `pumpUntilDone`. */
  private settleWaiter: (() => void) | null = null
  private received = 0
  private samples: Array<{ t: number; received: number }> = []
  private bytesSinceFlush = 0
  private lastFlush = 0
  /** Smoothed cost of the fsync barrier; drives `flushIntervalMs`. */
  private syncCostMs = 0
  private flushIntervalMs = FLUSH_EVERY_MS
  private flushPromise: Promise<void> | null = null
  private checkpointRetryAt = 0
  private checkpointFailure: Error | null = null
  private lifecyclePromise: Promise<void> | null = null
  private fatal: Error | null = null
  private restarted = false
  private urlRefreshes = 0
  private lastRefreshAt = 0
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
  /**
   * The ceiling this run was allowed to climb to. 1 means the transfer was
   * never eligible for parallelism at all, which is what `finish` checks before
   * teaching the next download anything about this host.
   */
  private connectionTarget = 1
  private busyRetries = 0
  private requestFullRange = false
  private sequentialRanges = false
  private pauseRequested = false

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
    return partPathFor(this.task.dir, this.task.filename, this.task.id, this.config.tempDir)
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
    this.pauseRequested = false
    this.controller = new AbortController()
    this.fatal = null
    this.samples = []
    this.urlRefreshes = 0
    this.lastRefreshAt = 0
    this.urlRefreshPromise = null
    this.lastRefreshedUrl = null
    this.forcedProbeUrl = null
    this.busyRetries = 0
    this.ramp = null
    this.checkpointFailure = null
    this.checkpointRetryAt = 0
    // A resolver left over from a run that threw out of the pump would wake the
    // wrong wait.
    this.settleWaiter = null

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
    let refreshRestarts = 0
    let lastReceivedOnRestart = 0

    for (;;) {
      try {
        await this.run()
        await this.finish()
        this.deps.onFinished(this.task, null)
        return
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        let checkpointError: CheckpointWriteError | null = null
        try {
          await this.teardown()
        } catch (failure) {
          checkpointError = failure instanceof CheckpointWriteError
            ? failure : new CheckpointWriteError(failure)
        }

        if (!checkpointError && !this.pauseRequested && error instanceof UrlRefreshError && this.task.youtube) {
          if (this.received > lastReceivedOnRestart) {
            refreshRestarts = 0
            lastReceivedOnRestart = this.received
          }
          if (refreshRestarts < 10) {
            refreshRestarts++
            // The partial was flushed under the URL that supplied its bytes.
            // A matching ETag at another CDN location cannot relabel it.
            // The next probe may fail before restoreOrReset runs. Do not let
            // that failure flush this old segment map under new probe metadata.
            this.segmenter = null
            this.task.finalUrl = error.url
            this.task.error = null
            this.task.detail = 'Refreshing YouTube stream…'
            this.deps.onUpdate(this.task)
            this.controller = new AbortController()
            this.fatal = null
            this.forcedProbeUrl = error.url
            continue
          }
        }
        const failure = checkpointError ?? error
        if (failure instanceof CheckpointWriteError) this.checkpointFailure = failure

        // Out of budget, not broken. The partial data and its journal stay
        // exactly as they are; the manager brings the task back when the
        // window turns.
        if (failure instanceof QuotaExceededError) {
          this.task.status = 'paused'
          this.task.error = null
          this.task.speed = 0
          this.task.eta = null
          this.task.detail = quotaDetail(failure.resumesAt)
          this.deps.onFinished(this.task, failure)
          return
        }

        if ((this.pauseRequested || ((failure instanceof AbortedError || this.controller.signal.aborted) && !this.fatal)) && !checkpointError) {
          // Probe, preallocation, or journal I/O can finish after pause() set
          // the status and briefly write "downloading" again. The settled
          // runner must always hand back a paused task.
          this.task.status = 'paused'
          this.task.detail = null
          this.task.speed = 0
          this.task.eta = null
          this.deps.onFinished(this.task, null)
        } else {
          this.task.status = 'error'
          // A 401 that reached here was not answerable - no password saved, or
          // the saved one was refused. "HTTP 401" would be true and useless;
          // what the user needs is which site is asking and where to say so.
          this.task.error =
            failure instanceof HttpStatusError && failure.statusCode === 401 && !this.task.youtube
              ? authFailureMessage(this.task.finalUrl || this.task.url, this.deps.auth?.realm ?? null, this.deps.auth?.armed === true)
              : failure.message
          this.task.speed = 0
          this.task.eta = null
          this.deps.onFinished(this.task, failure)
        }
        return
      }
    }
  }

  /** Stops cleanly, leaving the part file and journal ready to resume from. */
  async pause(): Promise<void> {
    this.pauseRequested = true
    if (!this.running) {
      if (this.checkpointFailure) throw this.checkpointFailure
      this.task.status = 'paused'
      this.task.speed = 0
      this.task.eta = null
      this.deps.onUpdate(this.task)
      return
    }

    this.task.status = 'paused'
    this.controller.abort()
    await this.lifecyclePromise?.catch(() => {})
    if (this.checkpointFailure) throw this.checkpointFailure
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
      if (this.ramp.settled) {
        try {
          const host = new URL(this.task.finalUrl || this.task.url).hostname.toLowerCase()
          recordLearnedHostCap(host, this.connectionCap)
        } catch {}
      }
      // Climbing needs the new slots filled now; stepping back down needs
      // nothing, because `fill` simply stops replacing what retires.
      this.fill()
    }

    const due =
      this.bytesSinceFlush >= FLUSH_EVERY_BYTES || now - this.lastFlush >= this.flushIntervalMs
    if (due && now >= this.checkpointRetryAt) {
      void this.flushJournal(false).catch((error) => {
        this.checkpointRetryAt = Date.now() + 2000
        log.warn(`${this.task.filename}: resume checkpoint write failed: ${error instanceof Error ? error.message : String(error)}`)
        if (this.task.detail !== CHECKPOINT_WARNING) {
          this.task.detail = CHECKPOINT_WARNING
          this.deps.onUpdate(this.task)
        }
      })
    }
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
      // The itag this half is for, which is the audio one on the audio child of
      // a merged download. Pinning the prepared URL to the video itag there
      // rejected a perfectly good audio URL and sent every audio half back
      // through yt-dlp.
      const requestedItag = Number(youtubeFormatId(this.task.youtube).split('-')[0])
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
        signal: this.controller.signal,
        fresh: true,
        auth: this.deps.auth
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
    // Parallel byte ranges are safe only when every response can prove it is
    // from the same resource version. Without a strong validator, one stream
    // gives a coherent response and a restart begins from zero.
    this.task.resumable = probe.resumable && isStrongEtag(probe.etag) && !this.task.singleConnectionFallback
    // Range transport and safe resume are separate capabilities. Google media
    // can throttle or reject a plain GET while serving a full-file Range quickly.
    // Without a validator, use one response except for fixed signed YouTube
    // resources, which need bounded chunks. Neither case adopts old partials.
    this.requestFullRange = probe.resumable && !this.task.resumable && !this.task.singleConnectionFallback
    this.sequentialRanges = this.requestFullRange && isFixedYouTubeResource(probe.finalUrl, probe.size)
    this.task.etag = probe.etag
    this.task.lastModified = probe.lastModified
    this.task.mimeType = probe.mimeType
    if (!this.task.filenameLocked) this.task.filename = probe.filename

    // The category - and therefore the directory - depends on the extension and
    // MIME type, neither of which was known before the probe.
    await this.deps.onProbed?.(this.task)
    if (this.controller.signal.aborted) throw new AbortedError()

    this.task.dir = await ensureDownloadDirectory(this.task.dir)
    await mkdir(dirname(this.partPath), { recursive: true })

    if (this.config.checkDiskSpace && this.task.size !== null && this.task.size > 0) {
      // Measured on the volume the bytes actually accumulate on, which is the
      // workspace rather than the destination. Asking about the destination
      // while writing somewhere else can pass and then fill the other disk.
      const target = dirname(this.partPath)
      try {
        const stats = await statfs(target)
        const free = stats.bavail * stats.bsize
        /*
         * Charge only for what is still missing.
         *
         * A part file left by an earlier run has already taken its space out of
         * `free` - the whole file under `valid-data` preallocation, and the
         * written portion under the sparse fallback. Asking for the full size
         * again on top of that failed every resume of a download larger than the
         * remaining free space, which is precisely the case preallocation makes
         * ordinary: a 400 GB transfer at 99% on a 500 GB disk demanded another
         * 400 GB and refused to continue.
         *
         * `blocks` is what the file actually occupies, so it reads correctly
         * under both modes where `size` would only be right under one.
         */
        const existing = await stat(this.partPath).catch(() => null)
        const reserved = existing?.isFile() ? (existing.blocks ?? 0) * 512 : 0
        const needed = this.task.size + 10 * 1024 * 1024
        if (free + reserved < needed) {
          throw new Error(
            `Not enough disk space. Requires ${Math.ceil((needed - reserved) / (1024 * 1024))} MB.`
          )
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('Not enough disk space')) throw err
        // Ignore statfs errors (e.g. unsupported on some network drives)
      }
    }

    const restored = await this.restoreOrReset(probe.size)
    if (this.controller.signal.aborted) throw new AbortedError()

    // Only a server that honours ranges *and* told us the length can be split.
    const connectionTarget =
      this.task.resumable && this.task.size !== null
        ? Math.max(this.config.maxConnections, this.config.connectionCeiling ?? 0)
        : 1
    this.connectionTarget = connectionTarget
    // The configured maximum is a ceiling the ramp climbs towards on evidence,
    // never a number of connections to open on faith.
    let startConnections = Math.min(RAMP_START_CONNECTIONS, connectionTarget)
    try {
      const host = new URL(this.task.finalUrl || this.task.url).hostname.toLowerCase()
      const learned = getLearnedHostCap(host)
      if (learned !== null) {
        startConnections = Math.min(learned, connectionTarget)
      }
    } catch {}

    this.ramp = new ConnectionRamp(startConnections, connectionTarget)
    this.connectionCap = this.ramp.cap
    this.task.connections = this.connectionCap

    const preallocated = !restored && process.platform === 'win32' && this.task.size !== null && this.task.size > 0
    if (preallocated) {
      // Reserving the whole range now is what keeps every segment's offset
      // valid from the first write. Which of the two workable ways it gets is
      // a property of the volume and the privileges to hand - see preallocate.
      const mode = await preallocate(this.partPath, this.task.size!)
      log.info(`${this.task.filename}: reserved ${this.task.size} bytes (${mode})`)
    }

    if (this.controller.signal.aborted) throw new AbortedError()

    // Opening with w+ would discard the allocation and valid data length that
    // preallocate just established, restoring NTFS's expensive zero-fill.
    this.fh = await open(this.partPath, restored || preallocated ? 'r+' : 'w+')

    // A restored file is already this long and a fresh one was just reserved,
    // so this is the safety net for the case where neither held.
    if (this.task.size !== null && this.task.size > 0) {
      await this.fh.truncate(this.task.size)
    }

    if (this.controller.signal.aborted) throw new AbortedError()

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
    const part = await stat(this.partPath).catch(() => null)

    if (
      journal &&
      part?.isFile() &&
      journal.url === this.task.url &&
      this.task.resumable &&
      journalSegmentsValid(journal.segments, size) &&
      // Extending a truncated part file would fill missing, supposedly saved
      // bytes with zeros and then report a corrupt download as complete.
      journal.segments.every((seg) => seg.position === seg.start || seg.position <= part.size) &&
      journalMatches(journal, {
        finalUrl: this.task.finalUrl,
        filename: this.task.filename,
        size: this.task.size,
        resumable: this.task.resumable,
        etag: this.task.etag,
        lastModified: this.task.lastModified,
        mimeType: this.task.mimeType,
        statusCode: 206
      })
    ) {
      this.segmenter = Segmenter.restore(journal.segments, size, this.config.minSplitSize)
      this.received = this.segmenter.received
      this.task.received = this.received
      return true
    }

    // Either nothing to resume, or the remote file moved on. Starting over is
    // the cheap mistake; splicing two different files together is not.
    if (journal && part?.isFile()) {
      this.task.detail = 'Saved bytes could not be verified against the source; restarting from zero.'
      log.warn(`${this.task.filename}: discarded a partial download that could not be verified`)
    }
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
        // `complete` was checked at the top of this iteration, so reaching here
        // with nothing in flight is always the disagreement.
        throw this.fatal ?? new Error('Download stalled with work outstanding')
      }

      // A latch rather than `Promise.race([...this.inflight])`. Racing attaches
      // a fresh continuation to every surviving promise on every pass, so with
      // sixteen connections and hundreds of segments the handlers accumulated
      // in proportion to connections x completions - all of them settling
      // eventually, but all of them allocated on the transfer's hot path.
      // `launch` resolves this latch once, whichever connection finishes first.
      await new Promise<void>((resolve) => {
        this.settleWaiter = resolve
      })
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
      exponentialBackoff: this.config.exponentialBackoff ?? false,
      expectedSize: this.task.size,
      expectedEtag: this.task.etag,
      useRanges: this.task.resumable,
      requestFullRange: this.requestFullRange,
      sequentialRanges: this.sequentialRanges,
      signal: this.controller.signal,
      writeBufferBytes: Math.min(MAX_WRITE_BUFFER_BYTES, this.config.minSplitSize),
      auth: this.deps.auth,
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
              const now = Date.now()
              if (this.lastRefreshAt > 0 && now - this.lastRefreshAt < 5000) {
                if (this.lastRefreshedUrl) {
                  this.fatal = new UrlRefreshError(this.lastRefreshedUrl)
                  this.controller.abort()
                  return
                }
                throw new Error('YouTube media URL expired and refresh failed to resolve')
              }
              if (this.urlRefreshes >= 10) {
                throw new Error('YouTube media URL expired repeatedly')
              }
              this.urlRefreshes++
              this.lastRefreshAt = now
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
          try {
            const host = new URL(this.task.finalUrl || this.task.url).hostname.toLowerCase()
            recordLearnedHostCap(host, this.connectionCap)
          } catch {}
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
          await delay(waitMs, this.controller.signal)
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
        // Wakes `pumpUntilDone` exactly once per settled connection.
        const waiter = this.settleWaiter
        this.settleWaiter = null
        waiter?.()
      })

    this.inflight.add(promise)
  }

  private async finish(): Promise<void> {
    await this.flushJournal(true)
    if (this.controller.signal.aborted) throw new AbortedError()

    if (this.task.size !== null && this.received < this.task.size) {
      throw new Error(
        `Incomplete: got ${this.received} of ${this.task.size} bytes`
      )
    }

    await this.fh?.close()
    this.fh = null
    if (this.controller.signal.aborted) throw new AbortedError()

    // The part file is complete and has no holes left, so the sparse flag is
    // pure cost from here on - and it would otherwise follow the payload to its
    // final name and stay there. Best-effort; see `clearSparseFlag`.
    await clearSparseFlag(this.partPath)

    if (this.task.expectedChecksum) {
      this.task.detail = 'Verifying checksum...'
      this.deps.onUpdate(this.task)
      await verifyExpectedChecksum(this.partPath, this.task.expectedChecksum, this.controller.signal)
    }

    if (this.controller.signal.aborted) throw new AbortedError()

    const sourcePath = this.partPath
    let payloadPath = sourcePath
    let filename = this.task.filename
    if (this.task.postProcess === 'mp4' || this.task.postProcess === 'mp3') {
      this.task.detail = `Converting to ${this.task.postProcess.toUpperCase()}...`
      this.deps.onUpdate(this.task)
      // Keep the completed source and its checkpoint until conversion succeeds.
      // A retry can reuse its verified bytes, and no raw file escapes into the
      // destination when provisioning, conversion, or cancellation fails.
      const output = sourcePath + '.convert.' + this.task.postProcess
      try {
        const { convertMedia } = await import('./postprocess.ts')
        await convertMedia(sourcePath, output, this.task.postProcess, this.controller.signal)
        if (this.controller.signal.aborted) throw new AbortedError()
        payloadPath = output
        filename = basename(filename, extname(filename)) + '.' + this.task.postProcess
      } catch (error) {
        await rm(output, { force: true }).catch(() => {})
        throw error
      }
    }

    const target = await uniquePath(this.task.dir, filename)
    try {
      if (this.controller.signal.aborted) throw new AbortedError()
      await moveFile(payloadPath, target)
    } catch (err) {
      // The name was reserved as an empty file; a failed move must not leave it
      // sitting there holding the download's own name.
      await discardReservedPath(target)
      throw err
    }
    // The payload is already safely at its final name. Journal cleanup is
    // recovery metadata, so a transient cleanup failure must not turn a finished
    // download into a visible error.
    await removeJournal(this.journalPath).catch(() => {})
    if (payloadPath !== sourcePath) await rm(sourcePath, { force: true }).catch(() => {})

    /*
     * A download that was never allowed to go wide has measured nothing about
     * this host, and must not be allowed to say it did.
     *
     * `connectionTarget` collapses to 1 for anything non-resumable or of unknown
     * length - a chunked response, a PHP download script, a CDN that refuses
     * ranges - and the cap it finishes on is therefore 1 by construction rather
     * than by observation. Recording that taught every later download from the
     * same origin to start at a single connection and climb 1-2-4-8-16 from
     * there, so one chunked response quietly throttled the host for an hour.
     */
    if (this.connectionTarget > 1) {
      try {
        const host = new URL(this.task.finalUrl || this.task.url).hostname.toLowerCase()
        recordLearnedHostCap(host, this.connectionCap)
      } catch {}
    }

    this.task.filename = basename(target)
    this.task.status = 'done'
    // "Verifying checksum..." or "Converting to MP4..." must not outlive the
    // step it described; a finished row has nothing left to say.
    this.task.detail = null
    this.task.completedAt = Date.now()
    this.task.speed = 0
    this.task.eta = null
    this.task.received = this.task.size ?? this.received
    if (this.segmenter) this.task.segments = this.segmenter.snapshot()
  }

  private async teardown(): Promise<void> {
    await Promise.allSettled([...this.inflight])
    let failure: unknown = null
    try {
      await this.flushJournal(true)
    } catch (error) {
      failure = error
    } finally {
      try {
        await this.fh?.close()
      } catch (error) {
        failure ??= error
      }
      this.fh = null
    }
    if (failure) throw failure
  }

  /**
   * Writes the journal, at most one flush at a time.
   *
   * The guard is a loop, and it has to be, because a flush is mostly *fsync*:
   * on the sparse fallback a single `FlushFileBuffers` can run for hundreds of
   * milliseconds, which is the whole reason `flushIntervalMs` backs off. A guard
   * that only became visible after the sync left that entire window unprotected
   * - and it is exactly the window in which the next tick's 8 MB byte trigger
   * fires. Two flushes then ran concurrently, each paying for its own barrier,
   * and the later snapshot could be renamed into place before the earlier one.
   *
   * A tick arriving mid-flush has nothing to add and gives up. A forced flush -
   * pause, shutdown, finish - must land its own snapshot, so it waits and then
   * re-checks, because another waiter may have started one in the meantime.
   */
  private async flushJournal(force: boolean): Promise<void> {
    if (!this.segmenter) return
    if (this.task.size === null || !this.task.resumable) return

    while (this.flushPromise) {
      try {
        await this.flushPromise
      } catch (error) {
        if (!force) throw error
        // A forced pause or finish gets one fresh attempt after a failed
        // background checkpoint; a transient error must not block it forever.
      }
      if (!force) return
    }

    const run = this.writeJournalNow()
    this.flushPromise = run.finally(() => {
      this.flushPromise = null
    })
    await this.flushPromise
    this.checkpointRetryAt = 0
    if (this.task.detail === CHECKPOINT_WARNING) {
      this.task.detail = null
      this.deps.onUpdate(this.task)
    }
  }

  private async writeJournalNow(): Promise<void> {
    if (!this.segmenter) return

    // Snapshot before the barrier: writes completed while sync is pending may
    // not be covered by it and must not be claimed by this checkpoint.
    const segments = segmentsForJournal(this.segmenter.snapshot())
    const checkpointBytes = this.bytesSinceFlush

    // The journal may only claim bytes that are actually durable.
    try {
      if (this.fh) {
        const startedAt = Date.now()
        await this.fh.sync()
        // What the barrier cost this time decides how soon the next one is due.
        // Smoothed, so one unlucky sync does not slow the journal for the rest
        // of the download and one lucky one does not undo a genuine back-off.
        const took = Date.now() - startedAt
        this.syncCostMs = this.syncCostMs === 0 ? took : this.syncCostMs * 0.7 + took * 0.3
        this.flushIntervalMs = this.syncCostMs > SLOW_SYNC_MS
          ? Math.min(FLUSH_MAX_MS, Math.round(this.syncCostMs * 20))
          : FLUSH_EVERY_MS
      }

      await writeJournal(this.journalPath, {
        version: JOURNAL_VERSION,
        url: this.task.url,
        finalUrl: this.task.finalUrl,
        filename: this.task.filename,
        size: this.task.size,
        etag: this.task.etag,
        lastModified: this.task.lastModified,
        segments,
        updatedAt: Date.now()
      })
      this.bytesSinceFlush = Math.max(0, this.bytesSinceFlush - checkpointBytes)
      this.lastFlush = Date.now()
    } catch (error) {
      throw new CheckpointWriteError(error)
    }
  }

  /**
   * Called by the manager when a run failed because the server refused to
   * honour ranges. Wipes the partial data so the retry starts clean.
   */
  async resetForRestart(): Promise<boolean> {
    if (this.restarted) return false
    this.restarted = true
    // A locked part file (antivirus scan, search indexer) must not turn a
    // clean-restart request into an exception that escapes the manager's
    // onFinished and stalls the scheduler.
    await rm(this.partPath, { force: true }).catch(() => {})
    await removeJournal(this.journalPath).catch(() => {})
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
  return `${QUOTA_DETAIL_PREFIX}; resumes at ${time}`
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
