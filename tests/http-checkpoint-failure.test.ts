import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rejects, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { TaskRunner } from '../src/main/engine/task.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'

test('a failed forced checkpoint blocks Pause and leaves the partial recoverable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-checkpoint-failure-'))
  const body = Buffer.alloc(64 * 1024, 'c')
  let stall = true
  const server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ''))
    const start = range ? Number(range[1]) : 0
    const end = range ? (range[2] ? Number(range[2]) : body.length - 1) : body.length - 1
    response.setHeader('etag', '"checkpoint-body"')
    response.setHeader('accept-ranges', 'bytes')
    response.setHeader('content-length', end - start + 1)
    if (range) response.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
    response.writeHead(range ? 206 : 200)
    if (request.method === 'HEAD') { response.end(); return }
    if (request.headers.range === 'bytes=0-0' || !stall) {
      response.end(body.subarray(start, end + 1))
    } else {
      response.write(body.subarray(start, Math.min(end + 1, start + 4096)))
      // Keep the response open until Pause aborts its request.
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/file.bin`
  const task = createTask({ url, dir, filename: 'file.bin' })
  const makeRunner = () => new TaskRunner(task, {
    maxConnections: 1, minSplitSize: 1024, retryLimit: 1, timeoutMs: 5000
  }, { limiter: new RateLimiter(), onUpdate() {}, onFinished() {} })
  const runner = makeRunner()

  try {
    const active = runner.start()
    const deadline = Date.now() + 3000
    while (task.status !== 'downloading' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    strictEqual(task.status, 'downloading')
    await mkdir(runner.journalPath)
    // Trigger the periodic checkpoint without waiting for its one-second timer.
    ;(runner as unknown as { lastFlush: number }).lastFlush = 0
    runner.tick()
    const warningDeadline = Date.now() + 3000
    while (!task.detail?.includes('checkpoint could not be saved') && Date.now() < warningDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    strictEqual(task.detail?.includes('checkpoint could not be saved'), true)

    await rm(runner.journalPath, { recursive: true })
    const internals = runner as unknown as { lastFlush: number; checkpointRetryAt: number }
    internals.checkpointRetryAt = 0
    internals.lastFlush = 0
    runner.tick()
    const recoveryDeadline = Date.now() + 3000
    while (task.detail?.includes('checkpoint could not be saved') && Date.now() < recoveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    strictEqual(task.detail, null)
    strictEqual((await stat(runner.journalPath)).isFile(), true)

    await rm(runner.journalPath)
    await mkdir(runner.journalPath)
    await rejects(runner.pause(), /Could not save the resume checkpoint/)
    await active
    strictEqual(task.status, 'error')
    strictEqual((await stat(runner.partPath)).isFile(), true)

    await rm(runner.journalPath, { recursive: true })
    stall = false
    await makeRunner().start()
    strictEqual(task.status, 'done', task.error ?? '')
    strictEqual((await readFile(join(dir, task.filename))).equals(body), true)
  } finally {
    await closeDispatchers()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
