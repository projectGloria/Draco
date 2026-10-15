import { strictEqual, ok } from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { TaskRunner } from '../src/main/engine/task.ts'

/*
 * The documented runner contract (src/main/engine/runner.ts): a pause must
 * reach `onFinished` before it resolves, or the manager's concurrency slot
 * leaks for the life of the process and the task can never start again.
 * TorrentRunner is covered by runner-contract.test.ts; these tests pin the
 * same guarantee for TaskRunner mid-transfer, which is the pause that matters.
 */

describe('TaskRunner pause contract', () => {
  let server: Server
  let base = ''
  let dir = ''

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

      if (url.pathname === '/refresh-probe' || url.pathname === '/refresh-transfer') {
        if (url.pathname === '/refresh-transfer' &&
            (req.method === 'HEAD' || req.headers.range === 'bytes=0-0')) {
          const ranged = req.method === 'GET'
          res.writeHead(ranged ? 206 : 200, {
            'content-length': ranged ? '1' : '4',
            ...(ranged ? { 'content-range': 'bytes 0-0/4' } : {}),
            etag: '"refresh"'
          }).end(ranged ? 'a' : undefined)
        } else {
          res.writeHead(403).end()
        }
        return
      }

      if (url.pathname !== '/stall') {
        res.writeHead(404)
        res.end()
        return
      }

      // The probe's `bytes=0-0` is answered normally so the run gets as far as
      // a real transfer; the actual body then hangs forever, which is the
      // state a paused download has to be interruptible in.
      const range = req.headers.range
      if (req.method === 'HEAD' || range === 'bytes=0-0') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': '1048576',
          'accept-ranges': 'bytes',
          'etag': '"stall-etag"'
        })
        res.end()
        return
      }

      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': 'bytes 0-1048575/1048576',
        'content-length': '1048576',
        'etag': '"stall-etag"'
      })
      res.write(Buffer.alloc(4096, 'a'))
      // Never end the response; the abort from pause() is the only way out.
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') base = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })

    dir = await mkdtemp(join(tmpdir(), 'draco-pause-'))
  })

  after(async () => {
    await closeDispatchers()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  for (const phase of ['probe', 'transfer']) {
    it(`stays paused when a YouTube ${phase} refresh finishes after pause`, async () => {
      const task = createTask({ url: `${base}/refresh-${phase}`, dir, filename: `refresh-${phase}.bin` })
      task.youtube = { pageUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', videoFormatId: '140' }
      let calls = 0
      let finishes = 0
      let finishError: Error | null = null
      let beginRefresh!: () => void
      let releaseRefresh!: (url: string) => void
      const refreshStarted = new Promise<void>((resolve) => { beginRefresh = resolve })
      const refreshed = new Promise<string>((resolve) => { releaseRefresh = resolve })
      const runner = new TaskRunner(task,
        { maxConnections: 1, minSplitSize: 1024, retryLimit: 1, timeoutMs: 2000 }, {
          limiter: new RateLimiter(),
          onUpdate() {},
          onFinished(_task, error) { finishes++; finishError = error },
          async refreshYouTube() {
            calls++
            if (calls === 1) return task.url
            beginRefresh()
            return refreshed
          }
        })
      const started = runner.start()
      await refreshStarted
      const paused = runner.pause()
      releaseRefresh(`${base}/missing-after-pause`)
      await Promise.all([started, paused])
      strictEqual(task.status, 'paused')
      strictEqual(task.error, null)
      strictEqual(finishError, null)
      strictEqual(finishes, 1)
      strictEqual(calls, 2)
    })
  }

  it('pause() during a live transfer reaches onFinished exactly once', async () => {
    const task = createTask({ url: `${base}/stall`, dir, filename: 'stall.bin' })
    let finishes = 0
    let finishError: Error | null = null
    let updates = 0
    const runner = new TaskRunner(
      task,
      { maxConnections: 4, minSplitSize: 1024, retryLimit: 1, timeoutMs: 30_000 },
      {
        limiter: new RateLimiter(null),
        onUpdate: () => {
          updates++
        },
        onFinished: (_finished, error) => {
          finishes++
          finishError = error
        }
      }
    )

    const startPromise = runner.start()
    // Let the probe land and the transfer begin.
    await new Promise((resolve) => setTimeout(resolve, 500))
    ok(
      task.status === 'downloading' || task.status === 'probing',
      `expected the transfer to be live, got ${task.status}`
    )

    await runner.pause()

    // The pause must have handed the slot back exactly once, and not reported
    // a failure: a pause is not an error.
    strictEqual(finishes, 1)
    strictEqual(finishError, null)
    strictEqual(task.status, 'paused')

    // start() unwinds without throwing and without emitting again.
    await startPromise
    strictEqual(finishes, 1)
  })

  it('stays paused when probing finishes after Stop was requested', async () => {
    const task = createTask({ url: `${base}/stall`, dir, filename: 'probe-pause.bin' })
    let releaseProbe!: () => void
    let reachedProbe!: () => void
    const gate = new Promise<void>((resolve) => { releaseProbe = resolve })
    const probed = new Promise<void>((resolve) => { reachedProbe = resolve })
    let finishes = 0
    const runner = new TaskRunner(
      task,
      { maxConnections: 1, minSplitSize: 1024, retryLimit: 0, timeoutMs: 30_000 },
      {
        limiter: new RateLimiter(null),
        onUpdate: () => {},
        onFinished: () => { finishes++ },
        async onProbed() { reachedProbe(); await gate }
      }
    )

    const starting = runner.start()
    await probed
    const stopping = runner.pause()
    releaseProbe()
    await stopping
    await starting
    strictEqual(task.status, 'paused')
    strictEqual(finishes, 1)
    strictEqual(await stat(runner.partPath).catch(() => null), null)
  })

  it('pause() twice does not emit a second onFinished', async () => {
    const task = createTask({ url: `${base}/stall`, dir, filename: 'stall-2.bin' })
    let finishes = 0
    const runner = new TaskRunner(
      task,
      { maxConnections: 1, minSplitSize: 1024, retryLimit: 1, timeoutMs: 30_000 },
      { limiter: new RateLimiter(null), onUpdate: () => {}, onFinished: () => finishes++ }
    )

    const startPromise = runner.start()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await runner.pause()
    await runner.pause()
    await startPromise

    strictEqual(finishes, 1)
  })
})
