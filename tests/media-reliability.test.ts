import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createCipheriv } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { build } from 'esbuild'
import { parseMaster, parseMediaPlaylist } from '../src/main/hls/playlist-parser.ts'
import { resolveTwitterPost, tokenForTweet } from '../src/main/twitter.ts'
import { resolveSuno } from '../src/main/suno.ts'
import { createTask } from '../src/main/engine/create.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { taskWorkspaceDir } from '../src/main/engine/workspace.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'
import { headersForResource } from '../src/main/fetch-guard.ts'
import { downloadSubtitles } from '../src/main/media/subtitles.ts'
import { mux } from '../src/main/hls/mux.ts'

const execute = promisify(execFile)
const ffmpegPath = resolve('resources/runtime/ffmpeg.exe')

async function bundledModule(entry: string, replacements: Record<string, string>, extra = ''): Promise<any> {
  const bundle = await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'isolated-media-dependencies', setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async (args) => {
        const name = args.path.replace(/\\/g, '/').split('/').pop()!
        if (replacements[name]) return { contents: replacements[name], loader: 'ts' }
        if (extra && args.path.replace(/\\/g, '/').endsWith(entry.replace(/\\/g, '/'))) {
          return { contents: await readFile(args.path, 'utf8') + extra, loader: 'ts' }
        }
        return undefined
      })
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fake-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'fake-electron' }, () => ({ contents: `
        export const safeStorage = {
          isEncryptionAvailable: () => true,
          encryptString: value => Buffer.from(value),
          decryptString: value => value.toString()
        }`, loader: 'js' }))
    } }]
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return module.exports
}

test('modern X snowflake IDs reach the photo resolver without forwarding X cookies', async (t) => {
  const id = '1891234567890123456'
  ok(tokenForTweet(id), 'a current 19-digit post must have a syndication token')
  for (const invalid of ['', '0', '-1', '1e18', 'NaN', '123bad']) strictEqual(tokenForTweet(invalid), '')
  let requested = ''
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    requested = url.href
    strictEqual(new Headers(options.headers).get('cookie'), null)
    return Response.json({ mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/photo.jpg' }] })
  })
  const result = await resolveTwitterPost(`https://x.com/alice/status/${id}`, { cookie: 'private=Xsession' })
  strictEqual(new URL(requested).searchParams.get('id'), id)
  strictEqual(result?.variants[0].container, 'jpg')
  match(result!.variants[0].url, /name=orig/)
})

test('HLS audio renditions accept TYPE at any attribute position', () => {
  const variants = parseMaster('#EXTM3U\n#EXT-X-MEDIA:GROUP-ID="sound",NAME="English",URI="audio.m3u8",TYPE=AUDIO,DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=2000,AUDIO="sound"\nvideo.m3u8\n', 'https://media.test/master.m3u8')
  strictEqual(variants[0].audioUrl, 'https://media.test/audio.m3u8')
  strictEqual(variants[0].audioTracks?.[0].isDefault, true)
})

test('Suno share redirects resolve the canonical song ID before using the audio fallback', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    const response = new Response('<meta property="og:audio" content="https://cdn1.suno.ai/silence.mp3">')
    Object.defineProperty(response, 'url', { value: 'https://suno.com/song/real-song-uuid' })
    return response
  })
  const song = await resolveSuno('https://suno.com/s/share-id', undefined)
  strictEqual(song.id, 'real-song-uuid')
  strictEqual(song.variants[0].url, 'https://cdn1.suno.ai/real-song-uuid.mp3')
})

test('HLS parsing refuses documents and unsafe resource addresses before fetching', () => {
  throws(() => parseMediaPlaylist('<html>login required</html>', 'https://media.test/list'), /did not return an HLS playlist/)
  throws(() => parseMediaPlaylist('#EXTM3U\n#EXTINF:2,\nhttp://127.0.0.1/admin\n#EXT-X-ENDLIST', 'https://media.test/list'), /private network/)
  throws(() => parseMediaPlaylist('#EXTM3U\nfile:///C:/private.txt\n#EXT-X-ENDLIST', 'https://media.test/list'), /unsupported address/)
  throws(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init"\n#EXTINF:2,\npart\n#EXT-X-ENDLIST', 'https://media.test/list'), /explicit IV/)
  const encrypted = parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x00000000000000000000000000000001\n#EXT-X-MAP:URI="init"\n#EXTINF:2,\npart\n#EXT-X-ENDLIST', 'https://media.test/list')
  strictEqual(encrypted.initSegment?.key?.url, 'https://media.test/key')
})

test('manifest resources receive captured credentials only on their original origin', () => {
  const headers = { Cookie: 'session=secret', Authorization: 'Bearer secret', 'X-Api-Key': 'secret', 'User-Agent': 'Draco', Range: 'bytes=0-100' }
  deepStrictEqual(headersForResource('https://media.test/part', 'https://media.test/list', headers), headers)
  deepStrictEqual(headersForResource('https://cdn.test/part', 'https://media.test/list', headers), { 'User-Agent': 'Draco', Range: 'bytes=0-100' })
})

test('rejected caption bodies are canceled and foreign caption servers receive no session secrets', async (t) => {
  let canceled = false
  t.mock.method(globalThis, 'fetch', async (_url: URL, options: RequestInit) => {
    const headers = new Headers(options.headers)
    strictEqual(headers.get('cookie'), null)
    strictEqual(headers.get('authorization'), null)
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('error page')) },
      cancel() { canceled = true }
    }), { status: 503 })
  })
  const task = createTask({ url: 'https://media.test/video.mp4', dir: tmpdir(), headers: { cookie: 'secret', authorization: 'Bearer secret' }, subtitles: [{ url: 'https://captions.test/file.vtt', language: 'en', label: 'English', format: 'vtt' }] })
  const result = await downloadSubtitles(task, new RateLimiter(), 5000)
  strictEqual(result.warnings.length, 1)
  strictEqual(canceled, true)
})

test('a failed media process finishes output cleanup before reporting its failure', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'draco-process-audit-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const inputPath = join(work, 'input.ts')
  const outputPath = join(work, 'output.mp4')
  await writeFile(inputPath, 'source')
  await writeFile(outputPath, 'interrupted output')
  await rejects(mux({ ffmpegPath: join(work, 'missing-ffmpeg.exe'), inputPath, outputPath, signal: new AbortController().signal }))
  await rejects(stat(outputPath), { code: 'ENOENT' })
})

test('credential changes commit after persistence and remain isolated by server port', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'draco-credential-audit-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const credentialPath = join(work, 'credentials.json')
  const credentials = await bundledModule('src/main/credentials.ts', {
    'paths.ts': `export function getPaths() { return { credentialsFile: ${JSON.stringify(credentialPath)} } }`
  })
  await credentials.loadCredentials()
  const first = await credentials.saveCredential({ host: 'https://media.test:8443/path', username: 'alice', password: 'secret' })
  strictEqual(first.host, 'media.test:8443')
  strictEqual(credentials.resolveCredentials('https://media.test/file', ''), null)
  strictEqual(credentials.resolveCredentials('https://media.test:8443/file', '').password, 'secret')
  await rm(credentialPath)
  await mkdir(credentialPath)
  await rejects(credentials.saveCredential({ host: 'other.test', username: 'bob', password: 'secret2' }))
  await rejects(credentials.removeCredential(first.id))
  deepStrictEqual(credentials.listCredentials().map((item: any) => item.host), ['media.test:8443'])
  await rm(credentialPath, { recursive: true })
  await Promise.all([
    credentials.saveCredential({ host: 'one.test', username: 'a', password: 'p' }),
    credentials.saveCredential({ host: 'two.test', username: 'b', password: 'q' })
  ])
  deepStrictEqual(JSON.parse(await readFile(credentialPath, 'utf8')).entries.map((item: any) => item.host), ['media.test:8443', 'one.test', 'two.test'])
})

test('credentials recover a synced backup and refuse to replace unreadable saved passwords', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'draco-credential-recovery-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const path = join(work, 'credentials.json')
  const credentials = await bundledModule('src/main/credentials.ts', {
    'paths.ts': `export function getPaths() { return { credentialsFile: ${JSON.stringify(path)} } }`
  })
  await credentials.loadCredentials()
  await credentials.saveCredential({ host: 'media.test', username: 'alice', password: 'secret' })
  await writeFile(path, '{broken')
  await credentials.loadCredentials()
  strictEqual(credentials.resolveCredentials('https://media.test/file', '').password, 'secret')
  await writeFile(path + '.bak', '{also broken')
  await rejects(credentials.loadCredentials(), /saved state/)
  await rejects(credentials.saveCredential({ host: 'other.test', username: 'bob', password: 'new' }), /saved state/)
  strictEqual(await readFile(path, 'utf8'), '{broken')
})

test('FFmpeg archive disk failures reject through the pipeline', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'draco-archive-audit-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(10_000_001)))
  const tools = await bundledModule('src/main/hls/ffmpeg.ts', {
    'paths.ts': 'export function getPaths() { return {} }'
  }, '\nexport { download as downloadArchive }\n')
  await rejects(tools.downloadArchive('https://media.test/build.zip', work), /EISDIR|EPERM|EACCES/)
})

test('fragmented MP4 HLS preserves every frame and never adopts pieces without a valid identity', async (t) => {
  try { await stat(ffmpegPath) } catch { t.skip('bundled FFmpeg is unavailable'); return }
  const work = await mkdtemp(join(tmpdir(), 'draco-fmp4-audit-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const fixture = join(work, 'fixture')
  await mkdir(fixture)
  await execute(ffmpegPath, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '3', '-c:v', 'libx264', '-g', '10', '-sc_threshold', '0', '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4', '-hls_list_size', '0', join(fixture, 'media.m3u8')], { windowsHide: true, cwd: fixture })
  const server = createServer(async (request, response) => {
    const name = (request.url ?? '').slice(1)
    if (!/^[\w.-]+$/.test(name)) { response.writeHead(404).end(); return }
    try { response.end(await readFile(join(fixture, name))) } catch { response.writeHead(404).end() }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => { await closeDispatchers(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) })
  const media = await bundledModule('src/main/hls/runner.ts', {
    'ffmpeg.ts': `export async function ensureFfmpeg() { return ${JSON.stringify(ffmpegPath)} }`
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/media.m3u8`
  for (const mode of ['missing', 'corrupt', 'encrypted']) {
    if (mode === 'encrypted') {
      const key = Buffer.alloc(16, 9)
      const iv = Buffer.alloc(16, 1)
      const playlistPath = join(fixture, 'media.m3u8')
      const playlist = await readFile(playlistPath, 'utf8')
      const names = ['init.mp4', ...playlist.split(/\r?\n/).filter((line) => line.endsWith('.m4s'))]
      for (const name of names) {
        const cipher = createCipheriv('aes-128-cbc', key, iv)
        await writeFile(join(fixture, name), Buffer.concat([cipher.update(await readFile(join(fixture, name))), cipher.final()]))
      }
      await writeFile(join(fixture, 'key.bin'), key)
      await writeFile(playlistPath, playlist.replace('#EXTM3U', `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString('hex')}`))
    }
    const dir = join(work, mode)
    await mkdir(dir)
    const task = createTask({ url, dir, filename: 'film.mp4' })
    const parts = join(taskWorkspaceDir(dir, task.id), 'film.mp4.dracoparts')
    await mkdir(parts, { recursive: true })
    await writeFile(join(parts, 'video_000000.part'), 'stale recording')
    if (mode === 'corrupt') await writeFile(join(parts, '.playlist.json'), 'not valid JSON')
    let finishedError: Error | null = null
    const runner = new media.HlsRunner(task, { maxConnections: 2, retryLimit: 1, timeoutMs: 5000 }, {
      limiter: new RateLimiter(), onUpdate() {}, onFinished(_task: unknown, error: Error | null) { finishedError = error }
    })
    await runner.start()
    strictEqual(finishedError, null)
    strictEqual(task.status, 'done', task.error ?? '')
    strictEqual(task.description, '', 'the mux must succeed rather than silently preserving a raw fallback')
    strictEqual(task.filename, 'film.mp4')
    const decoded = await execute(ffmpegPath, ['-nostdin', '-hide_banner', '-i', join(dir, task.filename), '-map', '0:v', '-f', 'null', '-'], { windowsHide: true })
    match(decoded.stderr, /frame=\s*30\b/)
  }
})

test('Best available DASH saves the highest rendition as one video track', async (t) => {
  try { await stat(ffmpegPath) } catch { t.skip('bundled FFmpeg is unavailable'); return }
  const work = await mkdtemp(join(tmpdir(), 'draco-dash-audit-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const fixture = join(work, 'fixture')
  await mkdir(fixture)
  await execute(ffmpegPath, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '3', '-map', '0:v', '-map', '0:v', '-s:v:0', '32x32', '-s:v:1', '64x64', '-c:v', 'libx264', '-g', '10', '-sc_threshold', '0', '-f', 'dash', '-seg_duration', '1', join(fixture, 'media.mpd')], { windowsHide: true, cwd: fixture })
  const server = createServer(async (request, response) => {
    const name = (request.url ?? '').slice(1)
    if (!/^[\w.-]+$/.test(name)) { response.writeHead(404).end(); return }
    try { response.end(await readFile(join(fixture, name))) } catch { response.writeHead(404).end() }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => { await closeDispatchers(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) })
  const media = await bundledModule('src/main/dash/runner.ts', {
    'ffmpeg.ts': `export async function ensureFfmpeg() { return ${JSON.stringify(ffmpegPath)} }`
  })
  const task = createTask({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/media.mpd`, dir: work, filename: 'film.mp4' })
  let finishedError: Error | null = null
  const runner = new media.MpdRunner(task, {
    limiter: new RateLimiter(), maxConnections: 2, minSplitSize: 1024, retryLimit: 1, timeoutMs: 5000, proxyUrl: null,
    onUpdate() {}, onFinished(_task: unknown, error: Error | null) { finishedError = error }
  })
  await runner.start()
  strictEqual(finishedError, null)
  strictEqual(task.status, 'done', task.error ?? '')
  const decoded = await execute(ffmpegPath, ['-nostdin', '-hide_banner', '-i', join(work, task.filename), '-map', '0:v', '-f', 'null', '-'], { windowsHide: true })
  const input = decoded.stderr.split('Stream mapping:')[0]
  strictEqual((input.match(/Stream #0:\d+/g) ?? []).length, 1)
  match(input, /64x64/)
  match(decoded.stderr, /frame=\s*30\b/)
})

test('DASH media socket stalls end in error within the configured network timeout', async (t) => {
  try { await stat(ffmpegPath) } catch { t.skip('bundled FFmpeg is unavailable'); return }
  const work = await mkdtemp(join(tmpdir(), 'draco-dash-stall-audit-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const manifest = '<MPD type="static" mediaPresentationDuration="PT1S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-live:2011"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="0" bandwidth="1000" width="64" height="64" codecs="avc1.64000a"><SegmentTemplate timescale="1" duration="1" initialization="init.mp4" media="chunk-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>'
  const server = createServer((request, response) => {
    if (request.url === '/media.mpd') response.end(manifest)
    else { response.writeHead(200); response.flushHeaders() }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(async () => { await closeDispatchers(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) })
  const media = await bundledModule('src/main/dash/runner.ts', {
    'ffmpeg.ts': `export async function ensureFfmpeg() { return ${JSON.stringify(ffmpegPath)} }`
  })
  const task = createTask({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/media.mpd`, dir: work, filename: 'film.mp4' })
  const runner = new media.MpdRunner(task, {
    limiter: new RateLimiter(), maxConnections: 2, minSplitSize: 1024, retryLimit: 1, timeoutMs: 100, proxyUrl: null,
    onUpdate() {}, onFinished() {}
  })
  const watchdog = setTimeout(() => { void runner.pause() }, 5000)
  try {
    await runner.start()
    strictEqual(task.status, 'error', 'a stalled engine must fail rather than requiring the watchdog to stop it')
  } finally {
    clearTimeout(watchdog)
    if (runner.running) await runner.pause()
  }
})
