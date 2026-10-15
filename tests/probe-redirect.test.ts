import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { HttpAuthenticator } from '../src/main/engine/auth.ts'
import { probeUrl } from '../src/main/engine/probe.ts'

test('probe authenticates a redirected origin without forwarding captured headers', async (t) => {
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
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': '4', etag: '"version-1"' }).end()
      return
    }
    response.writeHead(206, {
      'content-length': '1',
      'content-range': 'bytes 0-0/4',
      etag: '"version-1"'
    }).end('d')
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
  const auth = new HttpAuthenticator((url) => url === destinationUrl
    ? { username: 'reader', password: 'password' } : null)

  const result = await probeUrl(sourceUrl, {
    fresh: true,
    auth,
    headers: { cookie: 'source-session', authorization: 'Bearer captured', extra: { 'X-Api-Key': 'captured' } }
  })
  assert.equal(result.finalUrl, destinationUrl)
  assert.equal(result.size, 4)
  assert.equal(result.resumable, true)
  assert.equal(challenges, 1)
  assert.equal(leaked, 0)
})
