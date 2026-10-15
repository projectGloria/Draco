import { readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { DownloadTask, TaskLiveDetail, TaskProgress } from '../../shared/types.ts'
import { QuotaExceededError, RateLimiter, type QuotaState } from './limiter.ts'
import { mapConcurrent } from './concurrency.ts'
import { FinalizationPool } from './finalization-pool.ts'
import { connectionsForUrl, type HostConnectionLimit } from './network-rules.ts'
import { setPoolConnections, setProxyUrl } from './http.ts'
import { readJournal } from './journal.ts'
import { discardReservedPath, uniquePath } from './naming.ts'
import type { Runner, SeedSession } from './runner.ts'
import { TaskRunner } from './task.ts'
import { logger } from '../log.ts'
import { downloadSubtitles } from '../media/subtitles.ts'
import { scanFile } from '../security/scanner.ts'
import { normalizeDownloadDirectory } from '../destination-path.ts'
import { TorrentRunner } from './torrent.ts'
import { resolveTorrentItemPath } from './torrent-path.ts'
import { describeSeeding, isSeedingDetail, seedTargetReached, type SeedTargets } from './seeding.ts'
import { HttpAuthenticator, type Credentials } from './auth.ts'
import { effectiveSpeedLimit, type ScheduledLimit } from './limit-window.ts'
import {
  intermediatePathsFor,
  migrateLegacyIntermediates,
  partPathFor,
  taskWorkspaceDir
} from './workspace.ts'

const log = logger('manager')
const RECOVERY_CONCURRENCY = 8
const FINALIZATION_CONCURRENCY = 2

/**
 * Owns every task and decides which of them are allowed to run.
 *
 * Deliberately free of Electron imports: the main process wires it to IPC and
 * the JSON store, while `tools/dl.ts` wires it to a terminal. Both drive the
 * exact same engine.
 */

export interface EngineSettings {
  /**
   * Where intermediates go, when the volume allows it - see `workspace.ts`.
   * Supplied by the caller rather than read from Electron's paths here, because
   * `tools/dl.ts` and the engine tests drive this same manager under bare Node
   * and an `electron` import anywhere in this module's graph stops them dead.
   */
  tempDir?: string
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
  /** Keep a finished torrent connected to its swarm. */
  seedTorrents?: boolean
  /** Stop seeding at this ratio, or null to ignore ratio. */
  seedRatioLimit?: number | null
  /** Stop seeding after this many minutes, or null to ignore the clock. */
  seedTimeMinutes?: number | null
  /** Upload cap in bytes/sec, separate from `speedLimit`, or null for no cap. */
  uploadLimit?: number | null
  /** A cap that replaces `speedLimit` between two times of day. */
  scheduledLimit?: ScheduledLimit | null
}

/** Everything a runner needs from the manager, whatever kind of runner it is. */
export interface RunnerContext {
  limiter: RateLimiter
  maxConnections: number
  /**
   * How far the adaptive ramp may climb past `maxConnections`.
   *
   * This used to exist only on `TaskRunnerConfig`, which meant the composite
   * runners never saw it: `DashRunner` handed its children a config with no
   * ceiling, so `connectionTarget` collapsed to `maxConnections`, which was
   * also where the ramp started - and `ConnectionRamp` marks itself finished
   * the moment `current >= target`. Every YouTube video+audio download
   * therefore ran at a fixed four connections per stream and the "Adaptive
   * ceiling" setting did nothing at all for the downloads most likely to want
   * it. Carried here so every runner can pass it down.
   */
  connectionCeiling?: number
  minSplitSize: number
  retryLimit: number
  timeoutMs: number
  proxyUrl: string | null
  /**
   * Whether anything is currently displaying this task's diagnostics. Runners
   * that build an expensive panel - the torrent one - use it to skip the work
   * when nobody is looking. Absent means "assume not watched".
   */
  isWatched?(): boolean
  /** Undefined means "no shared workspace"; intermediates stay beside the file. */
  tempDir?: string
  checkDiskSpace?: boolean
  exponentialBackoff?: boolean
  /** Upload cap for the runners that can upload at all, in bytes/sec. */
  uploadLimit?: number | null
  /** Answers 401 challenges. One per task; see `engine/auth.ts`. */
  auth?: HttpAuthenticator
  onUpdate(task: DownloadTask): void
  onFinished(task: DownloadTask, error: Error | null): void
  /**
   * Offered a finished torrent's live swarm connection. Present only when the
   * caller wants seeding; a runner that finds it missing tears its client down
   * as it always did.
   */
  onSeed?(task: DownloadTask, session: SeedSession): void
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
  /** Commit an irreversible finalization stage before launching captions or a scanner. */
  onFinalizationStage?(): Promise<void>
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
  /**
   * The password for a challenged request, or null when none is saved.
   *
   * Injected rather than imported: the store it comes from is sealed with
   * Electron's `safeStorage`, and an Electron import anywhere in this module's
   * graph stops `tools/dl.ts` and the engine tests dead.
   */
  resolveCredentials?: (url: string, realm: string) => Credentials | null
  /**
   * A queue's own speed cap, in bytes/sec, or null when it has none.
   *
   * Injected because queues belong to the scheduler: the manager decides what
   * runs, and asking it to own the queue list as well would give the same fact
   * two homes.
   */
  queueSpeedLimit?: (queueId: string) => number | null
  queuePolicy?: (queueId: string) => { running: boolean; maxConcurrent: number; taskIds: string[] } | undefined
}

/** How often speed, ETA and segment snapshots are recomputed and published. */
const TICK_MS = 250

/**
 * How long a task counts as "being watched" after something asked for its
 * diagnostics. Comfortably longer than the details dialog's own poll interval,
 * so a dropped frame does not make the panel go stale mid-view.
 */
const WATCH_TTL_MS = 3_000

/** The list-facing view of a task. See `TaskProgress` for what is left out. */
function progressOf(task: DownloadTask): TaskProgress {
  return {
    id: task.id,
    received: task.received,
    size: task.size,
    speed: task.speed,
    eta: task.eta,
    status: task.status,
    error: task.error,
    detail: task.detail
  }
}

export class DownloadManager {
  private tasks = new Map<string, DownloadTask>()
  private runners = new Map<string, Runner>()
  /** Removal owns a task through teardown and every asynchronous file deletion. */
  private removals = new Map<string, Promise<void>>()
  private pauseCounts = new Map<string, number>()
  private startsAfterPause = new Map<string, boolean>()
  private limiter = new RateLimiter(null)
  private ticker: NodeJS.Timeout | null = null
  private disposed = false
  private lastQuotaSnapshotAt = 0
  private lastQuotaUsed = -1
  /** When the time-of-day limit was last re-checked; see `ensureTicker`. */
  private lastLimitCheckAt = 0
  /** Tasks stopped by the transfer quota, to be started again by `quotaTimer`. */
  private quotaHeld = new Set<string>()
  /**
   * Finished torrents still giving back, held apart from `runners` on purpose:
   * a seed is not a download. It must not occupy a concurrency slot, must not
   * delay the next queued task, and outlives the runner that produced it.
   */
  private seeders = new Map<string, { session: SeedSession; startedAt: number }>()
  private seedStops = new Map<string, Promise<void>>()
  /**
   * One limiter per capped queue, shared by every task in it.
   *
   * Per task would be no cap at all: four downloads in a queue limited to
   * 200 KB/s would move 800. Each spends through the app-wide limiter, so a
   * queue cap can only ever be *narrower* than the global one.
   */
  private queueLimiters = new Map<string, RateLimiter>()
  /**
   * Tasks whose diagnostics something asked for, and when. Bounded by the TTL
   * sweep in `tick`, so a dialog that was closed without saying so ages out.
   */
  private watched = new Map<string, number>()
  private quotaTimer: NodeJS.Timeout | null = null
  private catTimer: NodeJS.Timeout | null = null
  /** The one-shot timers that end each cat-mode burst, so `dispose` can too. */
  private catStopTimers = new Set<NodeJS.Timeout>()
  private finalizationControllers = new Map<string, AbortController>()
  /** Caption/scanner work remains active after a transfer releases its slot. */
  private finalizations = new Map<string, Promise<void>>()
  private finalizationPool = new FinalizationPool(FINALIZATION_CONCURRENCY)

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
    const tempDir = this.options.getSettings().tempDir
    for (const task of tasks) task.dir = normalizeDownloadDirectory(task.dir)
    const ambiguous = await migrateLegacyIntermediates(tasks, tempDir)

    await mapConcurrent(tasks, RECOVERY_CONCURRENCY, async (task) => {
      const interruptedFinalization = task.status === 'processing' || task.status === 'scanning'
      if (task.status === 'processing' || task.status === 'scanning') task.finalizationStage = task.status
      if (ambiguous.has(task.id)) task.detail = 'Older partial data has more than one possible owner; it was preserved for manual recovery.'
      // Seeding does not survive the process that was doing it, so a restored
      // row must not go on claiming a ratio nothing is updating.
      if (isSeedingDetail(task.detail)) task.detail = null
      if (task.status === 'downloading' || task.status === 'probing' || task.status === 'queued') {
        task.status = 'paused'
        task.speed = 0
        task.eta = null
      }
      if (interruptedFinalization) {
        const file = await stat(join(task.dir, task.filename)).catch(() => null)
        task.status = 'error'
        task.manualPause = true
        task.completedAt = null
        task.speed = 0
        task.eta = null
        task.error = file?.isFile()
          ? 'Final checks were interrupted. The downloaded file is still on disk; inspect it before opening or retrying.'
          : 'Final checks were interrupted and the downloaded file could not be found.'
        task.detail = null
      }

      // Every unfinished task, not only the ones caught mid-flight: a task that
      // was already written as paused can still have a journal ahead of what
      // tasks.json recorded, because the kill that stranded it may have come
      // several restarts ago.
      if (task.status !== 'done' && !task.finalizationStage) await reconcileWithJournal(task, tempDir)
    })

    // Reconciliation is parallel, but insertion remains deterministic so the
    // persisted order is also the order restored into the UI.
    for (const task of tasks) {
      this.tasks.set(task.id, task)
    }
    this.emitTasks()

    // Legacy filename-based files are deliberately retained until ownership
    // can be established; a background sweep must not erase ambiguous data.
  }

  dispose(abortFinalization = true): void {
    this.disposed = true
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    if (this.quotaTimer) clearTimeout(this.quotaTimer)
    this.quotaTimer = null
    if (this.catTimer) clearInterval(this.catTimer)
    this.catTimer = null
    for (const timer of this.catStopTimers) clearTimeout(timer)
    this.catStopTimers.clear()
    if (abortFinalization) {
      for (const controller of this.finalizationControllers.values()) controller.abort()
      this.finalizationControllers.clear()
    }
  }

  /** Pauses everything and waits for the journals to land. Used on quit. */
  async shutdown(): Promise<void> {
    this.dispose(false)
    this.finalizationPool.cancelPending()
    this.stopSeeding([...this.seeders.keys()])
    const pauses = [...this.runners.values()].map((runner) => Promise.resolve().then(() => runner.pause()))
    const results = await Promise.allSettled([...pauses, ...this.finalizations.values()])
    this.stopSeeding([...this.seeders.keys()])
    results.push(...await Promise.allSettled(this.seedStops.values()))
    this.options.onQuotaState?.(this.limiter.quotaState)
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result) => result.reason), 'Could not pause every download before quitting')
    }
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

  /**
   * The heavy diagnostics for one task, on request.
   *
   * These used to ride the 4 Hz progress feed for every task at once, which
   * meant every open window paid to deserialise a torrent's whole file and peer
   * list four times a second so that a dialog nobody had opened could have had
   * it. Asking marks the task as watched, which is also what tells the torrent
   * runner to keep the panel fresh - see `TorrentRunner.tick`.
   */
  detail(id: string): TaskLiveDetail | null {
    const task = this.tasks.get(id)
    if (!task) return null

    this.watched.set(id, Date.now())
    return { id, segments: task.segments, torrentInfo: task.torrentInfo }
  }

  /**
   * Whether anything asked for this task's diagnostics recently.
   *
   * Two ticks of grace beyond the dialog's own poll interval, so a slow frame
   * cannot make the panel flicker between fresh and stale.
   */
  isWatched(id: string, now = Date.now()): boolean {
    const at = this.watched.get(id)
    if (at === undefined) return false
    if (now - at > WATCH_TTL_MS) {
      this.watched.delete(id)
      return false
    }
    return true
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
    if (this.disposed) return
    log.info(`Start requested for ${ids.length} tasks`)
    for (const id of ids) {
      const task = this.tasks.get(id)
      if (!task) continue
      if (this.removals.has(id)) continue
      if (this.pauseCounts.has(id)) {
        this.startsAfterPause.set(id, preserveQueueRetry)
        continue
      }
      if (task.status === 'downloading' || task.status === 'probing') continue
      if (task.status === 'done' || task.status === 'processing' || task.status === 'scanning') continue

      if (task.finalizationStage) {
        if (this.finalizations.has(id)) continue
        const retryStage = task.finalizationStage
        task.manualPause = false
        task.error = null
        task.status = 'done'
        this.trackFinalization(id, this.onFinished(null, task, null, retryStage))
        continue
      }

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
    const uniqueIds = [...new Set(ids)]
    for (const id of uniqueIds) {
      this.startsAfterPause.delete(id)
      this.pauseCounts.set(id, (this.pauseCounts.get(id) ?? 0) + 1)
    }
    let succeeded = false
    try {
      await this.pauseTasks(uniqueIds, byUser)
      succeeded = true
    } finally {
      for (const id of uniqueIds) {
        const count = (this.pauseCounts.get(id) ?? 1) - 1
        if (count > 0) { this.pauseCounts.set(id, count); continue }
        this.pauseCounts.delete(id)
        const pendingStart = this.startsAfterPause.get(id)
        this.startsAfterPause.delete(id)
        if (succeeded && pendingStart !== undefined && !this.removals.has(id)) this.start([id], pendingStart)
      }
      this.schedule()
    }
  }

  private async pauseTasks(ids: string[], byUser: boolean): Promise<void> {
    log.info(`Pause requested for ${ids.length} tasks`)
    const waits: Promise<void>[] = []
    // Stop is stop. A finished torrent that keeps uploading after the user
    // pressed it would be the app ignoring the one control it offers.
    this.stopSeeding(ids)

    /*
     * Two passes, because a runner's `pause` may reach `onFinished` - and so
     * `schedule()` - before it returns. `TorrentRunner` does exactly that, with
     * nothing to await first. Demoting every queued task in this batch up front
     * means such a re-entrant schedule can find nothing here left to launch;
     * one interleaved otherwise started a task that was in the middle of being
     * stopped, only to be stopped again a line later.
     */
    for (const id of ids) {
      const task = this.tasks.get(id)
      if (!task) continue
      // An explicit pause outranks the quota hold; the timer must not undo it.
      this.quotaHeld.delete(id)
      if (byUser) task.manualPause = true
      this.finalizationControllers.get(id)?.abort()
      if (!this.runners.has(id) && task.status === 'queued') task.status = 'paused'
    }

    for (const id of ids) {
      const runner = this.runners.get(id)
      if (runner) waits.push(Promise.resolve().then(() => runner.pause()))
      const finalization = this.finalizations.get(id)
      if (finalization) waits.push(finalization)
    }

    const results = await Promise.allSettled(waits)
    // A completing runner can hand over its seed while pause is in flight.
    this.stopSeeding(ids)
    results.push(...await Promise.allSettled(ids.map((id) => this.seedStops.get(id) ?? Promise.resolve())))
    this.emitTasks()
    this.schedule()
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result) => result.reason), 'Could not pause every selected download')
    }
  }

  async pauseAll(byUser = false): Promise<void> {
    await this.pause([...this.tasks.keys()], byUser)
  }

  async remove(ids: string[], deleteFiles: boolean): Promise<void> {
    const uniqueIds = [...new Set(ids)]
    const pending = uniqueIds.map((id) => this.removals.get(id)).filter((work): work is Promise<void> => Boolean(work))
    const fresh = uniqueIds.filter((id) => !this.removals.has(id))
    if (fresh.length > 0) {
      // Register before entering pause, whose completion can re-enter schedule.
      const work = Promise.resolve().then(() => this.removeTasks(fresh, deleteFiles))
      for (const id of fresh) this.removals.set(id, work)
      pending.push(work.finally(() => {
        for (const id of fresh) if (this.removals.get(id) === work) this.removals.delete(id)
        this.schedule()
      }))
    }
    const results = await Promise.allSettled(pending)
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  private async removeTasks(ids: string[], deleteFiles: boolean): Promise<void> {
    const finalizing = new Set(ids.filter((id) => this.finalizations.has(id)))
    await this.pause(ids)
    const tempDir = this.options.getSettings().tempDir

    for (const id of ids) {
      const task = this.tasks.get(id)
      if (!task) continue

      // Every intermediate this task can own, in the workspace *and* beside the
      // destination. Enumerated in one place so this can never again delete
      // from a directory the runner was not writing to - which used to strand
      // multi-gigabyte part files in the temp directory forever.
      const { files, dirs } = intermediatePathsFor(task, tempDir)
      for (const file of files) await rm(file, { force: true }).catch(() => {})
      for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {})

      if (deleteFiles && (task.status === 'done' || task.kind === 'torrent' || finalizing.has(id) || task.finalizationStage)) {
        if (task.kind === 'torrent') {
          const paths = (task.torrentInfo?.files ?? task.torrentFiles ?? []).map((file) => file.path)
          const selected = task.selectedFiles ? new Set(task.selectedFiles) : null
          const emptyCandidates = new Set<string>()
          const root = resolve(task.dir)
          for (const path of paths) {
            if (selected && !selected.has(path)) continue
            const target = resolveTorrentItemPath(root, path, paths)
            if (!target) continue
            // The torrent root can contain the user's own files. Delete only
            // listed payloads and let non-recursive rmdir preserve bystanders.
            await rm(target, { force: true }).catch(() => {})
            for (let parent = dirname(target); relative(root, parent); parent = dirname(parent)) emptyCandidates.add(parent)
          }
          for (const dir of [...emptyCandidates].sort((a, b) => b.length - a.length)) {
            await rmdir(dir).catch(() => {})
          }
        } else {
          await rm(join(task.dir, task.filename), { force: true }).catch(() => {})
        }
        for (const name of task.subtitleFiles ?? []) {
          if (name) await rm(join(task.dir, name), { force: true }).catch(() => {})
        }
      }

      this.tasks.delete(id)
      this.runners.delete(id)
      this.quotaHeld.delete(id)
      this.watched.delete(id)
      this.stopSeeding([id])
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

    const ordered = [...this.tasks.values()]
    const queueIds = new Set(ordered.map((task) => task.queueId).filter((id): id is string => Boolean(id)))
    for (const id of queueIds) {
      const policy = this.options.queuePolicy?.(id)
      if (!policy) continue
      const ranks = new Map(policy.taskIds.map((taskId, index) => [taskId, index]))
      const members = ordered.filter((task) => task.queueId === id)
        .sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity))
      let index = 0
      for (let slot = 0; slot < ordered.length; slot++) {
        if (ordered[slot].queueId === id) ordered[slot] = members[index++]
      }
    }
    for (const task of ordered) {
      if (this.activeCount >= maxConcurrentTasks) break
      if (task.status !== 'queued') continue
      if (this.removals.has(task.id) || this.pauseCounts.has(task.id)) continue
      if (this.runners.has(task.id)) continue
      if (task.queueId && this.options.queuePolicy) {
        const policy = this.options.queuePolicy(task.queueId)
        if (!policy?.running) continue
        const active = [...this.runners.values()].filter((runner) => runner.task.queueId === task.queueId).length
        if (active >= policy.maxConcurrent) continue
      }
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
      limiter: this.limiterFor(task),
      maxConnections: effectiveConnections,
      connectionCeiling,
      minSplitSize: settings.minSplitSize,
      retryLimit: settings.retryLimit,
      timeoutMs: settings.timeoutMs,
      proxyUrl: settings.proxyUrl,
      tempDir: settings.tempDir,
      checkDiskSpace: settings.checkDiskSpace,
      exponentialBackoff: settings.exponentialBackoff,
      uploadLimit: settings.uploadLimit ?? null,
      isWatched: () => this.isWatched(task.id),
      // One authenticator per launch, so the probe and every connection of this
      // download share what the first 401 taught them, and a restarted task
      // starts over rather than reusing a nonce the server has since retired.
      auth: this.authenticatorFor(),
      onUpdate: () => this.emitTasks(),
      // Opt-in, not opt-out: a caller that never mentions seeding - `tools/dl.ts`
      // driving the engine from a terminal - gets the old behaviour, where the
      // client is torn down the moment the download finishes.
      ...(settings.seedTorrents === true
        ? { onSeed: (seeded, session) => this.adoptSeed(seeded, session) }
        : {}),
      onFinished: (finished, error) => {
        const r = this.runners.get(task.id)
        if (r) this.trackFinalization(task.id, this.onFinished(r, finished, error))
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
          tempDir: settings.tempDir,
          checkDiskSpace: settings.checkDiskSpace,
          exponentialBackoff: settings.exponentialBackoff
        },
        {
          limiter: context.limiter,
          auth: context.auth,
          onUpdate: context.onUpdate,
          onFinished: context.onFinished,
          onProbed: context.onProbed,
          // A YouTube task with no separate audio stream - a progressive format
          // or an audio-only pick - lands here rather than on the DASH runner.
          // Without this it could neither resolve a restored watch page nor
          // refresh a signed URL that expired mid-transfer, and simply failed.
          refreshYouTube: context.refreshYouTube
        }
      )
    }

    this.runners.set(task.id, runner)
    log.info(`Launching task ${task.id} (${task.filename})`)
    void runner.start()
  }

  /**
   * The limiter a task should spend through: its queue's, when that queue is
   * capped, otherwise the app's.
   */
  private limiterFor(task: DownloadTask): RateLimiter {
    const queueId = task.queueId
    if (!queueId) return this.limiter

    const limit = this.options.queueSpeedLimit?.(queueId) ?? null
    const existing = this.queueLimiters.get(queueId)
    if (existing) {
      existing.setLimit(limit)
      return existing
    }

    const limiter = new RateLimiter(limit, this.limiter)
    this.queueLimiters.set(queueId, limiter)
    return limiter
  }

  private applyNetworkSettings(): void {
    const settings = this.options.getSettings()
    // The scheduled cap replaces the ordinary one while its window is open, so
    // this is recomputed rather than read - see `limit-window.ts`.
    this.limiter.setLimit(effectiveSpeedLimit(settings))
    this.limiter.setQuota(settings.quotaBytes, settings.quotaWindowMinutes * 60_000)
    setProxyUrl(settings.proxyUrl)
    const maxPerTask = Math.max(settings.maxConnectionsPerTask, settings.adaptiveConnectionCeiling ?? 0)
    setPoolConnections(settings.maxConcurrentTasks * maxPerTask)

    // A seed is running with the cap it was handed when it started, so a change
    // made in Options has to be pushed at the sessions already in flight.
    const uploadLimit = settings.uploadLimit ?? null
    for (const seed of this.seeders.values()) seed.session.applyUploadLimit(uploadLimit)

    // A queue whose cap was edited - or removed - while its tasks are running.
    for (const [queueId, limiter] of this.queueLimiters) {
      const limit = this.options.queueSpeedLimit?.(queueId) ?? null
      limiter.setLimit(limit)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Seeding                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * A fresh authenticator, or undefined when the app wired up no credential
   * store at all - `tools/dl.ts`, which has no keychain to ask.
   */
  private authenticatorFor(): HttpAuthenticator | undefined {
    const resolve = this.options.resolveCredentials
    return resolve ? new HttpAuthenticator(resolve) : undefined
  }

  private seedTargets(): SeedTargets {
    const settings = this.options.getSettings()
    return {
      ratioLimit: settings.seedRatioLimit ?? null,
      minutes: settings.seedTimeMinutes ?? null
    }
  }

  /** Takes ownership of a finished torrent's swarm connection. */
  private adoptSeed(task: DownloadTask, session: SeedSession): void {
    // Two seeds for one task would mean two clients on the same files. The
    // older one is the stale one, so it goes.
    this.stopSeeding([task.id])
    this.seeders.set(task.id, { session, startedAt: Date.now() })
    session.applyUploadLimit(this.options.getSettings().uploadLimit ?? null)
    log.info(`seeding ${task.filename}`)
    this.ensureTicker()
  }

  /**
   * Stops seeding whatever of these tasks is seeding, and says whether anything
   * was. Called by the user's Stop, by pause, by remove, and by shutdown - a
   * seed must never outlive the row it belongs to.
   */
  stopSeeding(ids: string[]): boolean {
    let stopped = false
    for (const id of ids) {
      const seed = this.seeders.get(id)
      if (!seed) continue
      this.seeders.delete(id)
      const previous = this.seedStops.get(id)
      const stopping = Promise.resolve().then(() => seed.session.stop())
      const work = Promise.all([previous, stopping]).then(() => {})
      this.seedStops.set(id, work)
      void work.then(() => {
        if (this.seedStops.get(id) === work) this.seedStops.delete(id)
      }, (error) => {
        // Retain the failed teardown so removal/shutdown cannot silently erase
        // a row or its files while the client might still own them.
        log.error(`Could not close torrent seed ${id}: ${error instanceof Error ? error.message : String(error)}`)
      })
      stopped = true

      const task = this.tasks.get(id)
      if (task && task.status === 'done') {
        task.detail = null
        task.speed = 0
      }
    }
    if (stopped) this.emitTasks()
    return stopped
  }

  /** Which tasks are seeding right now, for the UI and for the context menu. */
  seedingIds(): string[] {
    return [...this.seeders.keys()]
  }

  /**
   * Changes which files inside a torrent are wanted.
   *
   * A running torrent is told directly, so the change takes effect on the next
   * piece rather than at the next restart. A stopped one only records the
   * choice; its size is recomputed from the metadata Draco already has, so the
   * row reads correctly before it is ever started again.
   *
   * An empty selection is refused rather than obeyed: it would leave a torrent
   * that can never complete, and "none" is what Remove is for.
   */
  setTorrentFiles(id: string, paths: string[]): boolean {
    const task = this.tasks.get(id)
    if (!task || task.kind !== 'torrent') return false

    const known = task.torrentInfo?.files.map((file) => file.path)
      ?? task.torrentFiles?.map((file) => file.path)
      ?? []
    const wanted = [...new Set(paths.filter((path) => known.includes(path)))]
    if (wanted.length === 0) return false

    const selected: string[] | undefined = wanted.length === known.length ? undefined : wanted

    const runner = this.runners.get(id)
    if (runner instanceof TorrentRunner) {
      runner.setSelectedFiles(selected)
    } else {
      task.selectedFiles = selected
      const sizes = new Map(
        (task.torrentInfo?.files ?? task.torrentFiles ?? []).map((file) => [file.path, file.size])
      )
      task.size = wanted.reduce((total, path) => total + (sizes.get(path) ?? 0), 0) || task.size
      if (task.torrentInfo) {
        const chosen = new Set(wanted)
        task.torrentInfo = {
          ...task.torrentInfo,
          files: task.torrentInfo.files.map((file) => ({ ...file, selected: chosen.has(file.path) }))
        }
        task.received = task.torrentInfo.files
          .filter((file) => chosen.has(file.path))
          .reduce((total, file) => total + file.downloaded, 0)
      }
    }

    this.emitTasks()
    return true
  }

  /**
   * One pass over the live seeds: refresh what the UI shows, and stop the ones
   * that have met their target. Returns the progress rows to publish.
   */
  private tickSeeders(now: number): TaskProgress[] {
    if (this.seeders.size === 0) return []

    const targets = this.seedTargets()
    const updates: TaskProgress[] = []
    const finished: string[] = []

    for (const [id, seed] of this.seeders) {
      const task = this.tasks.get(id)
      if (!task) {
        // The row went away without going through `remove` - stop regardless,
        // rather than seeding something the user can no longer see.
        finished.push(id)
        continue
      }

      const progress = seed.session.progress()
      // The panel this refreshes is only drawn by the details dialog, and
      // rebuilding a whole file and peer list for a seed nobody has open is the
      // same waste the running case used to pay - see `TorrentRunner.tick`.
      if (this.isWatched(id, now)) seed.session.refreshInfo()

      if (seedTargetReached({ ...progress, startedAt: seed.startedAt }, targets, now)) {
        log.info(`seed target reached for ${task.filename} at ratio ${progress.ratio.toFixed(2)}`)
        finished.push(id)
        task.detail = null
        task.speed = 0
        continue
      }

      // Speed here is the upload rate: the row is finished downloading, so the
      // only number still moving is what it is giving back.
      task.speed = progress.uploadSpeed
      task.detail = describeSeeding({ ...progress, startedAt: seed.startedAt }, targets)
      updates.push(progressOf(task))
    }

    if (finished.length > 0) {
      this.stopSeeding(finished)
    }

    return updates
  }

  private trackFinalization(id: string, work: Promise<void>): void {
    this.finalizations.set(id, work)
    void work.catch((error) => {
      log.error(`Task ${id} finalization failed`, error)
    }).finally(() => {
      if (this.finalizations.get(id) === work) this.finalizations.delete(id)
    })
  }

  private async commitFinalizationStage(task: DownloadTask): Promise<boolean> {
    this.emitTasks()
    try {
      await this.options.onFinalizationStage?.()
      return true
    } catch (error) {
      task.status = 'error'
      task.manualPause = true
      task.completedAt = null
      task.error = `Could not save the finalization stage: ${error instanceof Error ? error.message : String(error)}`
      task.detail = null
      this.emitTasks()
      this.schedule()
      return false
    }
  }

  private async onFinished(
    runner: Runner | null,
    task: DownloadTask,
    error: Error | null,
    retryStage: 'processing' | 'scanning' | null = null
  ): Promise<void> {
    task.isCatMode = false
    if (runner && this.runners.get(task.id) === runner) {
      this.runners.delete(task.id)
    }

    const settings = this.options.getSettings()
    const transferComplete = !error && task.status === 'done'
    const saveSubtitles = transferComplete && retryStage !== 'scanning' && (task.subtitles?.length ?? 0) > 0
    const scan = transferComplete && (Boolean(settings.antivirusProgram) || retryStage === 'scanning')
    if (saveSubtitles || scan) {
      const controller = new AbortController()
      this.finalizationControllers.set(task.id, controller)
      task.status = saveSubtitles ? 'processing' : 'scanning'
      task.finalizationStage = task.status
      task.completedAt = null
      task.detail = saveSubtitles ? 'Saving subtitles…' : 'Scanning completed file…'
      if (!await this.commitFinalizationStage(task)) {
        this.finalizationControllers.delete(task.id)
        return
      }
      if (this.disposed) controller.abort()
      if (this.finalizationPool.saturated && !controller.signal.aborted) {
        task.detail = 'Waiting for final checks…'
        this.emitTasks()
      }
      const releaseFinalization = await this.finalizationPool.acquire(controller.signal)
      if (this.disposed && releaseFinalization) controller.abort()
      let finalizationError: string | null = releaseFinalization && !controller.signal.aborted
        ? null
        : 'Final checks were interrupted before they could start; the downloaded file remains on disk.'
      try {
        if (releaseFinalization && task.detail === 'Waiting for final checks…') {
          task.detail = saveSubtitles ? 'Saving subtitles…' : 'Scanning completed file…'
          this.emitTasks()
        }
        if (!finalizationError) {
          const file = await stat(join(task.dir, task.filename)).catch(() => null)
          if (!file?.isFile()) finalizationError = 'The completed media file is missing. Final checks cannot be retried; inspect the destination.'
        }

        if (saveSubtitles && !finalizationError) {
          try {
            const result = await downloadSubtitles(task, this.limiter, settings.timeoutMs, controller.signal, {
              ownedNames: task.subtitleFiles,
              ownedDigests: task.subtitleDigests,
              onReserved: async (index, name, digest) => {
                task.subtitleFiles ??= []
                task.subtitleDigests ??= []
                task.subtitleFiles[index] = name
                task.subtitleDigests[index] = digest
                this.emitTasks()
                await this.options.onFinalizationStage?.()
              },
              onVerified: async (index, digest) => {
                task.subtitleDigests ??= []
                task.subtitleDigests[index] = digest
                this.emitTasks()
                await this.options.onFinalizationStage?.()
              }
            })
            if (controller.signal.aborted) {
              finalizationError = 'Subtitle saving was interrupted; the downloaded file remains on disk.'
            } else if (result.warnings.length > 0) {
              finalizationError = `${result.warnings.length} subtitle track(s) failed: ${result.warnings.join('; ')}. The downloaded file remains on disk.`
              log.warn(result.warnings.join('; '))
            }
          } catch (subtitleError) {
            finalizationError = `Subtitle saving failed: ${subtitleError instanceof Error ? subtitleError.message : String(subtitleError)}`
          }
        }

        if (scan && !finalizationError && !controller.signal.aborted) {
          if (saveSubtitles) {
            task.status = 'scanning'
            task.finalizationStage = 'scanning'
            task.detail = 'Scanning completed file…'
            if (!await this.commitFinalizationStage(task)) return
          }
          if (!settings.antivirusProgram) {
            finalizationError = 'The configured security scanner is no longer available; choose one before retrying final checks.'
          } else if (controller.signal.aborted) {
            finalizationError = 'Security scan was interrupted; the downloaded file remains on disk but has not been verified.'
          } else try {
            await scanFile(
              settings.antivirusProgram, settings.antivirusArgs,
              join(task.dir, task.filename), settings.antivirusTimeoutSeconds * 1000,
              controller.signal
            )
          } catch (scanError) {
            if (controller.signal.aborted) {
              finalizationError = 'Security scan was interrupted; the downloaded file remains on disk but has not been verified.'
            } else {
              // A non-zero scanner exit may be a detection. Keep the bytes under
              // a quarantine name, but never announce the task as complete.
              const reason = scanError instanceof Error ? scanError.message : String(scanError)
              let scanFailure = `Security scan failed: ${reason}`
              try {
                const quarantined = await uniquePath(task.dir, task.filename + '.quarantine')
                const moved = await rename(join(task.dir, task.filename), quarantined)
                  .then(() => true).catch(async () => {
                    await discardReservedPath(quarantined)
                    return false
                  })
                if (moved) scanFailure += `. The file was quarantined as ${basename(quarantined)}`
                else scanFailure += '. The file could not be quarantined; inspect the destination'
              } catch (quarantineError) {
                scanFailure += `. Could not quarantine the file: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`
              }
              finalizationError = finalizationError ? `${finalizationError} ${scanFailure}` : scanFailure
            }
          }
        }

      } catch (unexpected) {
        finalizationError = `Final checks failed: ${unexpected instanceof Error ? unexpected.message : String(unexpected)}`
      } finally {
        releaseFinalization?.()
        this.finalizationControllers.delete(task.id)
      }
      if (controller.signal.aborted && !finalizationError) {
        finalizationError = 'Final checks were interrupted; the downloaded file remains on disk.'
      }

      if (finalizationError) {
        task.status = 'error'
        task.manualPause = true
        task.error = finalizationError
        task.detail = null
        task.completedAt = null
        log.warn(`${task.filename}: ${finalizationError}`)
      } else {
        task.status = 'done'
        task.finalizationStage = null
        task.error = null
        task.detail = null
        task.completedAt = Date.now()
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

    if (error || task.status === 'error') {
      log.error(`Task ${task.id} (${task.filename}) failed`, error ?? new Error(task.error ?? 'Finalization failed'))
    } else if (task.status === 'done') {
      task.finalizationStage = null
      // The captured credentials have done their job. A finished row can sit
      // in the list for months, so a completed download must not keep carrying
      // live browser session cookies even in sealed task storage.
      forgetCredentials(task)
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
      !task.manualPause && !this.disposed && !this.removals.has(task.id) && !this.pauseCounts.has(task.id) &&
      runner && (await runner.resetForRestart())
    ) {
      if (task.manualPause || this.disposed || this.removals.has(task.id) || this.pauseCounts.has(task.id) || this.tasks.get(task.id) !== task) return
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

      const settings = this.options.getSettings()
      // A keep-alive burst is still a running download: it holds a connection,
      // spends the transfer budget and occupies a slot. Starting one on top of
      // a full complement would quietly exceed the limit the user set.
      if (this.activeCount >= settings.maxConcurrentTasks) return

      // A queue's waiting items must not download around its concurrency/order.
      // The MPD runner hands network I/O to ffmpeg, which cannot honor the
      // trickle limiter. Leave it queued for its normal start instead.
      const queuedTasks = [...this.tasks.values()].filter((t) =>
        !t.queueId && t.kind !== 'dash' && t.status === 'queued' && !this.runners.has(t.id))
      if (queuedTasks.length === 0) return

      // Round-robin: always pick the one that hasn't been pinged in the longest time.
      queuedTasks.sort((a, b) => (a.lastCatPingAt ?? 0) - (b.lastCatPingAt ?? 0))
      const task = queuedTasks[0]

      // Capped at ~100 KB/s of its own, but charged against the app-wide quota
      // through the shared limiter. A budget a background trickle can spend
      // without ever being counted is not a budget.
      const catLimiter = new RateLimiter(102400, this.limiter)

      const context: RunnerContext = {
        limiter: catLimiter,
        maxConnections: 1,
        connectionCeiling: 1,
        minSplitSize: settings.minSplitSize,
        retryLimit: settings.retryLimit,
        timeoutMs: settings.timeoutMs,
        proxyUrl: settings.proxyUrl,
        tempDir: settings.tempDir,
        // The trickle probes the real URL, so it can hit a 401 challenge.
        // Without an authenticator that probe fails with a terminal auth
        // error even when saved credentials would have answered it - a
        // background keep-alive must never be able to error a task.
        auth: this.authenticatorFor(),
        isWatched: () => this.isWatched(task.id),
        onUpdate: () => this.emitTasks(),
        onFinished: (finished, error) => {
          const r = this.runners.get(task.id)
          if (r) this.trackFinalization(task.id, this.onFinished(r, finished, error))
        },
        onProbed: (probed) => this.options.onProbed?.(probed),
        refreshYouTube: this.options.refreshYouTube
      }

      // Built before the task is marked running. Bailing out after the status
      // change left a task reading "downloading" with no runner behind it and
      // nothing that would ever move it again.
      let runner: Runner
      if (task.kind === 'hls') {
        const build = this.options.createHlsRunner
        if (!build) return
        runner = build(task, context)
      } else if (task.kind === 'dash') {
        const build = this.options.createMpdRunner
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
            tempDir: settings.tempDir,
            checkDiskSpace: settings.checkDiskSpace,
            exponentialBackoff: settings.exponentialBackoff
          },
          {
            limiter: context.limiter,
            auth: context.auth,
            onUpdate: context.onUpdate,
            onFinished: context.onFinished,
            onProbed: context.onProbed,
            refreshYouTube: context.refreshYouTube
          }
        )
      }

      task.lastCatPingAt = Date.now()
      task.isCatMode = true
      task.status = 'downloading'
      this.emitTasks()
      log.info(`Cat mode started for queued task ${task.id} (${task.filename})`)

      this.runners.set(task.id, runner)
      void runner.start()

      // Stop it after 5 to 10 seconds
      const durationMs = 5000 + Math.random() * 5000
      const stopTimer = setTimeout(() => {
        this.catStopTimers.delete(stopTimer)
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
      stopTimer.unref?.()
      this.catStopTimers.add(stopTimer)
    }, 30_000)
  }

  private ensureTicker(): void {
    if (this.ticker || this.disposed) return

    this.ticker = setInterval(() => {
      if (this.runners.size === 0 && this.seeders.size === 0) {
        // Nothing to report: stop the timer rather than waking the renderer
        // four times a second for an idle app.
        if (this.ticker) clearInterval(this.ticker)
        this.ticker = null
        return
      }

      const updates: TaskProgress[] = this.tickSeeders(Date.now())
      for (const runner of this.runners.values()) {
        runner.tick()
        updates.push(progressOf(runner.task))
      }

      if (updates.length > 0) this.options.onProgress(updates)
      const now = Date.now()

      // A dialog that was closed - or a window that went away - never says so.
      // The TTL is what stops `watched` growing for the life of the process.
      for (const [id, at] of this.watched) {
        if (now - at > WATCH_TTL_MS) this.watched.delete(id)
      }

      // A scheduled cap opens and closes with the clock, and a download running
      // across that moment has to feel it. Checked on a slow interval rather
      // than every tick: it is a comparison of minutes, not of milliseconds.
      if (now - this.lastLimitCheckAt >= 15_000) {
        this.lastLimitCheckAt = now
        this.applyNetworkSettings()
      }

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

  emitTasks(): void {
    this.options.onTasks(this.list())
  }
}

/**
 * tasks.json is written on a short coalesce, so a process that was killed
 * mid-download left it behind by however much landed in that interval - or,
 * after a hard kill, by a great deal more.
 *
 * The journal beside the part file is the record that is actually kept current,
 * so a restored task takes its progress from there. Without this the list shows
 * a download at 0.2% that is really at 20%, and only tells the truth once the
 * user presses Resume - which reads as data lost.
 */
async function reconcileWithJournal(task: DownloadTask, tempDir?: string): Promise<void> {
  if (task.kind === 'hls') {
    await reconcileHlsPieces(task, tempDir)
    return
  }

  if (task.audioUrl) {
    const safeV = task.youtube?.videoFormatId?.replace(/[^a-z0-9_-]/gi, '')
    const safeA = task.youtube?.audioFormatId?.replace(/[^a-z0-9_-]/gi, '')
    const vSuffix = safeV ? `.v.${safeV}.mp4` : '.v.mp4'
    const aSuffix = safeA ? `.a.${safeA}.m4a` : '.a.m4a'

    let vJournal = await readJournal(partPathFor(task.dir, task.filename + vSuffix, task.id + '-v', tempDir) + '.json')
    if (!vJournal && vSuffix !== '.v.mp4') {
      vJournal = await readJournal(partPathFor(task.dir, task.filename + '.v.mp4', task.id + '-v', tempDir) + '.json')
    }
    let aJournal = await readJournal(partPathFor(task.dir, task.filename + aSuffix, task.id + '-a', tempDir) + '.json')
    if (!aJournal && aSuffix !== '.a.m4a') {
      aJournal = await readJournal(partPathFor(task.dir, task.filename + '.a.m4a', task.id + '-a', tempDir) + '.json')
    }

    task.received = 0
    task.segments = []

    // A half that finished has no journal left - it was renamed to its own name
    // and its journal removed. Its size on disk is the progress it represents,
    // and without it a pair waiting only to be merged came back reading 0%.
    const vStat = (await stat(join(task.dir, task.filename + vSuffix)).catch(() => null)) ??
      (vSuffix !== '.v.mp4' ? await stat(join(task.dir, task.filename + '.v.mp4')).catch(() => null) : null)
    const vFinishedBytes = vStat?.isFile() ? vStat.size : 0

    const aStat = (await stat(join(task.dir, task.filename + aSuffix)).catch(() => null)) ??
      (aSuffix !== '.a.m4a' ? await stat(join(task.dir, task.filename + '.a.m4a')).catch(() => null) : null)
    const aFinishedBytes = aStat?.isFile() ? aStat.size : 0

    task.received = vFinishedBytes + aFinishedBytes
    
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
    
    const vTotal = vJournal?.size ?? (vFinishedBytes > 0 ? vFinishedBytes : null)
    const aTotal = aJournal?.size ?? (aFinishedBytes > 0 ? aFinishedBytes : null)
    if (vTotal !== null && aTotal !== null) {
      task.size = vTotal + aTotal
    } else if (task.received > 0 && (task.size === null || task.size < task.received)) {
      // The recorded total predates the halves that are now complete.
      task.size = task.received
    }
    return
  }

  const journal = await readJournal(partPathFor(task.dir, task.filename, task.id, tempDir) + '.json')
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
async function reconcileHlsPieces(task: DownloadTask, tempDir?: string): Promise<void> {
  const dir = join(taskWorkspaceDir(task.dir, task.id, tempDir), task.filename + '.dracoparts')

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

/**
 * Drops the credentials a task captured from the browser.
 *
 * Called once a download is finished, which is the point they stop being
 * needed: a redownload re-probes and any resume would have happened long
 * before. The referer and user-agent stay - they are not secrets and some
 * origins still need them to serve the file at all.
 */
function forgetCredentials(task: DownloadTask): void {
  if (!task.headers) return
  delete task.headers.cookie
  delete task.headers.authorization
  if (task.headers.extra) {
    for (const key of Object.keys(task.headers.extra)) {
      if (/^(cookie|authorization|proxy-authorization|x-api-key)$/i.test(key)) {
        delete task.headers.extra[key]
      }
    }
  }
}
