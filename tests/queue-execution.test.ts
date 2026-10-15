import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { DownloadManager, type RunnerContext, type EngineSettings } from '../src/main/engine/manager.ts'
import { createTask } from '../src/main/engine/create.ts'
import { Scheduler } from '../src/main/queue/scheduler.ts'
import { sanitizeQueues } from '../src/main/store-sanitize.ts'
import { moveQueueItem, orderedQueueIds } from '../src/shared/queue-order.ts'
import type { DownloadTask, PendingAction } from '../src/shared/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function setup(maxConcurrent = 1, globalLimit = 10) {
  const settings: EngineSettings = {
    maxConcurrentTasks: globalLimit, maxConnectionsPerTask: 1, minSplitSize: 1024,
    retryLimit: 1, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
    hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
    antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 1
  }
  const launched: string[] = []
  const pendingEvents: Array<PendingAction | null> = []
  const contexts = new Map<string, RunnerContext>()
  let scheduler: Scheduler
  const manager = new DownloadManager({
    getSettings: () => settings, onTasks: () => {}, onProgress: () => {},
    queuePolicy: (id) => scheduler.list().find((queue) => queue.id === id),
    queueSpeedLimit: (id) => scheduler.list().find((queue) => queue.id === id)?.speedLimit ?? null,
    createHlsRunner: (task, context) => {
      contexts.set(task.id, context)
      return {
        task, running: false,
        async start() { this.running = true; task.status = 'downloading'; launched.push(task.id) },
        async pause() { this.running = false; task.status = 'paused'; context.onFinished(task, null) },
        tick() {}, async resetForRestart() { return false }
      }
    }
  })
  scheduler = new Scheduler({ manager, onQueues: () => {}, saveQueues: async () => {}, onPending: (value) => pendingEvents.push(value), onExitRequested: () => {} })
  scheduler.load(sanitizeQueues([{ id: 'q', name: 'Queue', maxConcurrent, parallelismConfigured: true }]))
  const tasks = Array.from({ length: 5 }, (_, index) => {
    const task = createTask({ url: `https://example.com/${index}.m3u8`, dir: tmpdir(), filename: `${index}.mp4`, kind: 'hls', queueId: 'q' })
    manager.add(task, false)
    return task
  })
  const finish = (task: DownloadTask) => {
    task.status = 'done'
    contexts.get(task.id)!.onFinished(task, null)
  }
  const active = () => tasks.filter((task) => task.status === 'downloading').map((task) => task.id)
  cleanups.push(async () => { scheduler.stop(); scheduler.cancelPending(); await manager.shutdown() })
  return { manager, scheduler, tasks, contexts, launched, finish, active, pendingEvents }
}

describe('queue execution', () => {
  it('keeps one completion action armed when manually paused members are settled', async () => {
    const f = setup()
    for (const task of f.tasks) task.status = 'done'
    await f.scheduler.save({ ...f.scheduler.list()[0], onComplete: 'exit' })
    f.tasks[0].status = 'paused'
    f.tasks[0].manualPause = true
    f.scheduler.list()[0].running = true
    f.scheduler.refresh()
    const action = f.pendingEvents.at(-1)
    ok(action)
    f.scheduler.refresh()
    f.scheduler.refresh()
    strictEqual(f.pendingEvents.at(-1), action)
    strictEqual(f.pendingEvents.filter(Boolean).length, 1)
    f.tasks[0].manualPause = false
    f.scheduler.refresh()
    strictEqual(f.pendingEvents.at(-1), null, 'resuming work cancels the action')
  })

  it('cancels pending machine actions when the scheduler stops', async () => {
    const f = setup()
    for (const task of f.tasks) task.status = 'done'
    await f.scheduler.save({ ...f.scheduler.list()[0], onComplete: 'exit' })
    await f.scheduler.startQueue('q')
    ok(f.pendingEvents.at(-1))
    f.scheduler.stop()
    strictEqual(f.pendingEvents.at(-1), null)
  })

  it('does not retry a finalization error that requires an explicit user action', async () => {
    const f = setup()
    await f.scheduler.save({ ...f.scheduler.list()[0], retryLimit: 3 })
    for (const task of f.tasks) task.status = 'done'
    f.tasks[0].status = 'error'
    f.tasks[0].manualPause = true
    f.scheduler.list()[0].running = true

    f.scheduler.refresh()
    strictEqual(f.tasks[0].queueRetryCount, 0)
    strictEqual(f.launched.length, 0)
    strictEqual(f.scheduler.list()[0].lastResult, 'completed-with-errors')
  })

  it('cancels a completion action when a stopped manual queue gains work', async () => {
    const f = setup()
    for (const task of f.tasks) task.status = 'done'
    await f.scheduler.save({ ...f.scheduler.list()[0], onComplete: 'exit' })
    await f.scheduler.startQueue('q')
    ok(f.pendingEvents.at(-1), 'draining the queue arms the action')
    const added = createTask({ url: 'https://example.com/next.m3u8', dir: tmpdir(), filename: 'next.mp4', kind: 'hls', queueId: 'q' })
    f.manager.add(added, false)
    f.scheduler.refresh()
    strictEqual(f.pendingEvents.at(-1), null, 'new work cancels the pending action even while stopped')
  })
  it('enforces serial execution even when Start marks every task queued', async () => {
    const f = setup()
    f.manager.start(f.tasks.map((task) => task.id))
    strictEqual(f.launched.length, 0, 'stopped queues cannot bypass the scheduler')
    await f.scheduler.startQueue('q')
    deepStrictEqual(f.active(), [f.tasks[0].id])
    f.finish(f.tasks[0])
    deepStrictEqual(f.active(), [f.tasks[1].id], 'next file starts immediately after completion')
    strictEqual(f.launched.length, 2)
  })

  it('moves fifth to second and uses that order for the next launch', async () => {
    const f = setup()
    await f.scheduler.startQueue('q')
    const ids = f.tasks.map((task) => task.id)
    await f.scheduler.reorder('q', moveQueueItem(ids, ids[4], ids[1]))
    deepStrictEqual(f.scheduler.list()[0].taskIds, [ids[0], ids[4], ids[1], ids[2], ids[3]])
    deepStrictEqual(f.active(), [ids[0]], 'reorder leaves the current transfer alone')
    f.finish(f.tasks[0])
    deepStrictEqual(f.active(), [ids[4]])
  })

  it('honors configured parallelism and the global cap', async () => {
    const f = setup(2)
    await f.scheduler.startQueue('q')
    strictEqual(f.active().length, 2)
    f.finish(f.tasks[0])
    deepStrictEqual(f.active(), [f.tasks[1].id, f.tasks[2].id])
    const g = setup(4, 2)
    await g.scheduler.startQueue('q')
    strictEqual(g.active().length, 2)
  })

  it('applies a reduced parallel limit without starting more work around it', async () => {
    const f = setup(3)
    await f.scheduler.startQueue('q')
    await f.scheduler.save({ ...f.scheduler.list()[0], maxConcurrent: 1 })
    deepStrictEqual(f.active(), [f.tasks[0].id])
    f.finish(f.tasks[0])
    deepStrictEqual(f.active(), [f.tasks[1].id])
  })

  it('shares one limiter and applies adding/removing a cap to running downloads', async () => {
    const f = setup(2)
    await f.scheduler.startQueue('q')
    const first = f.contexts.get(f.tasks[0].id)!.limiter
    strictEqual(first, f.contexts.get(f.tasks[1].id)!.limiter)
    strictEqual(first.limit, null)
    await f.scheduler.save({ ...f.scheduler.list()[0], speedLimit: 123456 })
    strictEqual(first.limit, 123456)
    await f.scheduler.save({ ...f.scheduler.list()[0], speedLimit: null })
    strictEqual(first.limit, null)
  })

  it('stops queued and active tasks without launching a replacement', async () => {
    const f = setup(2)
    await f.scheduler.startQueue('q')
    await f.scheduler.stopQueue('q')
    strictEqual(f.active().length, 0)
    strictEqual(f.launched.length, 2)
    strictEqual(f.tasks.every((task) => task.status === 'paused'), true)
  })

  it('persists icon, speed and chosen parallelism across sanitization', async () => {
    const f = setup()
    await f.scheduler.save({ ...f.scheduler.list()[0], icon: 'music', maxConcurrent: 3, speedLimit: 400000 })
    const [restored] = sanitizeQueues(f.scheduler.list())
    strictEqual(restored.icon, 'music')
    strictEqual(restored.maxConcurrent, 3)
    strictEqual(restored.speedLimit, 400000)
    strictEqual(restored.running, false)
    strictEqual(sanitizeQueues([{ id: 'old', maxConcurrent: 3 }])[0].maxConcurrent, 1)
  })

  it('reconciles order with membership, dropping foreign/duplicate IDs', () => {
    deepStrictEqual(orderedQueueIds(['b', 'foreign', 'b'], ['a', 'b', 'c']), ['b', 'a', 'c'])
    deepStrictEqual(moveQueueItem(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a'])
  })
})
