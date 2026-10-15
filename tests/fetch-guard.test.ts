import { rejects, strictEqual } from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { it } from 'node:test'
import { fetchGuarded, requestGuarded } from '../src/main/fetch-guard.ts'

it('strips credentials of any casing across origins but preserves them on same-origin hops', async (t) => {
  const requests: Headers[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(new Headers(init.headers))
    if (requests.length === 1) return new Response(null, {
      status: 302, headers: { location: '/next' }
    })
    if (requests.length === 2) return new Response(null, {
      status: 302, headers: { location: 'https://other.example/video' }
    })
    return new Response('video')
  })
  const headers = {
    Authorization: 'Bearer secret', Cookie: 'session=secret',
    'Proxy-Authorization': 'Basic secret', 'X-Api-Key': 'secret',
    'X-Media': 'private metadata', Accept: 'video/*', Range: 'bytes=0-10'
  }
  const response = await fetchGuarded('https://media.example/video', { headers })
  strictEqual(await response.text(), 'video')
  strictEqual(requests.length, 3)
  for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-media']) {
    strictEqual(requests[0].has(name), true)
    strictEqual(requests[1].has(name), true)
    strictEqual(requests[2].has(name), false)
  }
  strictEqual(requests[2].get('accept'), 'video/*')
  strictEqual(requests[2].get('range'), 'bytes=0-10')
  strictEqual(headers.Authorization, 'Bearer secret')
})

it('rejects a public redirect into localhost before connecting or forwarding credentials', async (t) => {
  const requested: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    requested.push(url.href)
    return new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/admin' }
    })
  })

  await rejects(
    fetchGuarded('https://public.example/media.m3u8', {
      headers: { Cookie: 'session=secret', Authorization: 'Bearer secret' }
    }),
    /redirect pointed into a private network/
  )
  strictEqual(requested.length, 1)
  strictEqual(requested[0], 'https://public.example/media.m3u8')
})

it('rejects non-HTTP redirects before connecting', async (t) => {
  let connections = 0
  t.mock.method(globalThis, 'fetch', async () => {
    connections++
    return new Response(null, { status: 302, headers: { location: 'file:///C:/secret' } })
  })
  await rejects(fetchGuarded('https://public.example/file'), /unsupported address/)
  strictEqual(connections, 1)
})

it('rejects HTTPS downgrades before connecting when required', async (t) => {
  let connections = 0
  t.mock.method(globalThis, 'fetch', async () => {
    connections++
    return new Response(null, { status: 302, headers: { location: 'http://other.example/file' } })
  })
  await rejects(
    fetchGuarded('https://releases.example/file', { requireHttps: true }),
    /downgraded a secure request/
  )
  strictEqual(connections, 1)
})

it('follows a real same-origin redirect with the shared dispatcher', async (t) => {
  let forwardedCookie: string | undefined
  const server = createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: '/payload' }).end()
      return
    }
    forwardedCookie = request.headers.cookie
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ready')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = (server.address() as AddressInfo).port
  const response = await fetchGuarded(`http://127.0.0.1:${port}/start`, {
    headers: { Cookie: 'session=example' }
  })
  strictEqual(await response.text(), 'ready')
  strictEqual(forwardedCookie, 'session=example')
  strictEqual(new URL(response.url).pathname, '/payload')
})

it('streams an undici request across origins without forwarding captured secrets', async (t) => {
  let destinationCookie: string | undefined
  let destinationSecret: string | undefined
  const destination = createServer((request, response) => {
    destinationCookie = request.headers.cookie
    destinationSecret = request.headers['x-api-key'] as string | undefined
    response.writeHead(206, { 'content-range': 'bytes 0-0/1' }).end('x')
  })
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))
  t.after(() => destination.close())
  const destinationUrl = `http://127.0.0.1:${(destination.address() as AddressInfo).port}/file`
  const source = createServer((_request, response) => {
    response.writeHead(302, { location: destinationUrl }).end()
  })
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
  t.after(() => source.close())

  const result = await requestGuarded(`http://127.0.0.1:${(source.address() as AddressInfo).port}/start`, {
    method: 'GET', headers: { Cookie: 'source-only', 'X-Api-Key': 'secret', Range: 'bytes=0-0' }
  })
  strictEqual(result.response.statusCode, 206)
  strictEqual(await result.response.body.text(), 'x')
  strictEqual(result.finalUrl, destinationUrl)
  strictEqual(destinationCookie, undefined)
  strictEqual(destinationSecret, undefined)
})

it('follows a redirect without waiting for an unending redirect body', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/payload') { response.end('ready'); return }
    response.writeHead(302, { location: '/payload' })
    response.write('redirect body')
    const timer = setInterval(() => response.write('still streaming'), 25)
    response.on('close', () => clearInterval(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const result = await requestGuarded(`http://127.0.0.1:${(server.address() as AddressInfo).port}/start`, {
    signal: AbortSignal.timeout(1000), timeoutMs: 1000
  })
  strictEqual(await result.response.body.text(), 'ready')
})
