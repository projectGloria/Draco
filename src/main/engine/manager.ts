import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadTask, TaskProgress } from '../../shared/types.ts'
import { RateLimiter, type QuotaState } from './limiter.ts'
import { connectionsForUrl, type HostConnectionLimit } from './network-rules.ts'
import { setProxyUrl } from './http.ts'
import { readJournal, removeJournal } from './journal.ts'
import type { Runner } from './runner.ts'
import { TaskRunner } from './task.ts'
import { logger } from '../log.ts'
import { downloadSubtitles } from '../media/subtitles.ts'
import { scanFile } from '../security/scanner.ts'
import { normalizeDownloadDirectory } from '../destination-path.ts'

const log = logger('manager')

/**
 * Owns every task and decides which of them are allowed to run.
 *
 * Deliberately free of Electron imports: the main process wires it to IPC and
 * the JSON store, while `tools/dl.ts` wires it to a terminal. Both drive the
 * exact same engine.
 */

export interface EngineSettings {
  maxConcurrentTasks: number
  maxConnectionsPerTask: number
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
    for (const task of tasks) {
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

      this.tasks.set(task.id, task)
    }
    this.emitTasks()
  }

  dispose(): void {
    this.disposed = true
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
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

  async pause(ids: string[]): Promise<void> {
    log.info(`Pause requested for ${ids.length} tasks`)
    const waits: Promise<void>[] = []

    for (const id of ids) {
      const task = this.tasks.get(id)
      if (!task) continue

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

  async pauseAll(): Promise<void> {
    await this.pause([...this.tasks.keys()])
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
        await rm(join(task.dir, task.filename + '.v.mp4.dracodl'), { force: true }).catch(() => {})
        await removeJournal(join(task.dir, task.filename + '.v.mp4.dracodl.json')).catch(() => {})
        await rm(join(task.dir, task.filename + '.a.m4a.dracodl'), { force: true }).catch(() => {})
        await removeJournal(join(task.dir, task.filename + '.a.m4a.dracodl.json')).catch(() => {})
      }

      await rm(join(task.dir, task.filename + '.dracoparts'), {
        recursive: true,
        force: true
      }).catch(() => {})

      if (deleteFiles && task.status === 'done') {
        await rm(join(task.dir, task.filename), { force: true }).catch(() => {})
      }

      this.tasks.delete(id)
      this.runners.delete(id)
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
      this.launch(task)
    }

    this.ensureTicker()
  }

  private launch(task: DownloadTask): void {
    const settings = this.options.getSettings()
    const maxConnections = connectionsForUrl(
      task.youtube?.pageUrl ?? task.url,
      settings.maxConnectionsPerTask,
      settings.hostConnectionLimits
    )
    const effectiveConnections = task.singleConnectionFallback ? 1 : maxConnections

    const context: RunnerContext = {
      limiter: this.limiter,
      maxConnections: effectiveConnections,
      retryLimit: settings.retryLimit,
      timeoutMs: settings.timeoutMs,
      proxyUrl: settings.proxyUrl,
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
    } else {
      runner = new TaskRunner(
        task,
        {
          maxConnections: effectiveConnections,
          minSplitSize: settings.minSplitSize,
          retryLimit: settings.retryLimit,
          timeoutMs: settings.timeoutMs
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
    this.runners.delete(task.id)

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

  /* ---------------------------------------------------------------- */
  /* Progress feed                                                     */
  /* ---------------------------------------------------------------- */

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
          detail: t.detail
        })
      }

      if (updates.length > 0) this.options.onProgress(updates)
      const now = Date.now()
      if (now - this.lastQuotaSnapshotAt >= 1_000) {
        this.lastQuotaSnapshotAt = now
        this.options.onQuotaState?.(this.limiter.quotaState)
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

  let bytes = 0
  for (const name of entries) {
    if (!name.endsWith('.part')) continue
    const info = await stat(join(dir, name)).catch(() => null)
    if (info) bytes += info.size
  }

  if (bytes > 0) task.received = bytes
  task.segments = []
}
