import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, it } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'
import { JOURNAL_VERSION, writeJournal } from '../src/main/engine/journal.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { probeUrl } from '../src/main/engine/probe.ts'
import { TaskRunner } from '../src/main/engine/task.ts'
import { DownloadManager, type EngineSettings } from '../src/main/engine/manager.ts'

let server: Server
let base = ''
let dir = ''
let version = 1
const requests: Array<{ path: string; range: string | undefined; ifRange: string | undefined }> = []
const body = Buffer.alloc(4096, 'b')

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'draco-http-recovery-'))
  server = createServer((req, res) => {
    if (req.method === 'GET') requests.push({ path: req.url ?? '', range: req.headers.range,
      ifRange: Array.isArray(req.headers['if-range'])
        ? req.headers['if-range'][0] : req.headers['if-range'] })
    const rangesForbidden = req.url === '/no-ranges.bin'
    if (req.url === '/range-only-no-validator.bin' && req.method === 'GET' && !req.headers.range) {
      res.writeHead(403).end()
      return
    }
    if (rangesForbidden && req.headers.range) {
      res.writeHead(403).end()
      return
    }
    const midTransfer = req.url === '/mid-transfer.bin' && req.headers.range !== 'bytes=0-0'
    const content = (req.url === '/changing.bin' || req.url === '/unvalidated.bin') && version === 1
      ? Buffer.alloc(body.length, 'a') : body
    if (req.url !== '/unvalidated.bin' && req.url !== '/range-only-no-validator.bin' &&
        !(req.url === '/omit-on-transfer.bin' && req.headers.range && req.headers.range !== 'bytes=0-0')) {
      res.setHeader('etag', `"v${(req.url === '/changing.bin' && version === 2) || midTransfer ? 2 : 1}"`)
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''))
    if (range) {
      const start = Number(range[1])
      const end = range[2] ? Number(range[2]) : content.length - 1
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${content.length}`,
        'content-length': end - start + 1
      }).end(req.method === 'HEAD' ? undefined : content.subarray(start, end + 1))
    } else {
      res.writeHead(200, { 'content-length': content.length })
        .end(req.method === 'HEAD' ? undefined : content)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address && typeof address === 'object') base = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await closeDispatchers()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

function runnerFor(filename: string) {
  const task = createTask({ url: `${base}/${filename}`, dir, filename })
  const runner = new TaskRunner(task, {
    maxConnections: 1, minSplitSize: 1024, retryLimit: 1, timeoutMs: 2000
  }, { limiter: new RateLimiter(), onUpdate() {}, onFinished() {} })
  return { task, runner }
}

async function savePartial(runner: TaskRunner, content: Buffer, etag: string | null = '"v1"'): Promise<void> {
  await mkdir(dirname(runner.partPath), { recursive: true })
  await writeFile(runner.partPath, content)
  await writeJournal(runner.journalPath, {
    version: JOURNAL_VERSION, url: runner.task.url, finalUrl: runner.task.url,
    filename: runner.task.filename, size: body.length, etag, lastModified: null,
    segments: [{ start: 0, end: body.length - 1, position: 2048, active: false }],
    updatedAt: Date.now()
  })
}

it('downloads a file whose server forbids Range requests', async () => {
  const { task, runner } = runnerFor('no-ranges.bin')
  await runner.start()
  strictEqual(task.status, 'done', task.error ?? '')
  deepStrictEqual(await readFile(join(dir, task.filename)), body)
})

it('downloads a range-only resource without an ETag in one complete response', async () => {
  const { task, runner } = runnerFor('range-only-no-validator.bin')
  await runner.start()
  strictEqual(task.status, 'done', task.error ?? '')
  strictEqual(task.resumable, false)
  strictEqual(task.connections, 1)
  deepStrictEqual(await readFile(join(dir, task.filename)), body)
  deepStrictEqual(requests.filter((req) => req.path === '/range-only-no-validator.bin').map((req) => req.range),
    ['bytes=0-0', 'bytes=0-4095'])
})

it('preserves an existing empty user file when the final name collides', async () => {
  const { task, runner } = runnerFor('empty-user-file.bin')
  const original = join(dir, task.filename)
  await writeFile(original, '')
  await runner.start()
  strictEqual(task.status, 'done', task.error ?? '')
  strictEqual((await readFile(original)).length, 0)
  strictEqual(task.filename !== 'empty-user-file.bin', true)
  deepStrictEqual(await readFile(join(dir, task.filename)), body)
})

it('refreshes cached validators before adopting a partial download', async () => {
  const { task, runner } = runnerFor('changing.bin')
  await probeUrl(task.url)
  await savePartial(runner, Buffer.alloc(2048, 'a'))
  version = 2
  await runner.start()
  strictEqual(task.status, 'done', task.error ?? '')
  deepStrictEqual(await readFile(join(dir, task.filename)), body)
})

it('restarts when the part file is shorter than the bytes claimed by its journal', async () => {
  const { task, runner } = runnerFor('truncated.bin')
  await savePartial(runner, body.subarray(0, 1024))
  await runner.start()
  strictEqual(task.status, 'done', task.error ?? '')
  deepStrictEqual(await readFile(join(dir, task.filename)), body)
})

it('still reuses a valid partial file after fresh validation', async () => {
  const { task, runner } = runnerFor('valid-resume.bin')
  await savePartial(runner, body.subarray(0, 2048))
  await runner.start()
  strictEqual(task.status, 'done', task.error ?? '')
  deepStrictEqual(await readFile(join(dir, task.filename)), body)
  deepStrictEqual(requests.filter((req) => req.path === '/valid-resume.bin').map((req) => req.range),
    ['bytes=0-0', 'bytes=2048-4095'])
  deepStrictEqual(requests.filter((req) => req.path === '/valid-resume.bin').map((req) => req.ifRange),
    [undefined, '"v1"'])
})

it('restarts a same-size partial when the server has no strong validator', async () => {
  version = 1
  const { task, runner } = runnerFor('unvalidated.bin')
  await savePartial(runner, Buffer.alloc(2048, 'a'), null)
  version = 2
  await runner.start()
  strictEqual(task.status, 'done', task.error ?? '')
  strictEqual(task.resumable, false)
  deepStrictEqual(await readFile(join(dir, task.filename)), body)
  deepStrictEqual(requests.filter((req) => req.path === '/unvalidated.bin').map((req) => req.range),
    ['bytes=0-0', 'bytes=0-4095'])
})

it('falls back cleanly when ranged responses omit the probed strong ETag', async () => {
  const task = createTask({ url: `${base}/omit-on-transfer.bin`, dir, filename: 'omit-on-transfer.bin' })
  const settings: EngineSettings = {
    maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
    retryLimit: 1, timeoutMs: 2000, speedLimit: null, proxyUrl: null,
    hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
    antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 30, tempDir: dir
  }
  const manager = new DownloadManager({ getSettings: () => settings, onTasks() {}, onProgress() {} })
  try {
    manager.add(task, false)
    manager.start([task.id])
    const deadline = Date.now() + 5000
    while (task.status !== 'done' && Date.now() < deadline) {
      if (task.status === 'error' && task.singleConnectionFallback) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    strictEqual(task.status, 'done', task.error ?? 'Download did not finish')
    strictEqual(task.singleConnectionFallback, true)
    strictEqual(task.resumable, false)
    deepStrictEqual(await readFile(join(dir, task.filename)), body)
    const ranges = requests.filter((req) => req.path === '/omit-on-transfer.bin').map((req) => req.range)
    strictEqual(ranges.includes('bytes=0-4095'), true)
    strictEqual(ranges.includes(undefined), true)
  } finally {
    await manager.shutdown()
  }
})

it('rejects a changed ETag between probe and transfer', async () => {
  const { task, runner } = runnerFor('mid-transfer.bin')
  await runner.start()
  strictEqual(task.status, 'error')
  strictEqual(task.error?.includes('changed the resource ETag'), true)
})

it('keeps compatibility mode after a probe advertises range support', async () => {
  const { task, runner } = runnerFor('fallback.bin')
  task.singleConnectionFallback = true
  await runner.start()
  strictEqual(task.status, 'done', task.error ?? '')
  strictEqual(task.resumable, false)
  deepStrictEqual(await readFile(join(dir, task.filename)), body)
  deepStrictEqual(requests.filter((req) => req.path === '/fallback.bin').map((req) => req.range),
    ['bytes=0-0', undefined])
})

it('honors cancellation even when a probe result is cached', async () => {
  const url = `${base}/cancelled.bin`
  await probeUrl(url)
  await rejects(probeUrl(url, { signal: AbortSignal.abort() }), { name: 'AbortError' })
})
