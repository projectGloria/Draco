import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { build } from 'esbuild'

test('category saves publish main-process normalization and failed saves preserve current categories', async () => {
  const bundle = await build({
    stdin: {
      contents: "export { useApp } from './src/renderer/src/store/app.ts'; export { useToasts } from './src/renderer/src/store/toasts.ts'",
      resolveDir: process.cwd(), loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: 'tsconfig.web.json'
  })
  const { useApp, useToasts } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
  const original = [{ id: 'video', name: 'Videos', extensions: ['mp4'], folder: 'Videos', hosts: [], builtin: true }]
  const saved = [{ ...original[0], name: 'Movies', folder: 'Safe folder' }]
  useApp.setState({ categories: original })
  let fail = false
  Object.assign(globalThis, { window: { api: {
    saveCategories: async () => { if (fail) throw new Error('disk full'); return saved }
  } } })
  assert.equal(await useApp.getState().saveCategories([{ ...original[0], folder: 'Unsafe:folder' }]), true)
  assert.deepEqual(useApp.getState().categories, saved)
  fail = true
  assert.equal(await useApp.getState().saveCategories(original), false)
  assert.deepEqual(useApp.getState().categories, saved)
  for (const toast of useToasts.getState().toasts) clearTimeout(toast.timer)
})
