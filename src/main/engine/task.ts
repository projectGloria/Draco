import { open, mkdir, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DownloadTask, Segment } from '../../shared/types.ts'
import { journalMatches, journalSegmentsValid, readJournal, removeJournal, segmentsForJournal, writeJournal, JOURNAL_VERSION } from './journal.ts'
import type { RateLimiter } from './limiter.ts'
import { uniquePath } from './naming.ts'
import { buildHeaders, probeUrl } from './probe.ts'
import { Segmenter } from './segmenter.ts'
import { AbortedError, HttpStatusError, NotResumableError, ServerBusyError, runSegment } from './worker.ts'
import { preparedYouTubeUrl } from '../youtube-url.ts'

/**
 * Drives one download: probe, resume-or-start, keep the connection pool fed,
 * and land the finished bytes at their final name.
 */

export interface TaskRunnerConfig {
  maxConnections: number
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

/** How much can be downloaded between journal flushes before forcing one. */
const FLUSH_EVERY_BYTES = 8 * 1024 * 1024
const FLUSH_EVERY_MS = 1000
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
    if (this.segmenter) this.task.segments = this.segmenter.snapshot()

    this.task.eta =
      this.task.size !== null && this.task.speed > 1
        ? Math.max(0, Math.round((this.task.size - this.received) / this.task.speed))
        : null

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

    await mkdir(this.task.dir, { recursive: true })

    const restored = await this.restoreOrReset(probe.size)

    // Only a server that honours ranges *and* told us the length can be split.
    this.connectionCap =
      this.task.resumable && this.task.size !== null ? this.config.maxConnections : 1
    this.task.connections = this.connectionCap

    if (!restored && process.platform === 'win32' && this.task.size !== null && this.task.size > 0) {
      // Must exist before fsutil can mark it
      await open(this.partPath, 'w').then((fh) => fh.close())
      // Native sparse support guarantees ftruncate is instant even without volume privileges.
      await import('node:child_process').then(cp =>
        import('node:util').then(util =>
          util.promisify(cp.execFile)('fsutil', ['sparse', 'setflag', this.partPath], { windowsHide: true })
        )
      ).catch(() => {})
    }

    this.fh = await open(this.partPath, restored ? 'r+' : 'w+')

    // Preallocate. On NTFS this is a sparse extend, so it costs nothing up front
    // but keeps every segment's offset valid from the first write.
    if (this.task.size !== null && this.task.size > 0) {
      await this.fh.truncate(this.task.size)
    }

    this.task.status = 'downloading'
    this.task.startedAt = this.task.startedAt ?? Date.now()
    this.lastFlush = Date.now()
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
          if (this.connectionCap > 1) this.connectionCap--
          this.task.connections = this.connectionCap
          // Hold the slot open while backing off, so the loop does not spin and
          // immediately re-provoke the same refusal.
          const fallback = Math.min(30_000, 1000 * 2 ** (this.busyRetries - 1))
          await delay(err.retryAfterMs ?? fallback)
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
