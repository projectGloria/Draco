import { rejects, strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { tmpdir } from 'node:os'
import { createTask } from '../src/main/engine/create.ts'
import { DownloadManager, type EngineSettings } from '../src/main/engine/manager.ts'
import type { Runner } from '../src/main/engine/runner.ts'

const settings: EngineSettings = {
  maxConcurrentTasks: 2, maxConnectionsPerTask: 1, minSplitSize: 1024,
  retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
  hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
  antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 1
}

function fixture() {
  const manager = new DownloadManager({
    getSettings: () => settings, onTasks() {}, onProgress() {}
  })
  const tasks = [0, 1].map((index) => manager.add(createTask({
    url: `https://example.test/${index}.bin`, dir: tmpdir(), filename: `${index}.bin`, kind: 'file'
  }), false))
  const runners = (manager as unknown as { runners: Map<string, Runner> }).runners
  return { manager, tasks, runners }
}

it('waits for all pauses and refuses removal if one runner cannot stop', async () => {
  const { manager, tasks, runners } = fixture()
  let otherStopped = false
  let fail = true
  runners.set(tasks[0].id, {
    task: tasks[0], running: true, async start() {},
    async pause() { if (fail) throw new Error('journal flush failed') },
    tick() {}, async resetForRestart() { return false }
  })
  runners.set(tasks[1].id, {
    task: tasks[1], running: true, async start() {},
    async pause() { otherStopped = true },
    tick() {}, async resetForRestart() { return false }
  })

  await rejects(manager.pause(tasks.map((task) => task.id)), /Could not pause every selected download/)
  strictEqual(otherStopped, true)
  await rejects(manager.remove([tasks[0].id], true), /Could not pause every selected download/)
  strictEqual(manager.get(tasks[0].id)?.id, tasks[0].id)
  fail = false
  await manager.shutdown()
})

it('blocks shutdown if any runner fails to pause', async () => {
  const { manager, tasks, runners } = fixture()
  let otherStopped = false
  runners.set(tasks[0].id, {
    task: tasks[0], running: true, async start() {},
    async pause() { throw new Error('still writing') },
    tick() {}, async resetForRestart() { return false }
  })
  runners.set(tasks[1].id, {
    task: tasks[1], running: true, async start() {},
    async pause() { otherStopped = true },
    tick() {}, async resetForRestart() { return false }
  })

  await rejects(manager.shutdown(), /Could not pause every download before quitting/)
  strictEqual(otherStopped, true)
})

it('does not restart a task while its removal is waiting for the old runner', async () => {
  const { manager, tasks, runners } = fixture()
  const task = tasks[0]
  task.status = 'downloading'
  let release!: () => void
  const stopping = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const paused = new Promise<void>((resolve) => { entered = resolve })
  runners.set(task.id, {
    task, running: true, async start() {},
    async pause() {
      task.status = 'paused'
      entered()
      await stopping
      runners.delete(task.id)
      task.status = 'paused'
    },
    tick() {}, async resetForRestart() { return false }
  })
  const removing = manager.remove([task.id], false)
  await paused
  try {
    manager.start([task.id])
    strictEqual(task.status, 'paused', 'a removal must own the task until teardown finishes')
  } finally {
    release()
    await removing
  }
  strictEqual(manager.get(task.id), undefined)
  strictEqual(runners.has(task.id), false)
  await manager.shutdown()
})

it('honors Resume pressed while Pause is still flushing the old runner', async () => {
  const { manager, tasks, runners } = fixture()
  const task = tasks[0]
  task.status = 'downloading'
  let release!: () => void
  const closing = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const pausing = new Promise<void>((resolve) => { entered = resolve })
  runners.set(task.id, {
    task, running: true, async start() {},
    async pause() {
      task.status = 'paused'
      entered()
      await closing
      task.status = 'paused'
      runners.delete(task.id)
    },
    tick() {}, async resetForRestart() { return false }
  })
  // Keep the next launch queued so this regression makes no network requests.
  ;(manager as unknown as { schedule(): void }).schedule = () => {}
  const stopping = manager.pause([task.id], true)
  await pausing
  manager.start([task.id])
  release()
  await stopping
  strictEqual(task.status, 'queued', 'the settling old runner must not overwrite the later Resume command')
  strictEqual(task.manualPause, false)
  await manager.shutdown()
})
