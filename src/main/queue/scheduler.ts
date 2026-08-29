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
      taskIds: Array.isArray(queue.taskIds) ? [...new Set(queue.taskIds.filter((id): id is string => typeof id === 'string').map((id) => id.slice(0, 256)))] : [],
      days: Array.isArray(queue.days) ? [...new Set(queue.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [],
      mode: queue.mode === 'onetime' || queue.mode === 'periodic' ? queue.mode : 'manual',
      startTime: normalizeTime(queue.startTime),
      stopTime: normalizeTime(queue.stopTime),
      onComplete: queue.onComplete === 'exit' || queue.onComplete === 'sleep' || queue.onComplete === 'hibernate' || queue.onComplete === 'shutdown'
        ? queue.onComplete
        : 'none',
      running: queue.running === true,
      oneTimeCompleted: queue.oneTimeCompleted === true
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
    await this.persist()
  }

  async startQueue(id: string): Promise<void> {
    const queue = this.queues.find((q) => q.id === id)
    if (!queue) return
    if (this.pending?.queueId === id) this.cancelPending()
    queue.running = true
    // An explicit Start means "run this once more" for one-time queues.
    if (queue.mode === 'onetime') queue.oneTimeCompleted = false
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

      if (queue.running && !(queue.mode === 'onetime' && queue.oneTimeCompleted)) this.feed(queue)
    }

    this.deps.onQueues(this.queues)
  }

  /** Promotes this queue's tasks in order, up to its own concurrency limit. */
  private feed(queue: Queue): void {
    if (queue.mode === 'onetime' && queue.oneTimeCompleted) return

    const tasks = this.tasksOf(queue)
    const existingPending = this.pending?.queueId === queue.id
    const active = tasks.filter(
      (t) => t.status === 'downloading' || t.status === 'probing' || t.status === 'queued'
    ).length

    let room = queue.maxConcurrent - active
    const startable: string[] = []

    for (const task of tasks) {
      if (room <= 0) break
      if (task.status === 'paused' || task.status === 'error') {
        startable.push(task.id)
        room--
      }
    }

    if (startable.length > 0) this.deps.manager.start(startable)

    // Drained: everything in the queue reached a terminal state. A pending
    // action is cancelled automatically when the queue is no longer drained,
    // e.g. when the user resumes/adds work during the grace period.
    const finished = tasks.length > 0 && tasks.every((t) => t.status === 'done')
    if (!finished && existingPending) this.cancelPending()
    if (finished) {
      // A one-time queue is consumed once it drains, even when no completion
      // action is configured. Otherwise it would re-enter its time window forever.
      if (queue.mode === 'onetime') queue.oneTimeCompleted = true
      queue.running = false
      if (queue.onComplete !== 'none') this.scheduleAction(queue.id, queue.onComplete)
    }
  }

  private tasksOf(queue: Queue) {
    const all = this.deps.manager.list()
    // Honour the queue's own ordering, and fall back to membership by queueId so
    // a task added straight to a queue still runs.
    const ordered = queue.taskIds
      .map((id) => all.find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))

    for (const task of all) {
      if (task.queueId === queue.id && !ordered.includes(task)) ordered.push(task)
    }

    return ordered
  }

  private inWindow(queue: Queue, now: Date): boolean {
    return isInQueueWindow(queue, now)
  }

  /* ---------------------------------------------------------------- */
  /* Completion actions                                                */
  /* ---------------------------------------------------------------- */

  private scheduleAction(queueId: string, action: QueueCompletionAction): void {
    if (this.pending) return

    this.pending = { action, queueId, firesAt: Date.now() + ACTION_DELAY_MS }
    this.deps.onPending(this.pending)
    log.info(`scheduled ${action} in ${ACTION_DELAY_MS / 1000}s`)

    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const fired = this.pending
      this.pending = null
      this.deps.onPending(null)
      if (fired) runAction(fired.action, this.deps.onExitRequested)
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
function runAction(action: QueueCompletionAction, onExitRequested: () => void): void {
  switch (action) {
    case 'shutdown':
      spawn('shutdown', ['/s', '/t', '0'], { shell: false, detached: true }).unref()
      break
    case 'hibernate':
      spawn('shutdown', ['/h'], { shell: false, detached: true }).unref()
      break
    case 'sleep':
      // Windows has no first-class sleep command; this is the documented call.
      spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], {
        shell: false,
        detached: true
      }).unref()
      break
    case 'exit':
      onExitRequested()
      break
    default:
      break
  }
}
