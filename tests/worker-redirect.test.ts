import { strict as assert } from 'node:assert'
import { open, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HttpAuthenticator } from '../src/main/engine/auth.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { runSegment } from '../src/main/engine/worker.ts'

test('range worker authenticates a redirect destination without leaking source headers', async (t) => {
  const content = Buffer.from('data')
  const expectedAuth = `Basic ${Buffer.from('reader:password').toString('base64')}`
  let challenges = 0
  let leaked = 0
  const destination = createServer((request, response) => {
    if (request.headers.cookie || request.headers['x-api-key'] || request.headers.authorization === 'Bearer captured') leaked++
    if (request.headers.authorization !== expectedAuth) {
      challenges++
      response.writeHead(401, { 'www-authenticate': 'Basic realm="media"' }).end()
      return
    }
    assert.equal(request.headers.range, 'bytes=0-3')
    assert.equal(request.headers['if-range'], '"version-1"')
    response.writeHead(206, {
      'content-range': 'bytes 0-3/4',
      'content-length': '4',
      etag: '"version-1"'
    }).end(content)
  })
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))
  t.after(() => destination.close())
  const destinationUrl = `http://127.0.0.1:${(destination.address() as AddressInfo).port}/file.bin`

  const source = createServer((_request, response) => {
    response.writeHead(302, { location: destinationUrl }).end()
  })
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
  t.after(() => source.close())
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}/download`

  const dir = await mkdtemp(join(tmpdir(), 'draco-worker-redirect-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'part')
  const fh = await open(path, 'w+')
  t.after(() => fh.close())
  const auth = new HttpAuthenticator((url) => url === destinationUrl
    ? { username: 'reader', password: 'password' } : null)
  const segment = { start: 0, end: 3, position: 0, active: true }

  await runSegment(segment, {
    url: sourceUrl,
    headers: { cookie: 'source-session', authorization: 'Bearer captured', 'x-api-key': 'captured' },
    fh,
    limiter: new RateLimiter(),
    timeoutMs: 5000,
    retryLimit: 1,
    exponentialBackoff: false,
    expectedSize: 4,
    expectedEtag: '"version-1"',
    signal: new AbortController().signal,
    writeBufferBytes: 4,
    onBytes() {},
    auth
  })
  assert.equal(segment.position, 4)
  assert.deepEqual(await readFile(path), content)
  assert.equal(challenges, 1)
  assert.equal(leaked, 0)
})
