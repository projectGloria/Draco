import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadTask, TaskProgress } from '../../shared/types.ts'
import { QuotaExceededError, RateLimiter, type QuotaState } from './limiter.ts'
import { mapConcurrent } from './concurrency.ts'
import { getPaths } from '../bootstrap/paths.ts'
import { connectionsForUrl, type HostConnectionLimit } from './network-rules.ts'
import { setProxyUrl } from './http.ts'
import { readJournal, removeJournal } from './journal.ts'
import type { Runner } from './runner.ts'
import { TaskRunner } from './task.ts'
import { logger } from '../log.ts'
import { downloadSubtitles } from '../media/subtitles.ts'
import { scanFile } from '../security/scanner.ts'
import { normalizeDownloadDirectory } from '../destination-path.ts'
import { TorrentRunner } from './torrent.ts'

const log = logger('manager')
const RECOVERY_CONCURRENCY = 8

/**
 * Owns every task and decides which of them are allowed to run.
 *
 * Deliberately free of Electron imports: the main process wires it to IPC and
 * the JSON store, while `tools/dl.ts` wires it to a terminal. Both drive the
 * exact same engine.
 */

export interface EngineSettings {
  catMode?: boolean
  maxConcurrentTasks: number
  checkDiskSpace?: boolean
  exponentialBackoff?: boolean
  maxConnectionsPerTask: number
  /** Optional: how far the adaptive ramp may climb past the line above. */
  adaptiveConnectionCeiling?: number | null
  minSplitSize: number
  retryLimit: number
  timeoutMs: number
  speedLimit: number | null
  proxyUrl: string | null
  hostConnectionLimits: HostConnectionLimit[]
  quotaBytes: number | null
  quotaWindowMinutes: number
  antivirusProgram: string | null
  antivirusArgs: string[]
  antivirusTimeoutSeconds: number
}

/** Everything a runner needs from the manager, whatever kind of runner it is. */
export interface RunnerContext {
  limiter: RateLimiter
  maxConnections: number
  retryLimit: number
  timeoutMs: number
  proxyUrl: string | null
  tempDir: string
  checkDiskSpace?: boolean
  exponentialBackoff?: boolean
  onUpdate(task: DownloadTask): void
  onFinished(task: DownloadTask, error: Error | null): void
  onProbed?(task: DownloadTask): void | Promise<void>
  /**
  * The signed media URL for this task's format.
  *
  * `force` distinguishes the two callers: starting a download wants whatever
  * the last lookup found and is happy with a cached answer, while a 403
  * part-way through means the URL in hand has expired and only a fresh lookup
  * will do. Passing `true` on both would run yt-dlp again for every start,
  * throwing away the lookup the confirm window already primed.
  */
  refreshYouTube?(task: DownloadTask, force: boolean): Promise<string>
}

export interface ManagerOptions {
  getSettings(): EngineSettings
  /** Called when the task list itself changes - additions, removals, statuses. */
  onTasks(tasks: DownloadTask[]): void
  /** The 4 Hz batched progress feed. */
  onProgress(updates: TaskProgress[]): void
  onQuotaState?(state: QuotaState): void
  /** Chance to re-file a task once the probe knows its real name and type. */
  onProbed?(task: DownloadTask): void | Promise<void>
  /**
   * Builds the runner for a playlist task. Injected rather than imported so this
   * file stays free of Electron and of ffmpeg: `tools/dl.ts` drives the very
   * same manager from a terminal, and only the app can provision a muxer.
   */
  createHlsRunner?(task: DownloadTask, context: RunnerContext): Runner
  createMpdRunner?(task: DownloadTask, context: RunnerContext): Runner
  createDashRunner?(task: DownloadTask, context: RunnerContext): Runner
  refreshYouTube?: (task: DownloadTask, force: boolean) => Promise<string>
}

/** How often speed, ETA and segment snapshots are recomputed and published. */
const TICK_MS = 250

export class DownloadManager {
  private tasks = new Map<string, DownloadTask>()
  private runners = new Map<string, Runner>()
  private limiter = new RateLimiter(null)
  private ticker: NodeJS.Timeout | null = null
  private disposed = false
  private lastQuotaSnapshotAt = 0
  private lastQuotaUsed = -1
  /** Tasks stopped by the transfer quota, to be started again by `quotaTimer`. */
  private quotaHeld = new Set<string>()
  private quotaTimer: NodeJS.Timeout | null = null
  private catTimer: NodeJS.Timeout | null = null

  private options: ManagerOptions

  constructor(options: ManagerOptions) {
    this.options = options
    // Deliberately no settings read here. The manager is constructed during
    // startup, before the settings file has been loaded, and the limiter starts
    // unlimited anyway - `schedule()` applies the real limit before any task
    // gets a chance to move a byte.
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Adopts tasks restored from disk. Anything caught mid-flight comes back paused. */
  async load(tasks: DownloadTask[]): Promise<void> {
    await mapConcurrent(tasks, RECOVERY_CONCURRENCY, async (task) => {
      task.dir = normalizeDownloadDirectory(task.dir)
      if (task.status === 'downloading' || task.status === 'probing' || task.status === 'queued') {
        task.status = 'paused'
        task.speed = 0
        task.eta = null
      }

      // Every unfinished task, not only the ones caught mid-flight: a task that
      // was already written as paused can still have a journal ahead of what
      // tasks.json recorded, because the kill that stranded it may have come
      // several restarts ago.
      if (task.status !== 'done') await reconcileWithJournal(task)
    })

    // Reconciliation is parallel, but insertion remains deterministic so the
    // persisted order is also the order restored into the UI.
    for (const task of tasks) {
      this.tasks.set(task.id, task)
    }
    this.emitTasks()
  }

  dispose(): void {
    this.disposed = true
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    if (this.quotaTimer) clearTimeout(this.quotaTimer)
    this.quotaTimer = null
  }

  /** Pauses everything and waits for the journals to land. Used on quit. */
  async shutdown(): Promise<void> {
    this.dispose()
    await Promise.allSettled([...this.runners.values()].map((r) => r.pause()))
    this.options.onQuotaState?.(this.limiter.quotaState)
  }

  restoreQuota(state: QuotaState | null): void {
    this.applyNetworkSettings()
    this.limiter.restoreQuota(state)
  }

  applySettings(): void {
    this.applyNetworkSettings()
    this.schedule()
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  list(): DownloadTask[] {
    return [...this.tasks.values()]
  }

  get(id: string): DownloadTask | undefined {
    return this.tasks.get(id)
  }

  /** Persists scheduler-owned task metadata such as delayed retry timestamps. */
  notifyTaskMetadataChanged(): void {
    this.emitTasks()
  }

  /* ---------------------------------------------------------------- */
  /* Commands                                                          */
  /* ---------------------------------------------------------------- */

  add(task: DownloadTask, autoStart = true): DownloadTask {
    task.dir = normalizeDownloadDirectory(task.dir)
    log.info(`Added task ${task.id} (${task.filename}) - autoStart: ${autoStart}`)
    this.tasks.set(task.id, task)
    task.status = autoStart ? 'queued' : 'paused'
    this.emitTasks()
    this.schedule()
    return task
  }

  start(ids: string[], preserveQueueRetry = false): void {
    log.info(`Start requested for ${ids.length} tasks`)
    for (const id of ids) {
      const task = this.tasks.get(id)
      if (!task) continue
      if (task.status === 'downloading' || task.status === 'probing') continue
      if (task.status === 'done') continue

      log.info(`Queued task ${task.id} (${task.filename})`)
      task.manualPause = false
      if (!preserveQueueRetry) {
        task.queueRetryCount = 0
        task.nextQueueAttemptAt = null
      }
      task.status = 'queued'
      task.error = null
    }
    this.emitTasks()
    this.schedule()
  }

  /**
   * @param byUser Distinguishes "the person pressed Stop" from the scheduler
   *   parking a queue that left its time window. Only the first outranks the
   *   queue, which is otherwise entitled to start a paused task straight back up.
   */
  async pause(ids: string[], byUser = false): Promise<void> {
    log.info(`Pause requested for ${ids.length} tasks`)
    const waits: Promise<void>[] = []

    for (const id of ids) {
      const task = this.tasks.get(id)
      if (!task) continue
      // An explicit pause outranks the quota hold; the timer must not undo it.
      this.quotaHeld.delete(id)
      if (byUser) task.manualPause = true

      const runner = this.runners.get(id)
      if (runner) {
        waits.push(runner.pause())
      } else if (task.status === 'queued') {
        task.status = 'paused'
      }
    }

    await Promise.allSettled(waits)
    this.emitTasks()
    this.schedule()
  }

  async pauseAll(byUser = false): Promise<void> {
    await this.pause([...this.tasks.keys()], byUser)
  }

  async remove(ids: string[], deleteFiles: boolean): Promise<void> {
    await this.pause(ids)

    for (const id of ids) {
      const task = this.tasks.get(id)
      if (!task) continue

      const part = join(task.dir, task.filename + '.dracodl')
      // The partial file, its journal and any downloaded playlist pieces are
      // ours; they always go.
      await rm(part, { force: true }).catch(() => {})
      await removeJournal(part + '.json').catch(() => {})
      
      if (task.audioUrl) {
        // The muxed halves are Draco's own intermediates. They outlive a failed
        // merge on purpose - the retry adopts them - so removing the task is the
        // point they stop being anybody's, files and partials alike.
        await rm(join(task.dir, task.filename + '.v.mp4'), { force: true }).catch(() => {})
        await rm(join(task.dir, task.filename + '.a.m4a'), { force: true }).catch(() => {})
        await rm(join(task.dir, task.filename + '.v.mp4.dracodl'), { force: true }).catch(() => {})
        await removeJournal(join(task.dir, task.filename + '.v.mp4.dracodl.json')).catch(() => {})
        await rm(join(task.dir, task.filename + '.a.m4a.dracodl'), { force: true }).catch(() => {})
        await removeJournal(join(task.dir, task.filename + '.a.m4a.dracodl.json')).catch(() => {})
      }

      await rm(join(task.dir, task.filename + '.dracoparts'), {
        recursive: true,
        force: true
      }).catch(() => {})
      // The playlist runner's joined halves, left behind when a merge failed.
      await rm(join(task.dir, task.filename + '.dracodl.audio'), { force: true }).catch(() => {})

      if (deleteFiles && task.status === 'done') {
        await rm(join(task.dir, task.filename), { force: true }).catch(() => {})
      }

      this.tasks.delete(id)
      this.runners.delete(id)
      this.quotaHeld.delete(id)
    }

    this.emitTasks()
    this.schedule()
  }

  removeCompleted(): Promise<void> {
    const done = this.list()
      .filter((t) => t.status === 'done')
      .map((t) => t.id)
    return this.remove(done, false)
  }

  /* ---------------------------------------------------------------- */
  /* Scheduling                                                        */
  /* ---------------------------------------------------------------- */

  private get activeCount(): number {
    return this.runners.size
  }

  /** Promotes queued tasks into runners while there is room for them. */
  private schedule(): void {
    if (this.disposed) return

    const { maxConcurrentTasks } = this.options.getSettings()
    this.applyNetworkSettings()

    for (const task of this.tasks.values()) {
      if (this.activeCount >= maxConcurrentTasks) break
      if (task.status !== 'queued') continue
      if (this.runners.has(task.id)) continue
      this.launch(task)
    }

    this.ensureTicker()
    this.ensureCatTimer()
  }

  private launch(task: DownloadTask): void {
    const settings = this.options.getSettings()
    const maxConnections = connectionsForUrl(
      task.youtube?.pageUrl ?? task.url,
      settings.maxConnectionsPerTask,
      settings.hostConnectionLimits
    )
    const effectiveConnections = task.singleConnectionFallback ? 1 : maxConnections
    // The ramp may be let past the configured maximum, but never past a
    // per-host rule: that one was written for this origin on purpose.
    const ceiling = connectionsForUrl(
      task.youtube?.pageUrl ?? task.url,
      Math.max(settings.maxConnectionsPerTask, settings.adaptiveConnectionCeiling ?? 0),
      settings.hostConnectionLimits
    )
    const connectionCeiling = task.singleConnectionFallback ? 1 : ceiling

    const context: RunnerContext = {
      limiter: this.limiter,
      maxConnections: effectiveConnections,
      retryLimit: settings.retryLimit,
      timeoutMs: settings.timeoutMs,
      proxyUrl: settings.proxyUrl,
      tempDir: getPaths().tempDir,
      checkDiskSpace: settings.checkDiskSpace,
      exponentialBackoff: settings.exponentialBackoff,
      onUpdate: () => this.emitTasks(),
      onFinished: (finished, error) => {
        const r = this.runners.get(task.id)
        if (r) void this.onFinished(r, finished, error)
      },
      onProbed: (probed) => this.options.onProbed?.(probed),
      refreshYouTube: this.options.refreshYouTube
    }

    let runner: Runner

    if (task.kind === 'hls') {
      const build = this.options.createHlsRunner
      if (!build) {
        task.status = 'error'
        task.error = 'Playlist downloads are not available in this build'
        this.emitTasks()
        return
      }
      runner = build(task, context)
    } else if (task.kind === 'dash') {
      const build = this.options.createMpdRunner
      if (!build) {
        task.status = 'error'
        task.error = 'MPEG-DASH downloads are not available in this build'
        this.emitTasks()
        return
      }
      runner = build(task, context)
    } else if (task.audioUrl) {
      const build = this.options.createDashRunner
      if (!build) {
        task.status = 'error'
        task.error = 'Dash downloads are not available in this build'
        this.emitTasks()
        return
      }
      runner = build(task, context)
    } else if (task.kind === 'torrent') {
      runner = new TorrentRunner(task, context)
    } else {
      runner = new TaskRunner(
        task,
        {
          maxConnections: effectiveConnections,
          connectionCeiling,
          minSplitSize: settings.minSplitSize,
          retryLimit: settings.retryLimit,
          timeoutMs: settings.timeoutMs,
          tempDir: getPaths().tempDir,
          checkDiskSpace: settings.checkDiskSpace,
          exponentialBackoff: settings.exponentialBackoff
        },
        {
          limiter: context.limiter,
          onUpdate: context.onUpdate,
          onFinished: context.onFinished,
          onProbed: context.onProbed
        }
      )
    }

    this.runners.set(task.id, runner)
    log.info(`Launching task ${task.id} (${task.filename})`)
    void runner.start()
  }

  private applyNetworkSettings(): void {
    const settings = this.options.getSettings()
    this.limiter.setLimit(settings.speedLimit)
    this.limiter.setQuota(settings.quotaBytes, settings.quotaWindowMinutes * 60_000)
    setProxyUrl(settings.proxyUrl)
  }

  private async onFinished(
    runner: Runner,
    task: DownloadTask,
    error: Error | null
  ): Promise<void> {
    task.isCatMode = false
    if (this.runners.get(task.id) === runner) {
      this.runners.delete(task.id)
    }

    if (!error && task.status === 'done' && task.subtitles && task.subtitles.length > 0) {
      task.detail = 'Saving subtitles…'
      this.emitTasks()
      const result = await downloadSubtitles(task, this.limiter, this.options.getSettings().timeoutMs)
      task.detail = result.warnings.length > 0
        ? `Video complete; ${result.warnings.length} subtitle track(s) failed`
        : null
      if (result.warnings.length > 0) log.warn(result.warnings.join('; '))
    }

    const settings = this.options.getSettings()
    if (!error && task.status === 'done' && settings.antivirusProgram) {
      task.detail = 'Scanning completed file…'
      this.emitTasks()
      try {
        await scanFile(
          settings.antivirusProgram,
          settings.antivirusArgs,
          join(task.dir, task.filename),
          settings.antivirusTimeoutSeconds * 1000
        )
        task.detail = null
      } catch (scanError) {
        task.detail = `Download complete; security scan failed: ${scanError instanceof Error ? scanError.message : String(scanError)}`
        log.warn(task.detail)
      }
    }

    if (error instanceof QuotaExceededError) {
      // Not a failure and not the user's doing: hold the task and bring it back
      // when the window turns, so an overnight queue survives its own budget.
      log.info(`Task ${task.id} (${task.filename}) held: transfer quota reached`)
      task.status = 'paused'
      task.error = null
      this.holdForQuota(task.id, error.resumesAt)
      this.emitTasks()
      this.schedule()
      return
    }

    if (error) {
      log.error(`Task ${task.id} (${task.filename}) failed`, error)
    } else if (task.status === 'done') {
      log.info(`Task ${task.id} (${task.filename}) finished successfully`)
    } else {
      log.info(`Task ${task.id} (${task.filename}) stopped. Status: ${task.status}`)
    }

    // A server that advertised ranges and then ignored one leaves partial data
    // that can never line up. Wipe it and take one clean single-connection run
    // before giving up, since that almost always succeeds.
    if (
      error &&
      TaskRunner.isNotResumable(error) &&
      !task.singleConnectionFallback &&
      (await runner.resetForRestart())
    ) {
      log.warn(`Task ${task.id} (${task.filename}) restarting cleanly due to resumability failure`)
      task.singleConnectionFallback = true
      task.status = 'queued'
      task.error = null
      this.emitTasks()
      this.schedule()
      return
    }

    this.emitTasks()
    this.schedule()
  }

  /**
   * Parks a task until the transfer window rolls over and starts it again.
   *
   * One timer for all of them: the window is global, so every held task comes
   * back at the same moment. A second of slack keeps the restart on the far
   * side of the rollover rather than racing it.
   */
  private holdForQuota(id: string, resumesAt: number): void {
    this.quotaHeld.add(id)
    if (this.quotaTimer || this.disposed) return

    const wait = Math.min(6 * 3600_000, Math.max(1000, resumesAt - Date.now() + 1000))
    this.quotaTimer = setTimeout(() => {
      this.quotaTimer = null
      const held = [...this.quotaHeld]
      this.quotaHeld.clear()
      if (this.disposed || held.length === 0) return

      // Still no budget - the user may have narrowed the quota while we waited.
      const remaining = this.limiter.quotaRemaining
      if (remaining !== null && remaining <= 0) {
        for (const heldId of held) this.holdForQuota(heldId, Date.now() + 60_000)
        return
      }

      for (const heldId of held) {
        const task = this.tasks.get(heldId)
        if (task && task.status === 'paused') task.detail = null
      }
      log.info(`transfer quota window rolled over; resuming ${held.length} task(s)`)
      this.start(held, true)
    }, wait)
    this.quotaTimer.unref?.()
  }

  /* ---------------------------------------------------------------- */
  /* Progress feed                                                     */
  /* ---------------------------------------------------------------- */

  private ensureCatTimer(): void {
    if (this.disposed) return
    const { catMode } = this.options.getSettings()

    if (!catMode) {
      if (this.catTimer) {
        clearInterval(this.catTimer)
        this.catTimer = null
      }
      return
    }

    if (this.catTimer) return

    this.catTimer = setInterval(() => {
      if (this.disposed) return
      
      const queuedTasks = [...this.tasks.values()].filter((t) => t.status === 'queued' && !this.runners.has(t.id))
      if (queuedTasks.length === 0) return

      // Round-robin: always pick the one that hasn't been pinged in the longest time.
      queuedTasks.sort((a, b) => (a.lastCatPingAt ?? 0) - (b.lastCatPingAt ?? 0))
      const task = queuedTasks[0]
      task.lastCatPingAt = Date.now()
      task.isCatMode = true
      task.status = 'downloading'
      this.emitTasks()

      log.info(`Cat mode started for queued task ${task.id} (${task.filename})`)
      
      const settings = this.options.getSettings()
      
      // Cat mode limit: ~100 KB/s
      const catLimiter = new RateLimiter(102400)

      const context: RunnerContext = {
        limiter: catLimiter,
        maxConnections: 1,
        retryLimit: settings.retryLimit,
        timeoutMs: settings.timeoutMs,
        proxyUrl: settings.proxyUrl,
        tempDir: getPaths().tempDir,
        onUpdate: () => this.emitTasks(),
        onFinished: (finished, error) => {
          const r = this.runners.get(task.id)
          if (r) void this.onFinished(r, finished, error)
        },
        onProbed: (probed) => this.options.onProbed?.(probed),
        refreshYouTube: this.options.refreshYouTube
      }

      let runner: Runner
      if (task.kind === 'hls') {
        const build = this.options.createHlsRunner
        if (!build) return
        runner = build(task, context)
      } else if (task.audioUrl) {
        const build = this.options.createDashRunner
        if (!build) return
        runner = build(task, context)
      } else if (task.kind === 'torrent') {
        runner = new TorrentRunner(task, context)
      } else {
        runner = new TaskRunner(
          task,
          {
            maxConnections: 1,
            minSplitSize: settings.minSplitSize,
            retryLimit: settings.retryLimit,
            timeoutMs: settings.timeoutMs,
            tempDir: getPaths().tempDir,
            checkDiskSpace: settings.checkDiskSpace,
            exponentialBackoff: settings.exponentialBackoff
          },
          {
            limiter: context.limiter,
            onUpdate: context.onUpdate,
            onFinished: context.onFinished,
            onProbed: context.onProbed,
            refreshYouTube: context.refreshYouTube
          }
        )
      }

      this.runners.set(task.id, runner)
      void runner.start()

      // Stop it after 5 to 10 seconds
      const durationMs = 5000 + Math.random() * 5000
      setTimeout(() => {
        if (this.runners.get(task.id) === runner) {
          log.info(`Cat mode ended for task ${task.id} (${task.filename})`)
          void this.pause([task.id]).then(() => {
            task.isCatMode = false
            // Put it back to queued if it wasn't manually paused during this time
            if (!task.manualPause && task.status === 'paused') {
              task.status = 'queued'
              this.emitTasks()
              this.schedule()
            }
          })
        }
      }, durationMs)

    }, 30_000)
  }

  private ensureTicker(): void {
    if (this.ticker || this.disposed) return

    this.ticker = setInterval(() => {
      if (this.runners.size === 0) {
        // Nothing to report: stop the timer rather than waking the renderer
        // four times a second for an idle app.
        if (this.ticker) clearInterval(this.ticker)
        this.ticker = null
        return
      }

      const updates: TaskProgress[] = []
      for (const runner of this.runners.values()) {
        runner.tick()
        const t = runner.task
        updates.push({
          id: t.id,
          received: t.received,
          size: t.size,
          speed: t.speed,
          eta: t.eta,
          status: t.status,
          segments: t.segments,
          error: t.error,
          detail: t.detail,
          torrentInfo: t.torrentInfo
        })
      }

      if (updates.length > 0) this.options.onProgress(updates)
      const now = Date.now()
      // A quota is a coarse budget - losing up to 30s of it to a crash costs
      // nothing - and there is nothing to persist at all when no quota is set
      // or usage hasn't moved since the last snapshot.
      if (now - this.lastQuotaSnapshotAt >= 30_000 && this.limiter.quotaRemaining !== null) {
        const state = this.limiter.quotaState
        if (state.used !== this.lastQuotaUsed) {
          this.lastQuotaSnapshotAt = now
          this.lastQuotaUsed = state.used
          this.options.onQuotaState?.(state)
        }
      }
    }, TICK_MS)

    // The ticker must never be the reason the process stays alive.
    this.ticker.unref?.()
  }

  private emitTasks(): void {
    this.options.onTasks(this.list())
  }
}

/**
 * tasks.json is written on a one-second coalesce, so a process that was killed
 * mid-download left it behind by however much landed in that last second - or,
 * after a hard kill, by a great deal more.
 *
 * The journal beside the part file is the record that is actually kept current,
 * so a restored task takes its progress from there. Without this the list shows
 * a download at 0.2% that is really at 20%, and only tells the truth once the
 * user presses Resume - which reads as data lost.
 */
async function reconcileWithJournal(task: DownloadTask): Promise<void> {
  if (task.kind === 'hls') {
    await reconcileHlsPieces(task)
    return
  }

  if (task.audioUrl) {
    const vJournal = await readJournal(join(task.dir, task.filename + '.v.mp4.dracodl.json'))
    const aJournal = await readJournal(join(task.dir, task.filename + '.a.m4a.dracodl.json'))
    
    task.received = 0
    task.segments = []

    // A half that finished has no journal left - it was renamed to its own name
    // and its journal removed. Its size on disk is the progress it represents,
    // and without it a pair waiting only to be merged came back reading 0%.
    let finishedBytes = 0
    for (const half of ['.v.mp4', '.a.m4a']) {
      const info = await stat(join(task.dir, task.filename + half)).catch(() => null)
      if (info?.isFile()) finishedBytes += info.size
    }
    task.received += finishedBytes
    
    if (vJournal && vJournal.segments.length > 0) {
      const vSegs = vJournal.segments.map((seg) => ({ ...seg, active: false }))
      task.received += vSegs.reduce((sum, seg) => sum + (seg.position - seg.start), 0)
      task.segments.push(...vSegs)
    }
    
    if (aJournal && aJournal.segments.length > 0) {
      const aSegs = aJournal.segments.map((seg) => ({ ...seg, active: false }))
      task.received += aSegs.reduce((sum, seg) => sum + (seg.position - seg.start), 0)
      task.segments.push(...aSegs)
    }
    
    if (vJournal?.size !== null && vJournal?.size !== undefined && aJournal?.size !== null && aJournal?.size !== undefined) {
      task.size = vJournal.size + aJournal.size
    } else if (finishedBytes > 0 && task.size !== null && task.size < task.received) {
      // The recorded total predates the halves that are now complete.
      task.size = task.received
    }
    return
  }

  const journal = await readJournal(join(task.dir, task.filename + '.dracodl.json'))
  if (!journal || journal.segments.length === 0) return

  // Only the byte bookkeeping is adopted. Whether the journal may actually be
  // resumed into is decided against a fresh probe when the task starts; that
  // check belongs to the runner and is not weakened here.
  task.segments = journal.segments.map((seg) => ({ ...seg, active: false }))
  task.received = task.segments.reduce((sum, seg) => sum + (seg.position - seg.start), 0)
  if (journal.size !== null) task.size = journal.size
}

/**
 * A playlist download keeps no journal - its finished pieces on disk are the
 * record. Adding them up is how a restored stream reports the progress it
 * really has.
 */
async function reconcileHlsPieces(task: DownloadTask): Promise<void> {
  const dir = join(task.dir, task.filename + '.dracoparts')

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  const partNames = entries.filter((name) => name.endsWith('.part'))
  const sizes = await mapConcurrent(partNames, RECOVERY_CONCURRENCY, async (name) => {
    const info = await stat(join(dir, name)).catch(() => null)
    return info?.size ?? 0
  })
  const bytes = sizes.reduce((sum, size) => sum + size, 0)

  if (bytes > 0) task.received = bytes
  task.segments = []
}
