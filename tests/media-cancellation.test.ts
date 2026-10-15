import { rejects, strictEqual } from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { build } from 'esbuild'
import { loadMediaPlaylist, resolveVariants } from '../src/main/hls/playlist.ts'
import { resolveMpd } from '../src/main/dash/manifest.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'
import { createTask } from '../src/main/engine/create.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

test('playlist and MPD requests abort while their bodies are stalled', async () => {
  let arrived!: () => void
  let arrival = new Promise<void>((resolve) => { arrived = resolve })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('stalled manifest')
    arrived()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manifest`
  try {
    for (const mode of ['hls', 'mpd']) {
      arrival = new Promise<void>((resolve) => { arrived = resolve })
      const controller = new AbortController()
      const pending = mode === 'hls'
        ? loadMediaPlaylist(url, {}, { signal: controller.signal, timeoutMs: 5000 })
        : resolveMpd(url, {}, 5000, controller.signal)
      const checked = rejects(pending)
      await arrival
      controller.abort()
      await checked
    }
    await rejects(loadMediaPlaylist(url, {}, { timeoutMs: 50 }))
  } finally {
    await closeDispatchers()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('starting an HLS runner need not sample every rendition before selecting quality', async () => {
  let samples = 0
  const server = createServer((request, response) => {
    if (request.url === '/master') response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8\n')
    else { samples++; response.writeHead(500).end() }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const variants = await resolveVariants(`http://127.0.0.1:${(server.address() as AddressInfo).port}/master`, {}, { estimateSizes: false })
    strictEqual(variants.length, 1)
    strictEqual(samples, 0)
  } finally {
    await closeDispatchers()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('pausing a composite during file adoption waits for cleanup and starts no HTTP children', async () => {
  const bundle = await build({
    entryPoints: ['src/main/hls/dash.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'media-tools-stub', setup(build) {
      build.onLoad({ filter: /[\\/]ffmpeg\.ts$/ }, () => ({ contents: 'export async function ensureFfmpeg() { throw new Error("unexpected media tool") }', loader: 'js' }))
    } }]
  })
  const bundled = { exports: {} as { DashRunner?: any } }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), bundled, bundled.exports)
  const { DashRunner } = bundled.exports
  const task = createTask({ url: 'https://example.test/video', audioUrl: 'https://example.test/audio', dir: tmpdir(), filename: 'media.mp4' })
  let finished = 0
  const runner = new DashRunner(task, {
    limiter: new RateLimiter(), maxConnections: 2, minSplitSize: 1024, retryLimit: 1,
    timeoutMs: 1000, proxyUrl: null, onUpdate() {}, onFinished() { finished++ }
  })
  let release!: () => void
  const adoption = new Promise<boolean>((resolve) => { release = () => resolve(false) })
  runner.adoptFinishedHalf = () => adoption
  let starts = 0
  runner.videoRunner.start = async () => { starts++ }
  runner.audioRunner.start = async () => { starts++ }
  const started = runner.start()
  let paused = false
  const stop = runner.pause().then(() => { paused = true })
  await new Promise((resolve) => setImmediate(resolve))
  strictEqual(paused, false, 'the parent still has pending work')
  release()
  await Promise.all([started, stop])
  strictEqual(starts, 0)
  strictEqual(finished, 1)
  strictEqual(task.status, 'paused')
})
