import { createServer, type Server } from 'node:http'
import { ok, strictEqual } from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { parseRetryAfterMs, ServerBusyError, NotResumableError } from '../src/main/engine/worker.ts'
import { probeUrl } from '../src/main/engine/probe.ts'

describe('Runner HTTP Integration & Error Contracts', () => {
  let server: Server
  let base = ''
  let busyCount = 0

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

      if (url.pathname === '/busy') {
        busyCount++
        res.writeHead(429, {
          'content-type': 'text/plain',
          'retry-after': '3'
        })
        res.end('Too many connections')
        return
      }

      if (url.pathname === '/ignore-range') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': '1024'
        })
        res.end(Buffer.alloc(1024, 'a'))
        return
      }

      if (url.pathname === '/file') {
        const fullSize = 2048
        const rangeHeader = req.headers.range
        if (rangeHeader) {
          const match = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader)
          if (match) {
            const start = Number(match[1])
            const end = match[2] ? Number(match[2]) : fullSize - 1
            const chunkLength = end - start + 1
            res.writeHead(206, {
              'content-type': 'application/octet-stream',
              'content-range': `bytes ${start}-${end}/${fullSize}`,
              'content-length': String(chunkLength),
              'etag': '"mock-etag-123"'
            })
            res.end(Buffer.alloc(chunkLength, 'b'))
            return
          }
        }

        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(fullSize),
          'accept-ranges': 'bytes',
          'etag': '"mock-etag-123"'
        })
        res.end(Buffer.alloc(fullSize, 'b'))
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
  })

  it('correctly probes a resumable range-supporting file', async () => {
    const probed = await probeUrl(`${base}/file`)
    strictEqual(probed.resumable, true)
    strictEqual(probed.size, 2048)
    strictEqual(probed.etag, '"mock-etag-123"')
  })

  it('parses retry-after headers in delay seconds and http dates', () => {
    strictEqual(parseRetryAfterMs('5'), 5000)
    strictEqual(parseRetryAfterMs('0'), 0)
    strictEqual(parseRetryAfterMs(undefined), null)
    strictEqual(parseRetryAfterMs('invalid'), null)

    const now = Date.now()
    const futureDate = new Date(now + 10_000).toUTCString()
    const parsed = parseRetryAfterMs(futureDate, now)
    ok(parsed !== null && parsed >= 9000 && parsed <= 11000)
  })

  it('instantiates ServerBusyError with status code and retryAfterMs', () => {
    const err = new ServerBusyError(429, 3000)
    strictEqual(err.name, 'ServerBusyError')
    strictEqual(err.statusCode, 429)
    strictEqual(err.retryAfterMs, 3000)
  })

  it('instantiates NotResumableError', () => {
    const err = new NotResumableError('Server ignored byte range')
    strictEqual(err.name, 'NotResumableError')
    strictEqual(err.message, 'Server ignored byte range')
  })
})
