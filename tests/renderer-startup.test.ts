import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { build } from 'esbuild'

test('failed renderer initialization remains retryable and keeps newer events', async () => {
  // Bundle the renderer store so this test exercises the real Zustand actions
  // while resolving its Vite aliases without starting an Electron window.
  const bundle = await build({
    entryPoints: ['src/renderer/src/store/app.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    tsconfig: 'tsconfig.web.json'
  })
  const source = Buffer.from(bundle.outputFiles[0].text).toString('base64')
  const { filterTasks, useApp } = await import(`data:text/javascript;base64,${source}`)

  const subscriptions = new Map<string, (value: unknown) => void>()
  let taskReads = 0
  let resolveTasks: ((tasks: unknown[]) => void) | undefined
  const laterTasks = new Promise<unknown[]>((resolve) => { resolveTasks = resolve })
  const api = {
    onTasksChanged: (callback: (value: unknown) => void) => subscriptions.set('tasks', callback),
    onProgress: (callback: (value: unknown) => void) => subscriptions.set('progress', callback),
    onPlaylistProgress: (callback: (value: unknown) => void) => subscriptions.set('playlist', callback),
    onQueuesChanged: (callback: (value: unknown) => void) => subscriptions.set('queues', callback),
    onPendingAction: (callback: (value: unknown) => void) => subscriptions.set('pending', callback),
    onClipboardItemsChanged: (callback: (value: unknown) => void) => subscriptions.set('clipboard', callback),
    getSettings: async () => useApp.getState().settings,
    listTasks: () => ++taskReads === 1 ? Promise.reject(new Error('state unavailable')) : laterTasks,
    listCategories: async () => [],
    listQueues: async () => [],
    listClipboardItems: async () => [],
    getIntegration: async () => null
  }
  Object.assign(globalThis, {
    window: { api },
    document: { documentElement: { style: { setProperty() {} } } }
  })

  await useApp.getState().init()
  assert.equal(useApp.getState().ready, false)
  assert.match(useApp.getState().initError ?? '', /state unavailable/)
  assert.equal(subscriptions.size, 6)

  const retry = useApp.getState().init()
  const liveTask = { id: 'new-task', status: 'paused' }
  subscriptions.get('tasks')?.([liveTask])
  subscriptions.get('queues')?.([{ id: 'new-queue' }])
  subscriptions.get('clipboard')?.([{ id: 'new-clip' }])
  resolveTasks?.([{ id: 'stale-task', status: 'done' }])
  await retry

  assert.equal(useApp.getState().ready, true)
  assert.equal(useApp.getState().initError, null)
  assert.deepEqual(useApp.getState().tasks.map((task: { id: string }) => task.id), ['new-task'])
  assert.deepEqual(useApp.getState().queues.map((queue: { id: string }) => queue.id), ['new-queue'])
  assert.deepEqual(useApp.getState().clipboardItems.map((item: { id: string }) => item.id), ['new-clip'])
  assert.equal(subscriptions.size, 6)

  const stages = ['probing', 'downloading', 'processing', 'scanning', 'queued', 'paused', 'error', 'missing', 'done']
  const sample = stages.map((status) => ({ id: status, status }))
  const idsIn = (view: string): string[] => filterTasks(sample, view).map((task: { id: string }) => task.id)
  assert.deepEqual(idsIn('active'), stages.slice(0, 4))
  assert.deepEqual(idsIn('queued'), ['queued'])
  assert.deepEqual(idsIn('attention'), ['error', 'missing'])
  assert.deepEqual(idsIn('finished'), ['done'])
})

test('progress received before the initial task snapshot is retained', async () => {
  const bundle = await build({
    entryPoints: ['src/renderer/src/store/app.ts'], bundle: true, platform: 'node',
    format: 'esm', write: false, tsconfig: 'tsconfig.web.json'
  })
  const source = Buffer.from(bundle.outputFiles[0].text + '\n// progress during startup').toString('base64')
  const { useApp } = await import(`data:text/javascript;base64,${source}`)
  let onProgress!: (updates: unknown[]) => void
  let resolveTasks!: (tasks: unknown[]) => void
  const tasks = new Promise<unknown[]>((resolve) => { resolveTasks = resolve })
  Object.assign(globalThis, {
    window: { api: {
      onTasksChanged() {}, onPlaylistProgress() {}, onQueuesChanged() {}, onPendingAction() {}, onClipboardItemsChanged() {},
      onProgress(callback: typeof onProgress) { onProgress = callback },
      getSettings: async () => useApp.getState().settings, listTasks: () => tasks,
      listCategories: async () => [], listQueues: async () => [], listClipboardItems: async () => [],
      getIntegration: async () => null
    } },
    document: { documentElement: { style: { setProperty() {} } } }
  })
  const pending = useApp.getState().init()
  onProgress([{ id: 'active', status: 'downloading', received: 2048, speed: 100, size: 4096, eta: 20, error: null, detail: null }])
  resolveTasks([{ id: 'active', status: 'downloading', received: 0, speed: 0, size: 4096 }])
  await pending
  assert.equal(useApp.getState().tasks.length, 1)
  assert.equal(useApp.getState().tasks[0].received, 2048)
  assert.equal(useApp.getState().tasks[0].speed, 100)
})
