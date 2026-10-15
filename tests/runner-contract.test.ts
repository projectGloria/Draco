import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { TaskRunner } from '../src/main/engine/task.ts'
import { TorrentRunner } from '../src/main/engine/torrent.ts'
import {
  clearLearnedHostCaps,
  getLearnedHostCap
} from '../src/main/engine/ramp.ts'
import {
  clearSparseFlag,
  forgetPreallocationSupport,
  preallocate,
  type PreallocateDeps
} from '../src/main/engine/preallocate.ts'

/* ------------------------------------------------------------------ */
/* pause() must give the manager's concurrency slot back               */
/* ------------------------------------------------------------------ */

describe('Runner.pause releases the manager slot', () => {
  /*
   * `onFinished` is the only thing that drops a runner from `manager.runners`,
   * which is both the concurrency count and the guard `schedule()` checks before
   * launching. A pause that skips it leaks the slot for the life of the process
   * and leaves the task permanently unstartable - which is what a paused torrent
   * used to do, because its `start()` had already returned and had nothing left
   * to unwind on abort the way every other runner does.
   */
  it('TorrentRunner.pause calls onFinished', async () => {
    const task = createTask({ url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), dir: tmpdir(), kind: 'torrent' })
    const calls: string[] = []
    const context: any = {
      limiter: new RateLimiter(null),
      maxConnections: 1,
      minSplitSize: 1024 * 1024,
      retryLimit: 3,
      timeoutMs: 30_000,
      proxyUrl: null,
      onUpdate: () => calls.push('onUpdate'),
      onFinished: () => calls.push('onFinished')
    }

    const runner = new TorrentRunner(task, context)
    runner.running = true // as if start() had got as far as adding the torrent
    await runner.pause()

    ok(calls.includes('onFinished'), 'pause must reach onFinished or the slot is leaked')
    strictEqual(runner.running, false)
    strictEqual(task.status, 'paused')
  })

  it('is a no-op when the runner was not running', async () => {
    const task = createTask({ url: 'magnet:?xt=urn:btih:' + 'b'.repeat(40), dir: tmpdir(), kind: 'torrent' })
    const calls: string[] = []
    const context: any = {
      limiter: new RateLimiter(null),
      maxConnections: 1,
      minSplitSize: 1024 * 1024,
      retryLimit: 3,
      timeoutMs: 30_000,
      proxyUrl: null,
      onUpdate: () => calls.push('onUpdate'),
      onFinished: () => calls.push('onFinished')
    }

    await new TorrentRunner(task, context).pause()
    deepStrictEqual(calls, [], 'nothing was holding a slot, so nothing to give back')
  })
})

/* ------------------------------------------------------------------ */
/* A download that could not go wide teaches the host nothing          */
/* ------------------------------------------------------------------ */

describe('learned host caps are only written by downloads that measured one', () => {
  let server: Server
  let base = ''
  let dir = ''

  before(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname
      const body = Buffer.alloc(4096, 'x')

      // Answers a range, so the probe reports resumable and the task may split.
      if (path === '/ranged') {
        const match = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? '')
        if (match) {
          const start = Number(match[1])
          const end = match[2] ? Number(match[2]) : body.length - 1
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/${body.length}`,
            'content-length': String(end - start + 1),
            etag: '"ranged"'
          })
          res.end(body.subarray(start, end + 1))
          return
        }
        res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
        res.end(body)
        return
      }

      // Ignores ranges entirely: probe reports resumable false, so the task is
      // pinned to one connection by construction rather than by measurement.
      if (path === '/plain') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length)
        })
        res.end(body)
        return
      }

      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') base = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })

    dir = await mkdtemp(join(tmpdir(), 'draco-cap-'))
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  beforeEach(() => clearLearnedHostCaps())

  const run = (url: string): Promise<Error | null> => {
    const task = createTask({ url, dir })
    const runner = new TaskRunner(
      task,
      { maxConnections: 8, connectionCeiling: 8, minSplitSize: 64 * 1024, retryLimit: 2, timeoutMs: 15_000 },
      { limiter: new RateLimiter(null), onUpdate: () => {}, onFinished: () => {} }
    )
    return new Promise((resolve) => {
      runner.task.status = 'queued'
      void runner.start().then(() => resolve(null), (err) => resolve(err as Error))
    })
  }

  it('a non-resumable download does not pin the host to one connection', async () => {
    await run(`${base}/plain`)
    strictEqual(
      getLearnedHostCap('127.0.0.1'),
      null,
      'a transfer that was never eligible for parallelism measured nothing'
    )
  })

  it('a resumable download still records what it settled on', async () => {
    await run(`${base}/ranged`)
    const learned = getLearnedHostCap('127.0.0.1')
    ok(learned !== null && learned >= 1, 'a splittable transfer is worth learning from')
  })
})

/* ------------------------------------------------------------------ */
/* The sparse flag comes off a resumed download too                    */
/* ------------------------------------------------------------------ */

describe('clearSparseFlag across a restart', () => {
  function recordingDeps(sparseOk: boolean, validDataOk: boolean) {
    const calls: string[] = []
    const deps: PreallocateDeps = {
      async run(file, args) {
        calls.push([file, ...args].join(' '))
        if (args[0] === 'file' && args[1] === 'setvaliddata' && !validDataOk) throw new Error('denied')
        if (args[0] === 'sparse' && args[1] === 'setflag' && args.length === 3 && !sparseOk) {
          throw new Error('denied')
        }
      },
      async create() {},
      async truncate() {}
    }
    return { deps, calls }
  }

  const win = process.platform === 'win32'
  const path = 'C:\\tmp\\x.dracodl'

  beforeEach(() => forgetPreallocationSupport())

  it('clears the flag on a resumed download, where preallocate never ran', { skip: !win }, async () => {
    // A resume takes the `restored` branch in TaskRunner.run(), so preallocate
    // is skipped and the module knows nothing about the volume - exactly the
    // state a freshly started process is in. The flag must still come off.
    const { deps, calls } = recordingDeps(true, false)
    await clearSparseFlag(path, deps)
    deepStrictEqual(calls, [`fsutil sparse setflag ${path} 0`])
  })

  it('skips a volume that has refused the sparse flag', { skip: !win }, async () => {
    const { deps, calls } = recordingDeps(false, false)
    strictEqual(await preallocate(path, 1000, deps), 'none')
    calls.length = 0
    await clearSparseFlag(path, deps)
    deepStrictEqual(calls, [], 'nothing on this volume is ever sparse')
  })

  it('skips a volume where setvaliddata worked', { skip: !win }, async () => {
    const { deps, calls } = recordingDeps(true, true)
    strictEqual(await preallocate(path, 1000, deps), 'valid-data')
    calls.length = 0
    await clearSparseFlag(path, deps)
    deepStrictEqual(calls, [], 'preallocate never reached the sparse branch here')
  })
})

/* ------------------------------------------------------------------ */
/* YouTube token refresh mid-transfer resumes without losing progress  */
/* ------------------------------------------------------------------ */

describe('YouTube token refresh never splices bytes from two URLs', () => {
  let server: Server
  let base = ''
  let dir = ''
  const freshRanges: string[] = []
  let expiredTransferStarted = false

  beforeEach(() => {
    expiredTransferStarted = false
    freshRanges.length = 0
  })

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'draco-yt-test-'))
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname
      const fullSize = 4096

      if (path === '/yt-expired') {
        if (req.method === 'HEAD') {
          res.writeHead(200, {
            'content-length': String(fullSize),
            'accept-ranges': 'bytes',
            'etag': '"shared-tag"',
            'content-type': 'video/mp4'
          })
          res.end()
          return
        }

        if (req.headers.range === 'bytes=0-0') {
          res.writeHead(206, {
            'content-range': `bytes 0-0/${fullSize}`,
            'content-length': '1',
            'etag': '"shared-tag"',
            'content-type': 'video/mp4'
          })
          res.end(Buffer.from('a'))
          return
        }

        if (!expiredTransferStarted) {
          expiredTransferStarted = true
          res.writeHead(206, {
            'content-range': `bytes 0-${fullSize - 1}/${fullSize}`,
            'content-length': '1024',
            'etag': '"shared-tag"',
            'content-type': 'video/mp4'
          })
          res.end(Buffer.alloc(1024, 'a'))
          return
        }

        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      if (path === '/yt-fresh') {
        if (req.method === 'HEAD') {
          res.writeHead(200, {
            'content-length': String(fullSize),
            'accept-ranges': 'bytes',
            'etag': '"shared-tag"',
            'content-type': 'video/mp4'
          })
          res.end()
          return
        }

        const range = req.headers.range ?? ''
        freshRanges.push(String(range))
        const match = /^bytes=(\d+)-(\d+)?$/.exec(range)
        const start = match ? Number(match[1]) : 0
        const end = match && match[2] ? Number(match[2]) : fullSize - 1
        const length = end - start + 1

        res.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${fullSize}`,
          'content-length': String(length),
          'etag': '"shared-tag"',
          'content-type': 'video/mp4'
        })
        res.end(Buffer.alloc(length, 'b'))
        return
      }

      if (path === '/yt-fresh-error') {
        res.writeHead(404).end()
        return
      }

      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') {
          base = `http://127.0.0.1:${address.port}`
        }
        resolve()
      })
    })
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('restarts at zero when a signed URL changes despite an identical ETag', async () => {
    const task = createTask({
      url: `${base}/yt-expired`,
      dir,
      filename: 'yt-video.mp4',
      kind: 'file'
    })
    task.youtube = {
      pageUrl: 'https://www.youtube.com/watch?v=mock123',
      videoFormatId: '137'
    }

    let refreshCalled = 0
    const deps = {
      limiter: new RateLimiter(null),
      onUpdate: () => {},
      onFinished: () => {},
      refreshYouTube: async (_t: any, force: boolean) => {
        refreshCalled++
        return `${base}/${force ? 'yt-fresh' : 'yt-expired'}`
      }
    }

    const runner = new TaskRunner(
      task,
      {
        maxConnections: 1,
        minSplitSize: 512,
        retryLimit: 2,
        timeoutMs: 5000
      },
      deps
    )

    await runner.start()

    strictEqual(task.status, 'done')
    strictEqual(task.received, 4096)
    strictEqual((await readFile(join(dir, task.filename))).equals(Buffer.alloc(4096, 'b')), true)
    ok(refreshCalled >= 2, 'the expired media URL must have forced a refresh')
    ok(freshRanges.includes('bytes=0-4095'), 'the refreshed URL must download from byte zero')
  })

  it('keeps the old journal identity if probing the refreshed URL fails', async () => {
    const task = createTask({ url: `${base}/yt-expired`, dir, filename: 'yt-probe-failed.mp4' })
    task.youtube = { pageUrl: 'https://www.youtube.com/watch?v=mock123', videoFormatId: '137' }
    const runner = new TaskRunner(task, {
      maxConnections: 1, minSplitSize: 512, retryLimit: 2, timeoutMs: 5000
    }, {
      limiter: new RateLimiter(null), onUpdate() {}, onFinished() {},
      refreshYouTube: async (_task, force) => `${base}/${force ? 'yt-fresh-error' : 'yt-expired'}`
    })

    await runner.start()
    strictEqual(task.status, 'error')
    const journal = JSON.parse(await readFile(runner.journalPath, 'utf8'))
    strictEqual(journal.finalUrl, `${base}/yt-expired`)
    strictEqual(journal.etag, '"shared-tag"')
  })
})

/* ------------------------------------------------------------------ */
/* Post-processing aborts cleanly on cancellation                     */
/* ------------------------------------------------------------------ */

describe('TaskRunner post-processing aborts cleanly on cancellation', () => {
  let server: Server
  let base = ''
  let dir = ''

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'draco-postprocess-test-'))
    server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-length': '1024',
        'content-type': 'application/octet-stream'
      })
      res.end(Buffer.alloc(1024, 'z'))
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') {
          base = `http://127.0.0.1:${address.port}`
        }
        resolve()
      })
    })
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('aborts post-processing if cancelled and marks status paused', async () => {
    const task = createTask({
      url: `${base}/file`,
      dir,
      filename: 'song.bin',
      kind: 'file'
    })
    task.postProcess = 'mp3'

    const deps = {
      limiter: new RateLimiter(null),
      onUpdate: () => {},
      onFinished: () => {}
    }

    const runner = new TaskRunner(
      task,
      {
        maxConnections: 1,
        minSplitSize: 512,
        retryLimit: 1,
        timeoutMs: 5000
      },
      deps
    )

    const startPromise = runner.start()
    await runner.pause()
    await startPromise.catch(() => {})

    strictEqual(task.status, 'paused')
  })
})
