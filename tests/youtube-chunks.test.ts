import { deepStrictEqual, strictEqual, rejects } from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isFixedYouTubeResource } from '../src/main/youtube-url.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { runSegment } from '../src/main/engine/worker.ts'

const signedUrl = 'https://media.googlevideo.com/videoplayback?source=youtube&id=object&itag=243&lmt=123&clen=42&sparams=id,itag,lmt,clen&sig=fixture'

test('only fixed signed YouTube resources qualify for chunks without an ETag', () => {
  strictEqual(isFixedYouTubeResource(signedUrl, 42), true)
  for (const url of [
    signedUrl.replace('https:', 'http:'),
    signedUrl.replace('media.googlevideo.com', 'googlevideo.com.example.org'),
    signedUrl.replace('source=youtube', 'source=yt_live_broadcast'),
    signedUrl.replace('&sig=fixture', ''),
    signedUrl.replace('sparams=id,itag,lmt,clen', 'sparams=id,itag,clen'),
    signedUrl.replace('lmt=123', 'lmt=unknown')
  ]) strictEqual(isFixedYouTubeResource(url, 42), false, url)
  strictEqual(isFixedYouTubeResource(signedUrl, 43), false)
  strictEqual(isFixedYouTubeResource(signedUrl, null), false)
})

for (const mode of ['complete', 'changed-size', 'redirect', 'ordinary'] as const) {
  test(`bounded media requests: ${mode}`, async (t) => {
    const size = 21 * 1024 * 1024 + 17
    const body = Buffer.allocUnsafe(size)
    for (let i = 0; i < size; i++) body[i] = i % 251
    const ranges: string[] = []
    const server = createServer((req, res) => {
      if (mode === 'redirect' && req.url !== '/other') {
        res.writeHead(302, { location: '/other' }).end()
        return
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range))
      if (!range) { res.writeHead(400).end(); return }
      ranges.push(req.headers.range!)
      const start = Number(range[1])
      const end = Number(range[2])
      res.writeHead(206, {
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${mode === 'changed-size' && start > 0 ? size + 1 : size}`
      }).end(body.subarray(start, end + 1))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => { server.closeAllConnections(); server.close() })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    const dir = await mkdtemp(join(tmpdir(), 'draco-chunks-'))
    const path = join(dir, 'part')
    const fh = await open(path, 'w+')
    t.after(async () => { await fh.close(); await rm(dir, { recursive: true, force: true }) })
    const segment = { start: 0, end: size - 1, position: mode === 'ordinary' ? 1024 : 0, active: true }
    const transfer = runSegment(segment, {
      url: `http://127.0.0.1:${address.port}/file`, headers: {}, fh,
      limiter: new RateLimiter(), timeoutMs: 2000, retryLimit: 1, exponentialBackoff: false,
      expectedSize: size, useRanges: false, sequentialRanges: mode !== 'ordinary',
      signal: AbortSignal.timeout(10000), writeBufferBytes: 128 * 1024, onBytes() {}
    })
    if (mode === 'complete') {
      await transfer
      strictEqual(segment.position, size)
      deepStrictEqual(ranges, ['bytes=0-10485759', 'bytes=10485760-20971519', `bytes=20971520-${size - 1}`])
      strictEqual(createHash('sha256').update(await readFile(path)).digest('hex'),
        createHash('sha256').update(body).digest('hex'))
    } else {
      await rejects(transfer, mode === 'changed-size' ? /expected resource size/
        : mode === 'redirect' ? /different resource/ : /does not support resuming/)
    }
  })
}
