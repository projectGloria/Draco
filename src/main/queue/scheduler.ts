import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { PendingAction, Queue, QueueCompletionAction } from '@shared/types'
import type { DownloadManager } from '../engine/manager.ts'
import { isInQueueWindow } from './scheduler-window.ts'
import { logger } from '../log.ts'

const log = logger('scheduler')

/**
 * IDM's queues: an ordered list of downloads that runs inside a time window and
 * can put the machine to sleep when it drains.
 *
 * The scheduler never downloads anything itself. It only decides which tasks are
 * allowed to be `queued`, and the download manager does the rest - so there is
 * exactly one place that starts work.
 */

/** How often queue windows are re-evaluated. */
const TICK_MS = 30_000

/** Grace period before a shutdown/sleep fires, so it can be called off. */
const ACTION_DELAY_MS = 60_000

export interface SchedulerDeps {
  manager: DownloadManager
  onQueues(queues: Queue[]): void
  saveQueues(queues: Queue[]): Promise<void>
  onPending(pending: PendingAction | null): void
  /** Asked for by the 'exit' completion action; the app owns how it quits. */
  onExitRequested(): void
}

export class Scheduler {
  private queues: Queue[] = []
  private timer: NodeJS.Timeout | null = null
  private pending: PendingAction | null = null
  private pendingTimer: NodeJS.Timeout | null = null
  /**
   * Queues that have drained and already had their completion action fired.
   *
   * Lifted again by `releaseDrainedWithWork` as soon as the queue has something
   * non-terminal in it, which is what "this queue has work again" means.
   */
  private drained = new Set<string>()
  private deps: SchedulerDeps

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  load(queues: Queue[]): void {
    this.queues = queues
  }

  list(): Queue[] {
    return this.queues
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /* ---------------------------------------------------------------- */
  /* Mutations                                                         */
  /* ---------------------------------------------------------------- */

  async save(queue: Queue): Promise<Queue> {
    const normalizeTime = (value: string | null): string | null => {
      if (typeof value !== 'string') return null
      const match = /^(\d{2}):(\d{2})$/.exec(value.trim())
      if (!match) return null
      const hour = Number(match[1])
      const minute = Number(match[2])
      return hour <= 23 && minute <= 59 ? `${match[1]}:${match[2]}` : null
    }
    const normalized: Queue = {
      ...queue,
      id: typeof queue.id === 'string' && queue.id ? queue.id.slice(0, 128) : randomUUID(),
      name: typeof queue.name === 'string' ? queue.name.trim().slice(0, 60) || 'Queue' : 'Queue',
      maxConcurrent: Math.min(20, Math.max(1, Math.round(Number(queue.maxConcurrent)) || 1)),
      retryLimit: Math.min(20, Math.max(0, Math.round(Number(queue.retryLimit)) || 0)),
      retryDelaySeconds: Math.min(86_400, Math.max(0, Math.round(Number(queue.retryDelaySeconds)) || 0)),
      taskIds: Array.isArray(queue.taskIds) ? [...new Set(queue.taskIds.filter((id): id is string => typeof id === 'string').map((id) => id.slice(0, 256)))] : [],
      days: Array.isArray(queue.days) ? [...new Set(queue.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [],
      mode: queue.mode === 'onetime' || queue.mode === 'periodic' ? queue.mode : 'manual',
      startTime: normalizeTime(queue.startTime),
      stopTime: normalizeTime(queue.stopTime),
      onComplete: queue.onComplete === 'run' || queue.onComplete === 'exit' || queue.onComplete === 'sleep' || queue.onComplete === 'hibernate' || queue.onComplete === 'shutdown'
        ? queue.onComplete
        : 'none',
      completionProgram: typeof queue.completionProgram === 'string' && queue.completionProgram.trim()
        ? queue.completionProgram.trim().slice(0, 1000)
        : null,
      completionArgs: Array.isArray(queue.completionArgs)
        ? queue.completionArgs.filter((arg): arg is string => typeof arg === 'string').slice(0, 20).map((arg) => arg.slice(0, 500))
        : [],
      running: queue.running === true,
      oneTimeCompleted: queue.oneTimeCompleted === true,
      lastResult: queue.lastResult === 'completed' || queue.lastResult === 'completed-with-errors'
        ? queue.lastResult
        : 'idle'
    }

    const index = this.queues.findIndex((q) => q.id === normalized.id)
    if (index >= 0) this.queues[index] = normalized
    else this.queues.push(normalized)

    await this.persist()
    this.tick()
    return normalized
  }

  async remove(id: string): Promise<void> {
    if (this.pending?.queueId === id) this.cancelPending()
    const queue = this.queues.find((q) => q.id === id)
    if (queue) {
      // Orphaned tasks would otherwise be invisible: they'd still carry a
      // queueId pointing at nothing and never be scheduled again.
      for (const task of this.deps.manager.list()) {
        if (task.queueId === id) task.queueId = null
      }
    }

    this.queues = this.queues.filter((q) => q.id !== id)
    this.drained.delete(id)
    await this.persist()
  }

  /** Keeps queue ordering in step when a task is moved from the main table. */
  async syncTaskQueue(taskId: string, previousQueueId: string | null, nextQueueId: string | null): Promise<void> {
    if (nextQueueId && !this.queues.some((queue) => queue.id === nextQueueId)) {
      throw new Error('That queue no longer exists')
    }
    for (const queue of this.queues) {
      if (queue.id === previousQueueId || queue.id !== nextQueueId) {
        queue.taskIds = queue.taskIds.filter((id) => id !== taskId)
      }
    }
    const target = this.queues.find((queue) => queue.id === nextQueueId)
    if (target && !target.taskIds.includes(taskId)) target.taskIds.push(taskId)
    await this.persist()
  }

  async startQueue(id: string): Promise<void> {
    const queue = this.queues.find((q) => q.id === id)
    if (!queue) return
    if (this.pending?.queueId === id) this.cancelPending()
    queue.running = true
    queue.lastResult = 'idle'
    // An explicit Start means "run this once more" for one-time queues.
    if (queue.mode === 'onetime') queue.oneTimeCompleted = false
    this.drained.delete(id)
    
    for (const task of this.tasksOf(queue)) {
      if (task.manualPause) task.manualPause = false
    }

    await this.persist()
    this.tick()
  }

  async stopQueue(id: string): Promise<void> {
    const queue = this.queues.find((q) => q.id === id)
    if (!queue) return
    if (this.pending?.queueId === id) this.cancelPending()
    queue.running = false
    await this.deps.manager.pause(this.tasksOf(queue).map((t) => t.id))
    await this.persist()
  }

  cancelPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = null
    this.pending = null
    this.deps.onPending(null)
  }

  /* ---------------------------------------------------------------- */
  /* The tick                                                          */
  /* ---------------------------------------------------------------- */

  private tick(): void {
    const before = this.fingerprint()
    this.synchronizeMembership()
    this.releaseDrainedWithWork()
    const now = new Date()

    for (const queue of this.queues) {
      if (queue.mode !== 'manual') {
        const shouldRun = this.inWindow(queue, now)
        if (shouldRun && !queue.running) {
          queue.running = true
          log.info(`queue "${queue.name}" entered its window`)
        } else if (!shouldRun && queue.running && queue.stopTime) {
          queue.running = false
          log.info(`queue "${queue.name}" left its window`)
          void this.deps.manager.pause(this.tasksOf(queue).map((t) => t.id))
        }
      }

      if (
        queue.running &&
        !(queue.mode === 'onetime' && queue.oneTimeCompleted) &&
        !this.drained.has(queue.id)
      ) this.feed(queue)
    }

    if (this.fingerprint() !== before) void this.persist()
    else this.deps.onQueues(this.queues)
  }

  /** Promotes this queue's tasks in order, up to its own concurrency limit. */
  private feed(queue: Queue): void {
    if (this.drained.has(queue.id)) return
    if (queue.mode === 'onetime' && queue.oneTimeCompleted) return

    const tasks = this.tasksOf(queue)
    const existingPending = this.pending?.queueId === queue.id
    const active = tasks.filter(
      (t) => t.status === 'downloading' || t.status === 'probing' || t.status === 'queued'
    ).length

    let room = queue.maxConcurrent - active
    const startable: string[] = []
    let retryMetadataChanged = false

    const now = Date.now()
    for (const task of tasks) {
      if (room <= 0) break
      if (task.status === 'paused') {
        // Someone pressed Stop on this row. The queue owns the order, not the
        // user's hand: starting it again here is what made an individual pause
        // impossible for anything inside a running queue.
        if (task.manualPause) continue
        startable.push(task.id)
        room--
      } else if (task.status === 'error' && task.queueRetryCount < queue.retryLimit) {
        if (task.nextQueueAttemptAt === null) {
          task.nextQueueAttemptAt = now + queue.retryDelaySeconds * 1000
          retryMetadataChanged = true
        }
        if (now >= task.nextQueueAttemptAt) {
          task.queueRetryCount++
          task.nextQueueAttemptAt = null
          retryMetadataChanged = true
          startable.push(task.id)
          room--
        }
      }
    }

    if (retryMetadataChanged) this.deps.manager.notifyTaskMetadataChanged()
    if (startable.length > 0) this.deps.manager.start(startable, true)

    // Drained: everything in the queue reached a terminal state. A pending
    // action is cancelled automatically when the queue is no longer drained,
    // e.g. when the user resumes/adds work during the grace period.
    const exhausted = (task: (typeof tasks)[number]): boolean =>
      task.status === 'error' && task.queueRetryCount >= queue.retryLimit
    const finished = tasks.length > 0 && tasks.every((t) => t.status === 'done' || exhausted(t))
    if (!finished && existingPending) this.cancelPending()
    if (finished) {
      // Latched for *every* mode, not just one-time. A periodic queue is still
      // inside its window a tick later, so it was set running again, fed again,
      // found drained again - and scheduled its completion action again, every
      // ninety seconds for the length of the window. With `run` configured that
      // re-launched the user's program on a loop.
      //
      // The latch is in-memory rather than persisted: a restart is a new day's
      // worth of work as far as a periodic queue is concerned, and
      // `oneTimeCompleted` already carries the part that must outlive the
      // process.
      this.drained.add(queue.id)
      if (queue.mode === 'onetime') queue.oneTimeCompleted = true
      queue.running = false
      queue.lastResult = tasks.some(exhausted) ? 'completed-with-errors' : 'completed'
      if (queue.onComplete !== 'none') this.scheduleAction(queue)
    }
  }

  private tasksOf(queue: Queue) {
    const all = this.deps.manager.list()
    // Indexed rather than scanned per id: this runs for every queue on every
    // tick, and a linear find inside the loop made it quadratic in the size of
    // the whole download list.
    const byId = new Map(all.map((task) => [task.id, task]))

    // Honour the queue's own ordering, and fall back to membership by queueId so
    // a task added straight to a queue still runs.
    const ordered = queue.taskIds
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))

    const seen = new Set(ordered)
    for (const task of all) {
      if (task.queueId === queue.id && !seen.has(task)) {
        ordered.push(task)
        seen.add(task)
      }
    }

    return ordered
  }

  private synchronizeMembership(): void {
    const tasks = this.deps.manager.list()
    const byId = new Map(tasks.map((task) => [task.id, task]))
    for (const queue of this.queues) {
      queue.taskIds = queue.taskIds.filter((id) => byId.get(id)?.queueId === queue.id)
      const members = new Set(queue.taskIds)
      for (const task of tasks) {
        if (task.queueId === queue.id && !members.has(task.id)) {
          queue.taskIds.push(task.id)
          members.add(task.id)
        }
      }
    }
  }

  /**
   * Drops the completion latch from any queue that has work again.
   *
   * "Work again" is anything not in a terminal state - a resumed task, a newly
   * added one, a retry that came back. Without this a queue that drained once
   * would never run again inside the same session.
   */
  private releaseDrainedWithWork(): void {
    if (this.drained.size === 0) return
    for (const queue of this.queues) {
      if (!this.drained.has(queue.id)) continue
      const hasWork = this.tasksOf(queue).some(
        (task) => task.status !== 'done' && task.status !== 'error' && task.status !== 'missing'
      )
      if (hasWork) this.drained.delete(queue.id)
    }
  }

  /**
   * A cheap change signal for the tick.
   *
   * `JSON.stringify` over every queue ran twice per tick and grew with the task
   * list; only these fields decide whether the file needs rewriting.
   */
  private fingerprint(): string {
    return this.queues
      .map((q) => `${q.id}:${q.running ? 1 : 0}:${q.oneTimeCompleted ? 1 : 0}:${q.lastResult}:${q.taskIds.length}:${q.taskIds.join(',')}`)
      .join('|')
  }

  private inWindow(queue: Queue, now: Date): boolean {
    return isInQueueWindow(queue, now)
  }

  /* ---------------------------------------------------------------- */
  /* Completion actions                                                */
  /* ---------------------------------------------------------------- */

  private scheduleAction(queue: Queue): void {
    if (this.pending) {
      // Only one machine-level action can be pending at a time. Say so rather
      // than dropping the second queue's action without a trace.
      log.warn(
        `queue "${queue.name}" wanted to ${queue.onComplete} but a ${this.pending.action} is already pending; skipped`
      )
      return
    }

    this.pending = { action: queue.onComplete, queueId: queue.id, firesAt: Date.now() + ACTION_DELAY_MS }
    this.deps.onPending(this.pending)
    log.info(`scheduled ${queue.onComplete} in ${ACTION_DELAY_MS / 1000}s`)

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const fired = this.pending
      this.pending = null
      this.deps.onPending(null)
      if (fired) runAction(fired.action, this.deps.onExitRequested, queue.completionProgram, queue.completionArgs)
    }, ACTION_DELAY_MS)
  }

  private async persist(): Promise<void> {
    await this.deps.saveQueues(this.queues)
    this.deps.onQueues(this.queues)
  }
}

/**
 * Every one of these spawns an argument array with shell:false. Building a
 * command string here would put a queue name one quote away from arbitrary
 * execution.
 */
function runAction(
  action: QueueCompletionAction,
  onExitRequested: () => void,
  completionProgram: string | null,
  completionArgs: string[]
): void {
  switch (action) {
    case 'run':
      if (completionProgram) {
        spawn(completionProgram, completionArgs, {
          shell: false,
          detached: true,
          windowsHide: true,
          stdio: 'ignore'
        }).unref()
      }
      break
    case 'shutdown':
      spawn('shutdown', ['/s', '/t', '0'], { shell: false, detached: true }).unref()
      break
    case 'hibernate':
      spawn('shutdown', ['/h'], { shell: false, detached: true }).unref()
      break
    case 'sleep':
      // Windows rundll32 powrprof.dll passes an HWND that SetSuspendState treats as
      // bHibernate=true, causing unwanted hibernation. Using PowerShell .NET
      // SetSuspendState correctly invokes Sleep/Suspend without hibernating.
      spawn('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)'
      ], {
        shell: false,
        detached: true,
        windowsHide: true
      }).unref()
      break
    case 'exit':
      onExitRequested()
      break
    default:
      break
  }
}
