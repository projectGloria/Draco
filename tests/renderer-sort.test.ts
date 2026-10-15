import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { build } from 'esbuild'
import type { DownloadTask } from '../src/shared/types.ts'

test('name sorting keeps numeric order and a stable creation-time tie', async () => {
  const bundle = await build({
    stdin: {
      contents: "export { sortTasks } from './src/renderer/src/store/app.ts'",
      resolveDir: process.cwd(), loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: 'tsconfig.web.json'
  })
  const source = Buffer.from(bundle.outputFiles[0].text).toString('base64')
  const { sortTasks } = await import(`data:text/javascript;base64,${source}`)
  const rows = [
    { id: '10', filename: 'file10.bin', createdAt: 1 },
    { id: '2-later', filename: 'file2.bin', createdAt: 3 },
    { id: '2-earlier', filename: 'file2.bin', createdAt: 2 },
    { id: '1', filename: 'file1.bin', createdAt: 4 }
  ] as DownloadTask[]
  assert.deepEqual(sortTasks(rows, 'name', 'asc').map((row: DownloadTask) => row.id),
    ['1', '2-earlier', '2-later', '10'])
  assert.deepEqual(sortTasks(rows, 'name', 'desc').map((row: DownloadTask) => row.id),
    ['10', '2-earlier', '2-later', '1'])
})

test('unknown ETAs remain last in both sort directions', async () => {
  const bundle = await build({
    stdin: { contents: "export { sortTasks } from './src/renderer/src/store/app.ts'", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: 'tsconfig.web.json'
  })
  const { sortTasks } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
  const rows = [
    { id: 'unknown-later', eta: null, createdAt: 4 },
    { id: 'long', eta: 100, createdAt: 1 },
    { id: 'unknown-earlier', eta: null, createdAt: 3 },
    { id: 'short', eta: 10, createdAt: 2 }
  ] as DownloadTask[]
  assert.deepEqual(sortTasks(rows, 'eta', 'asc').map((row: DownloadTask) => row.id),
    ['short', 'long', 'unknown-earlier', 'unknown-later'])
  assert.deepEqual(sortTasks(rows, 'eta', 'desc').map((row: DownloadTask) => row.id),
    ['long', 'short', 'unknown-earlier', 'unknown-later'])
})
