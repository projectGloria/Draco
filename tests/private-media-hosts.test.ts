import { createServer, type Server } from 'node:http'
import { rejects, strictEqual, throws, doesNotThrow } from 'node:assert/strict'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { closeDispatchers, hostResolvesPrivate, setDnsLookup } from '../src/main/engine/http.ts'
import { documentIsPrivate, fetchGuarded } from '../src/main/fetch-guard.ts'
import { parseMaster, parseMediaPlaylist } from '../src/main/hls/playlist-parser.ts'
import { inspectMpd } from '../src/main/dash/manifest.ts'
import { DashRunner } from '../src/main/hls/dash.ts'
import { createTask } from '../src/main/engine/create.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'

/**
 * A LAN media server is commonly reached by a name (`nas.local`, `jellyfin`)
 * that resolves to a private address. The private-network guard exists to stop
 * a *public* document from steering Draco into the LAN, so a document that was
 * itself served from the LAN may point at the LAN.
 */

const ADDRESSES: Record<string, string> = {
  'nas.test': '127.0.0.1',
  'lan.test': '192.168.1.20',
  'public.test': '93.184.216.34'
}

function fakeLookup(host: string, options: any, callback?: any): void {
  const cb = typeof options === 'function' ? options : callback
  const all = typeof options === 'object' && options?.all
  const address = ADDRESSES[host]
  if (!address) {
    const error = Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
    return void cb(error)
  }
  if (all) cb(null, [{ address, family: 4 }])
  else cb(null, address, 4)
}

before(() => setDnsLookup(fakeLookup as any))
after(async () => {
  setDnsLookup(null)
  await closeDispatchers()
})

describe('hostResolvesPrivate', () => {
  it('answers by where a name resolves, not just how it is spelled', async () => {
    strictEqual(await hostResolvesPrivate('127.0.0.1'), true)
    strictEqual(await hostResolvesPrivate('nas.test'), true)
    strictEqual(await hostResolvesPrivate('lan.test'), true)
    strictEqual(await hostResolvesPrivate('public.test'), false)
    strictEqual(await hostResolvesPrivate('unknown.test'), false, 'a lookup failure grants nothing')
  })
})

describe('HLS playlists from a private host', () => {
  const list = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://192.168.1.20/key",IV=0x00000000000000000000000000000001\n#EXTINF:2,\nhttp://192.168.1.20/seg0.ts\n#EXT-X-ENDLIST'

  it('still refuses private segments and keys named by a public playlist', () => {
    throws(() => parseMediaPlaylist(list, 'https://public.test/list.m3u8'), /private network/)
    throws(() => parseMediaPlaylist(list, 'https://public.test/list.m3u8', { basePrivate: false }), /private network/)
  })

  it('accepts them when the playlist itself came from a private host', () => {
    const parsed = parseMediaPlaylist(list, 'http://nas.test/list.m3u8', { basePrivate: true })
    strictEqual(parsed.segments[0].url, 'http://192.168.1.20/seg0.ts')
    strictEqual(parsed.segments[0].key?.url, 'http://192.168.1.20/key')
  })

  it('applies the same rule to variant URLs in a master playlist', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttp://192.168.1.20/v.m3u8'
    throws(() => parseMaster(master, 'https://public.test/master.m3u8'), /private network/)
    doesNotThrow(() => parseMaster(master, 'http://nas.test/master.m3u8', { basePrivate: true }))
  })
})

describe('DASH manifests from a private host', () => {
  const mpd = (inner: string) => `<?xml version="1.0"?><MPD mediaPresentationDuration="PT10S">${inner}<Period><AdaptationSet contentType="video"><Representation id="v" bandwidth="1" height="720"/></AdaptationSet></Period></MPD>`

  it('accepts a private BaseURL from a manifest served by a private host', () => {
    doesNotThrow(() => inspectMpd(mpd('<BaseURL>http://192.168.1.20/media/</BaseURL>'), { url: 'http://nas.test/a.mpd', private: true }))
  })

  it('refuses a private BaseURL, or an absolute private SegmentTemplate, from a public manifest', () => {
    throws(() => inspectMpd(mpd('<BaseURL>http://192.168.1.20/media/</BaseURL>'), { url: 'https://public.test/a.mpd' }), /private BaseURL/)
    throws(
      () => inspectMpd(mpd('<SegmentTemplate media="http://127.0.0.1/seg-$Number%05d$.m4s" initialization="init.mp4"/>'), { url: 'https://public.test/a.mpd' }),
      /private BaseURL/
    )
  })

  it('refuses non-HTTP addresses whatever the manifest host', () => {
    throws(() => inspectMpd(mpd('<BaseURL>file:///C:/secret/</BaseURL>'), { url: 'http://nas.test/a.mpd', private: true }), /invalid or private/)
  })
})

describe('fetchGuarded redirects that start on a private host', () => {
  let server: Server
  let port: number
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/end` })
        res.end()
      } else {
        res.end('ok')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  after(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('follows a LAN redirect when the caller found the start host private', async () => {
    const response = await fetchGuarded(`http://nas.test:${port}/start`, { startsPrivate: true })
    strictEqual(response.status, 200)
    strictEqual(await response.text(), 'ok')
  })

  it('never re-resolves the start host itself, so a rebinding name gains nothing', async () => {
    await rejects(fetchGuarded(`http://nas.test:${port}/start`), /private network/)
  })

  it('judges a redirected document by the start origin, not by re-resolving the final host', () => {
    strictEqual(documentIsPrivate('http://nas.test/a.m3u8', 'http://nas.test/b.m3u8', true), true)
    strictEqual(documentIsPrivate('http://nas.test/a.m3u8', 'http://public.test/b.m3u8', true), false)
    strictEqual(documentIsPrivate('https://public.test/a.m3u8', 'http://192.168.1.20/b.m3u8', false), true)
    strictEqual(documentIsPrivate('https://public.test/a.m3u8', 'https://public.test/b.m3u8', false), false)
  })
})

describe('DashRunner keeps the parent folder fixed while the halves download', () => {
  it('reports the probed size without calling the refiling onProbed hook', () => {
    const task = createTask({ url: 'https://public.test/v.mp4', dir: tmpdir(), filename: 'clip.mp4', kind: 'dash' as any })
    task.audioUrl = 'https://public.test/a.m4a'
    let probed = 0
    let updates = 0
    const context: any = {
      limiter: new RateLimiter(null),
      maxConnections: 4,
      connectionCeiling: 4,
      minSplitSize: 1024 * 1024,
      retryLimit: 1,
      timeoutMs: 30_000,
      tempDir: tmpdir(),
      proxyUrl: null,
      onUpdate: () => { updates++ },
      onFinished: () => {},
      onProbed: () => { probed++ }
    }
    const runner = new DashRunner(task, context) as any
    runner.videoRunner.task.size = 100
    runner.audioRunner.task.size = 20
    runner.videoRunner.deps.onProbed(runner.videoRunner.task)
    strictEqual(probed, 0, 'refiling mid-download would move parent.dir away from the halves')
    strictEqual(task.size, 120)
    strictEqual(updates > 0, true)
  })
})
