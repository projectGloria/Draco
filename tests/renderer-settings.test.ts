import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { build } from 'esbuild'

test('settings saves preserve newer edits and roll back a failed latest edit', async () => {
  const bundle = await build({
    stdin: {
      contents: "export { useApp } from './src/renderer/src/store/app.ts'; export { useToasts } from './src/renderer/src/store/toasts.ts'",
      resolveDir: process.cwd(), loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: 'tsconfig.web.json'
  })
  const source = Buffer.from(bundle.outputFiles[0].text).toString('base64')
  const { useApp, useToasts } = await import(`data:text/javascript;base64,${source}`)
  const writes: Array<{
    patch: Record<string, unknown>
    resolve(value: unknown): void
    reject(error: Error): void
  }> = []
  const api = {
    onTasksChanged() {}, onProgress() {}, onPlaylistProgress() {},
    onQueuesChanged() {}, onPendingAction() {}, onClipboardItemsChanged() {},
    getSettings: async () => useApp.getState().settings,
    listTasks: async () => [], listCategories: async () => [],
    listQueues: async () => [], listClipboardItems: async () => [],
    getIntegration: async () => null,
    saveSettings: (patch: Record<string, unknown>) => new Promise((resolve, reject) => {
      writes.push({ patch, resolve, reject })
    })
  }
  Object.assign(globalThis, {
    window: { api },
    document: { documentElement: { style: { setProperty() {} } } }
  })
  await useApp.getState().init()
  const initial = useApp.getState().settings

  const first = useApp.getState().patchSettings({ theme: 'light' })
  const second = useApp.getState().patchSettings({ theme: 'dark' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(writes.length, 1)
  assert.equal(useApp.getState().settings.theme, 'dark')

  writes[0].resolve({ ...initial, theme: 'light' })
  assert.equal(await first, true)
  assert.equal(useApp.getState().settings.theme, 'dark')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(writes.length, 2)
  writes[1].reject(new Error('disk full'))
  assert.equal(await second, false)
  assert.equal(useApp.getState().settings.theme, 'light')

  const third = useApp.getState().patchSettings({ theme: 'system' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(writes.length, 3)
  writes[2].resolve({ ...initial, theme: 'system' })
  assert.equal(await third, true)
  assert.equal(useApp.getState().settings.theme, 'system')

  for (const toast of useToasts.getState().toasts) clearTimeout(toast.timer)
})
