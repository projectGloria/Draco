import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { request } from 'undici'
import { closeDispatchers, getDispatcher, setProxyUrl } from '../src/main/engine/http.ts'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('HTTP requests can be routed through the configured proxy', async () => {
  const origin = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('through proxy')
  })
  const originPort = await listen(origin)

  let connected = false
  const proxy = http.createServer()
  proxy.on('connect', (request_, client, head) => {
    connected = true
    const [host, rawPort] = request_.url.split(':')
    const upstream = net.connect(Number(rawPort), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
  })
  const proxyPort = await listen(proxy)

  try {
    setProxyUrl(`http://127.0.0.1:${proxyPort}`)
    const response = await request(`http://127.0.0.1:${originPort}/file`, {
      dispatcher: getDispatcher(5_000)
    })
    assert.equal(response.statusCode, 200)
    assert.equal(await response.body.text(), 'through proxy')
    assert.equal(connected, true)
  } finally {
    setProxyUrl(null)
    await closeDispatchers()
    await close(proxy)
    await close(origin)
  }
})
