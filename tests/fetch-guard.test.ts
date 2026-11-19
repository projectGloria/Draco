import { rejects, strictEqual } from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { it } from 'node:test'
import { isPrivateHost } from '../src/main/engine/create.ts'
import { closeDispatchers, createSafeLookup, setDnsLookup, type LookupFn } from '../src/main/engine/http.ts'
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

it('does not let the dispatcher follow a redirect before the guard sees it', async (t) => {
  let secretHits = 0
  const secret = createServer((_request, response) => {
    secretHits++
    response.writeHead(200).end('secret')
  })
  await new Promise<void>((resolve) => secret.listen(0, '127.0.0.1', resolve))
  t.after(() => secret.close())
  const secretPort = (secret.address() as AddressInfo).port
  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${secretPort}/secret` }).end()
  })
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
  t.after(() => source.close())
  const sourcePort = (source.address() as AddressInfo).port

  await rejects(
    fetchGuarded(`http://127.0.0.1:${sourcePort}/start`, {
      pinHost: `127.0.0.1:${sourcePort}`,
      headers: { Cookie: 'session=secret' }
    }),
    /redirect left the original host/
  )
  strictEqual(secretHits, 0)
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

it('isPrivateHost avoids fc/fd domain false positives and catches IPv6/mapped/internal edge cases (F-02)', () => {
  // No false positives on domain names starting with fc/fd/fe
  strictEqual(isPrivateHost('fc.example.com'), false)
  strictEqual(isPrivateHost('fd00.example.com'), false)
  strictEqual(isPrivateHost('fe80.example.com'), false)
  strictEqual(isPrivateHost('93.184.216.34'), false)

  // Private / reserved IPv4, IPv6, mapped IPv6, and internal names
  for (const host of [
    'localhost', 'localhost.', 'sub.localhost', 'printer.local', 'meta.internal',
    '0.0.0.1', '10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '224.0.0.1',
    '::1', '::', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', 'fc00::1', 'fd12::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101', '0:0:0:0:0:ffff:7f00:1'
  ]) {
    strictEqual(isPrivateHost(host), true, `expected ${host} to be private`)
  }
})

it('blocks DNS resolution to 127.0.0.1, 192.168.x.x, ::1, mixed all:true arrays, and DNS rebinding (F-02)', async (t) => {
  let serverHits = 0
  const server = createServer((_req, res) => {
    serverHits++
    res.writeHead(200).end('secret')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  t.after(async () => {
    setDnsLookup(null)
    await closeDispatchers()
    server.closeAllConnections()
    server.close()
  })

  const dnsMap: Record<string, { address: string; family: number }> = {
    'loopback.example': { address: '127.0.0.1', family: 4 },
    'lan.example': { address: '192.168.1.42', family: 4 },
    'ipv6-loopback.example': { address: '::1', family: 6 }
  }
  const fakeLookup: LookupFn = (hostname, options, cb) => {
    const rec = dnsMap[hostname]
    if (!rec) {
      cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '')
      return
    }
    if ((options as { all?: boolean })?.all) {
      cb(null, [rec])
    } else {
      cb(null, rec.address, rec.family)
    }
  }
  setDnsLookup(fakeLookup)

  for (const host of ['loopback.example', 'lan.example', 'ipv6-loopback.example']) {
    await rejects(
      fetchGuarded(`http://${host}:${port}/secret`, { allowPrivate: false, timeoutMs: 2000 }),
      /private network addresses is not allowed/
    )
  }
  strictEqual(serverHits, 0, 'blocked DNS lookups must never reach the loopback server')

  // Unguarded (user-initiated LAN NAS download) still works when allowPrivate is not false
  const nasRes = await fetchGuarded(`http://loopback.example:${port}/nas-file`, { timeoutMs: 2000 })
  strictEqual(await nasRes.text(), 'secret')
  strictEqual(serverHits, 1)

  // all: true with mixed public + private addresses must fail closed
  const mixedLookup = createSafeLookup((_host, _opts, cb) => {
    cb(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ])
  })
  await rejects(
    new Promise((resolve, reject) => {
      mixedLookup('dual.example', { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)))
    }),
    /private network addresses is not allowed/
  )

  // DNS rebinding: first lookup public (allowed), second lookup private (blocked)
  let lookups = 0
  const rebindLookup = createSafeLookup((_host, _opts, cb) => {
    lookups++
    if (lookups === 1) cb(null, '93.184.216.34', 4)
    else cb(null, '127.0.0.1', 4)
  })
  const first = await new Promise<string>((resolve, reject) => {
    rebindLookup('rebind.example', {}, (err, addr) => (err ? reject(err) : resolve(addr as string)))
  })
  strictEqual(first, '93.184.216.34')
  await rejects(
    new Promise((resolve, reject) => {
      rebindLookup('rebind.example', {}, (err, addr) => (err ? reject(err) : resolve(addr)))
    }),
    /private network addresses is not allowed/
  )
})

it('blocks a redirect to a domain whose DNS resolves to 127.0.0.1 (F-02)', async (t) => {
  let secretHits = 0
  const server = createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: `http://rebind-target.example:${port}/secret` }).end()
      return
    }
    secretHits++
    res.writeHead(200).end('top-secret')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  t.after(async () => {
    setDnsLookup(null)
    await closeDispatchers()
    server.closeAllConnections()
    server.close()
  })

  // Public-looking redirector resolves to our local test server on hop 0 (simulated via unguarded),
  // then redirects cross-origin to rebind-target.example which resolves to 127.0.0.1 -> must be blocked!
  setDnsLookup((hostname, options, cb) => {
    const rec = { address: '127.0.0.1', family: 4 }
    if (hostname === 'public-start.example' || hostname === 'rebind-target.example') {
      if ((options as { all?: boolean })?.all) cb(null, [rec])
      else cb(null, rec.address, rec.family)
      return
    }
    cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '')
  })

  await rejects(
    fetchGuarded(`http://public-start.example:${port}/start`, { timeoutMs: 2000 }),
    /private network addresses is not allowed/
  )
  strictEqual(secretHits, 0, 'redirect to DNS-resolved private IP must be blocked before connecting')
})
