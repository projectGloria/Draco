import { open, mkdir, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DownloadTask, Segment } from '../../shared/types.ts'
import { journalMatches, readJournal, removeJournal, segmentsForJournal, writeJournal, JOURNAL_VERSION } from './journal.ts'
import type { RateLimiter } from './limiter.ts'
import { uniquePath } from './naming.ts'
import { buildHeaders, probeUrl } from './probe.ts'
import { Segmenter } from './segmenter.ts'
import { AbortedError, NotResumableError, ServerBusyError, runSegment } from './worker.ts'

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

export class TaskRunner {
  private controller = new AbortController()
  private segmenter: Segmenter | null = null
  private fh: FileHandle | null = null
  private inflight = new Set<Promise<void>>()
  private received = 0
  private samples: Array<{ t: number; received: number }> = []
  private bytesSinceFlush = 0
  private lastFlush = 0
  private flushing = false
  private fatal: Error | null = null
  private restarted = false
  /**
   * Live connection budget. Starts at the configured maximum and ratchets down
   * whenever the server says it will not take another connection.
   */
  private connectionCap = 1

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
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    this.fatal = null
    this.samples = []

    try {
      await this.run()
      await this.finish()
      this.deps.onFinished(this.task, null)
    } catch (err) {
      const error = err as Error
      await this.teardown()

      if (error instanceof AbortedError) {
        // A pause is not a failure; pause() has already set the status.
        this.deps.onFinished(this.task, null)
      } else {
        this.task.status = 'error'
        this.task.error = error.message
        this.task.speed = 0
        this.task.eta = null
        this.deps.onFinished(this.task, error)
      }
    } finally {
      this.running = false
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
    await Promise.allSettled([...this.inflight])
    await this.flushJournal(true)
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

    const probe = await probeUrl(this.task.url, {
      headers: this.task.headers,
      timeoutMs: this.config.timeoutMs,
      signal: this.controller.signal
    })

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

    if (journal && partExists && this.task.resumable && journalMatches(journal, {
      finalUrl: this.task.finalUrl,
      filename: this.task.filename,
      size: this.task.size,
      resumable: this.task.resumable,
      etag: this.task.etag,
      lastModified: this.task.lastModified,
      mimeType: this.task.mimeType,
      statusCode: 206
    })) {
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
      if (this.controller.signal.aborted) throw new AbortedError()
      if (this.fatal) throw this.fatal
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
      signal: this.controller.signal,
      onBytes: (count) => {
        this.received += count
        this.bytesSinceFlush += count
      }
    })
      .then(() => {
        seg.active = false
        this.fill()
      })
      .catch(async (err: Error) => {
        seg.active = false
        if (err instanceof AbortedError) return

        // The server is capping parallelism rather than failing. Give back a
        // connection and leave the range for whoever frees up next; the work is
        // not lost, it just proceeds narrower.
        if (err instanceof ServerBusyError && this.connectionCap > 1) {
          this.connectionCap--
          this.task.connections = this.connectionCap
          // Hold the slot open while backing off, so the loop does not spin and
          // immediately re-provoke the same refusal.
          await delay(2000)
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
    await removeJournal(this.journalPath)

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
    if (this.flushing && !force) return
    if (this.task.size === null || !this.task.resumable) return

    this.flushing = true
    this.bytesSinceFlush = 0
    this.lastFlush = Date.now()

    try {
      await writeJournal(this.journalPath, {
        version: JOURNAL_VERSION,
        url: this.task.url,
        finalUrl: this.task.finalUrl,
        filename: this.task.filename,
        size: this.task.size,
        etag: this.task.etag,
        lastModified: this.task.lastModified,
        segments: segmentsForJournal(this.segmenter.snapshot()),
        updatedAt: Date.now()
      })
    } catch {
      // A failed flush costs resume granularity, not the download. Losing the
      // whole task because the journal could not be written would be worse.
    } finally {
      this.flushing = false
    }
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
