import { rejects, strictEqual } from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
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

test('DashRunner adopts a finished video half whose real size differs from the 88/12 estimate without re-downloading or creating (1) files (F-03)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-dash-adopt-'))
  let videoHits = 0
  let audioHits = 0
  const videoBytes = Buffer.alloc(9_123, 0x56)
  const audioBytes = Buffer.alloc(1_234, 0x41)
  const server = createServer((req, res) => {
    if (req.url === '/video') {
      videoHits++
      res.writeHead(200, { 'content-length': String(videoBytes.length), 'accept-ranges': 'bytes' })
      res.end(videoBytes)
    } else if (req.url === '/audio') {
      audioHits++
      res.writeHead(200, { 'content-length': String(audioBytes.length), 'accept-ranges': 'bytes' })
      res.end(audioBytes)
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const bundle = await build({
      entryPoints: ['src/main/hls/dash.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      write: false,
      define: { 'import.meta.env': '{}' },
      plugins: [{
        name: 'dash-mux-stub',
        setup(b) {
          b.onLoad({ filter: /[\\/]ffmpeg\.ts$/ }, () => ({
            contents: 'export async function ensureFfmpeg() { return "ffmpeg" }',
            loader: 'js'
          }))
          b.onLoad({ filter: /[\\/]mux\.ts$/ }, () => ({
            contents: `
              const { writeFile } = require('node:fs/promises');
              export const MUX_DETAIL = 'Muxing…';
              export async function mux({ outputPath }) { await writeFile(outputPath, Buffer.from('muxed')); }
            `,
            loader: 'js'
          }))
        }
      }]
    })
    const bundled = { exports: {} as { DashRunner?: any } }
    new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
      createRequire(import.meta.url),
      bundled,
      bundled.exports
    )
    const { DashRunner } = bundled.exports

    const task = createTask({
      url: `http://127.0.0.1:${port}/video`,
      audioUrl: `http://127.0.0.1:${port}/audio`,
      dir,
      filename: 'clip.mp4',
      expectedSize: 10_000,
      youtube: { pageUrl: 'https://www.youtube.com/watch?v=abc12345678', videoFormatId: '137', audioFormatId: '140' }
    })

    // Pre-place the finished video half (9,123 bytes != 8,800) as left after an audio failure
    const videoHalfPath = join(dir, 'clip.mp4.v.137.mp4')
    await writeFile(videoHalfPath, videoBytes)

    let finishedError: Error | null | undefined
    const runner = new DashRunner(task, {
      limiter: new RateLimiter(),
      maxConnections: 2,
      minSplitSize: 1024,
      retryLimit: 1,
      timeoutMs: 5000,
      proxyUrl: null,
      onUpdate() {},
      onFinished(_t: unknown, err: Error | null) { finishedError = err }
    })

    await runner.start()
    strictEqual(finishedError, null, 'retry should finish without error')
    strictEqual(task.status, 'done')
    strictEqual(videoHits, 0, 'finished video half must be adopted without re-downloading')
    strictEqual(audioHits > 0, true, 'missing audio half should be downloaded')

    const entries = await readdir(dir)
    strictEqual(entries.some((f) => f.includes('(1)')), false, `must not leave a (1) copy: ${entries.join(', ')}`)
    strictEqual(entries.includes('clip.mp4.v.137.mp4'), false, 'video half should be cleaned up after mux')
    strictEqual(entries.includes('clip.mp4'), true, 'final muxed file should exist')
  } finally {
    await closeDispatchers()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
