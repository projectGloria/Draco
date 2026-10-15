import { match, strictEqual, ok } from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createTask } from '../src/main/engine/create.ts'
import { DownloadManager, type EngineSettings } from '../src/main/engine/manager.ts'
import { sanitizeTasks } from '../src/main/store-sanitize.ts'
import type { DownloadTask, TaskStatus } from '../src/shared/types.ts'

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for task state')
}

async function scanningFixture(
  t: { after(fn: () => Promise<void>): void },
  scannerCode: string,
  existingQuarantine = false,
  stageGate?: () => Promise<void>
) {
  const dir = await mkdtemp(join(tmpdir(), 'draco-finalization-test-'))
  const file = join(dir, 'video.mp4')
  await writeFile(file, 'downloaded video')
  if (existingQuarantine) await writeFile(file + '.quarantine', 'earlier quarantined file')
  const settings: EngineSettings = {
    maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
    retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
    hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
    antivirusProgram: process.execPath, antivirusArgs: ['-e', scannerCode], antivirusTimeoutSeconds: 10
  }
  const statuses: TaskStatus[] = []
  let launches = 0
  let resolveSettled!: (task: DownloadTask) => void
  let resolveScanning!: () => void
  const settled = new Promise<DownloadTask>((resolve) => { resolveSettled = resolve })
  const scanning = new Promise<void>((resolve) => { resolveScanning = resolve })
  const manager = new DownloadManager({
    getSettings: () => settings,
    ...(stageGate ? { onFinalizationStage: stageGate } : {}),
    onTasks(tasks) {
      const task = tasks[0]
      if (!task) return
      statuses.push(task.status)
      if (task.status === 'scanning') resolveScanning()
      if (task.status === 'done' || task.status === 'error') resolveSettled(task)
    },
    onProgress() {},
    createHlsRunner(task, context) {
      return {
        task, running: false,
        async start() {
          launches++
          task.status = 'done'
          task.completedAt = Date.now()
          context.onFinished(task, null)
        },
        async pause() {}, tick() {}, async resetForRestart() { return false }
      }
    }
  })
  t.after(async () => {
    await manager.shutdown().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  const task = createTask({ url: 'https://example.test/video.m3u8', dir, filename: 'video.mp4', kind: 'hls' })
  manager.add(task)
  return { task, manager, file, statuses, settled, scanning, launches: () => launches }
}

it('announces completion only after a configured scanner succeeds', { timeout: 10_000 }, async (t) => {
  const fixture = await scanningFixture(t, 'setTimeout(() => process.exit(0), 80)')
  await fixture.scanning
  strictEqual(fixture.task.status, 'scanning')
  strictEqual(fixture.task.completedAt, null)
  await fixture.settled
  strictEqual(fixture.task.status, 'done')
  ok((fixture.task.completedAt ?? 0) > 0)
  ok(fixture.statuses.indexOf('scanning') < fixture.statuses.indexOf('done'))
})

it('commits the scanning stage before launching the scanner', { timeout: 10_000 }, async (t) => {
  let releaseStage!: () => void
  const gate = new Promise<void>((resolve) => { releaseStage = resolve })
  const fixture = await scanningFixture(
    t,
    "require('fs').writeFileSync(process.argv[1] + '.scanned', 'yes')",
    false,
    () => gate
  )
  await fixture.scanning
  try {
    strictEqual(await stat(fixture.file + '.scanned').catch(() => null), null)
    strictEqual(fixture.task.status, 'scanning')
  } finally {
    releaseStage()
  }
  await fixture.settled
  strictEqual(fixture.task.status, 'done')
  strictEqual(await readFile(fixture.file + '.scanned', 'utf8'), 'yes')
})

it('runs at most two final checks and Stop removes a waiting scan', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-finalization-pool-'))
  const tasks = ['first.mp4', 'second.mp4', 'third.mp4', 'fourth.mp4'].map((filename) =>
    createTask({ url: `https://example.test/${filename}`, dir, filename, kind: 'hls' }))
  for (const task of tasks) await writeFile(join(dir, task.filename), 'downloaded video')
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 4, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: process.execPath,
      antivirusArgs: ['-e', "require('fs').writeFileSync(process.argv[1]+'.started','yes');setTimeout(()=>process.exit(0),700)"],
      antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {},
    createHlsRunner(task, context) {
      return {
        task, running: false,
        async start() { task.status = 'done'; context.onFinished(task, null) },
        async pause() {}, tick() {}, async resetForRestart() { return false }
      }
    }
  })
  t.after(async () => {
    await manager.shutdown().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  for (const task of tasks) manager.add(task)
  await waitFor(async () => Boolean(
    await stat(join(dir, 'first.mp4.started')).catch(() => null) &&
    await stat(join(dir, 'second.mp4.started')).catch(() => null)
  ))
  strictEqual(tasks[2].status, 'scanning')
  strictEqual(tasks[2].detail, 'Waiting for final checks…')
  strictEqual(tasks[3].detail, 'Waiting for final checks…')
  strictEqual(await stat(join(dir, 'third.mp4.started')).catch(() => null), null)
  strictEqual(await stat(join(dir, 'fourth.mp4.started')).catch(() => null), null)
  await manager.pause([tasks[2].id], true)
  strictEqual(tasks[2].status, 'error')
  match(tasks[2].error ?? '', /before they could start/)
  await waitFor(() => tasks[0].status === 'done' && tasks[1].status === 'done')
  strictEqual(await stat(join(dir, 'third.mp4.started')).catch(() => null), null)
  await waitFor(() => tasks[3].status === 'done')
  strictEqual((await stat(join(dir, 'fourth.mp4.started'))).isFile(), true)
})

it('quit finishes active scans but cancels checks waiting for a slot', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-finalization-quit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const tasks = ['one.mp4', 'two.mp4', 'three.mp4'].map((filename) =>
    createTask({ url: `https://example.test/${filename}`, dir, filename, kind: 'hls' }))
  for (const task of tasks) await writeFile(join(dir, task.filename), 'downloaded video')
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 3, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: process.execPath,
      antivirusArgs: ['-e', "require('fs').writeFileSync(process.argv[1]+'.started','yes');setTimeout(()=>process.exit(0),700)"],
      antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {},
    createHlsRunner(task, context) {
      return {
        task, running: false,
        async start() { task.status = 'done'; context.onFinished(task, null) },
        async pause() {}, tick() {}, async resetForRestart() { return false }
      }
    }
  })
  for (const task of tasks) manager.add(task)
  await waitFor(async () => Boolean(
    await stat(join(dir, 'one.mp4.started')).catch(() => null) &&
    await stat(join(dir, 'two.mp4.started')).catch(() => null)
  ))
  await manager.shutdown()
  strictEqual(tasks[0].status, 'done')
  strictEqual(tasks[1].status, 'done')
  strictEqual(tasks[2].status, 'error')
  strictEqual(await stat(join(dir, 'three.mp4.started')).catch(() => null), null)
})

it('stops a scan cancelled while its stage is being saved', { timeout: 10_000 }, async (t) => {
  let releaseStage!: () => void
  const gate = new Promise<void>((resolve) => { releaseStage = resolve })
  const fixture = await scanningFixture(
    t,
    "require('fs').writeFileSync(process.argv[1] + '.scanned', 'yes')",
    false,
    () => gate
  )
  await fixture.scanning
  const stopping = fixture.manager.pause([fixture.task.id], true)
  releaseStage()
  await stopping
  strictEqual(fixture.task.status, 'error')
  match(fixture.task.error ?? '', /Final checks were interrupted/)
  strictEqual(await stat(fixture.file + '.scanned').catch(() => null), null)
  strictEqual((await stat(fixture.file)).isFile(), true)
})

it('quit does not launch a scan whose stage write is still pending', { timeout: 10_000 }, async (t) => {
  let releaseStage!: () => void
  const gate = new Promise<void>((resolve) => { releaseStage = resolve })
  const fixture = await scanningFixture(
    t,
    "require('fs').writeFileSync(process.argv[1] + '.scanned', 'yes')",
    false,
    () => gate
  )
  await fixture.scanning
  const quitting = fixture.manager.shutdown()
  releaseStage()
  await quitting
  strictEqual(fixture.task.status, 'error')
  strictEqual(fixture.task.finalizationStage, 'scanning')
  strictEqual(await stat(fixture.file + '.scanned').catch(() => null), null)
})

it('leaves the file unscanned when its scanning stage cannot be saved', { timeout: 10_000 }, async (t) => {
  const fixture = await scanningFixture(
    t,
    "require('fs').writeFileSync(process.argv[1] + '.scanned', 'yes')",
    false,
    async () => { throw new Error('disk full') }
  )
  await fixture.settled
  strictEqual(fixture.task.status, 'error')
  match(fixture.task.error ?? '', /Could not save the finalization stage: disk full/)
  strictEqual(await stat(fixture.file + '.scanned').catch(() => null), null)
  strictEqual((await stat(fixture.file)).isFile(), true)
})

it('keeps a captioned download processing until the sidecar is saved', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-captions-test-'))
  let releaseFetch!: () => void
  const gate = new Promise<void>((resolve) => { releaseFetch = resolve })
  t.mock.method(globalThis, 'fetch', async () => {
    await gate
    return new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello')
  })
  const task = createTask({
    url: 'https://example.test/video.m3u8', dir, filename: 'video.mp4', kind: 'hls',
    subtitles: [{ url: 'https://example.test/en.vtt', label: 'English', language: 'en', format: 'vtt' }]
  })
  await writeFile(join(dir, task.filename), 'downloaded video')
  const statuses: TaskStatus[] = []
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 10
    }),
    onTasks(tasks) {
      if (!tasks[0]) return
      statuses.push(tasks[0].status)
      if (tasks[0].status === 'done') resolveDone()
    },
    onProgress() {},
    createHlsRunner(task, context) {
      return {
        task, running: false,
        async start() { task.status = 'done'; context.onFinished(task, null) },
        async pause() {}, tick() {}, async resetForRestart() { return false }
      }
    }
  })
  t.after(async () => {
    releaseFetch()
    await manager.shutdown().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  manager.add(task)
  strictEqual(task.status, 'processing')
  strictEqual(task.completedAt, null)
  strictEqual(statuses.includes('done'), false)
  releaseFetch()
  await done
  strictEqual(task.status, 'done')
  match(await readFile(join(dir, 'video.en.vtt'), 'utf8'), /Hello/)
})

it('retries failed captions without downloading the media again', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-captions-failure-test-'))
  let englishRequests = 0
  let frenchRequests = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input).endsWith('/en.vtt')) {
      englishRequests++
      return new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nEnglish')
    }
    frenchRequests++
    return frenchRequests === 1
      ? new Response('gone', { status: 404 })
      : new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nRecovered')
  })
  const task = createTask({
    url: 'https://example.test/video.m3u8', dir, filename: 'video.mp4', kind: 'hls',
    subtitles: [
      { url: 'https://example.test/en.vtt', label: 'English', language: 'en', format: 'vtt' },
      { url: 'https://example.test/fr.vtt', label: 'French', language: 'fr', format: 'vtt' }
    ]
  })
  await writeFile(join(dir, task.filename), 'downloaded video')
  let resolveError!: () => void
  const failed = new Promise<void>((resolve) => { resolveError = resolve })
  let launches = 0
  const statuses: TaskStatus[] = []
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 10
    }),
    onTasks(tasks) {
      if (!tasks[0]) return
      statuses.push(tasks[0].status)
      if (tasks[0].status === 'error') resolveError()
    },
    onProgress() {},
    createHlsRunner(task, context) {
      return {
        task, running: false,
        async start() { launches++; task.status = 'done'; context.onFinished(task, null) },
        async pause() {}, tick() {}, async resetForRestart() { return false }
      }
    }
  })
  t.after(async () => {
    await manager.shutdown().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  manager.add(task)
  await failed
  strictEqual(task.status, 'error')
  match(task.error ?? '', /subtitle track\(s\) failed: French: HTTP 404/)
  strictEqual(task.completedAt, null)
  strictEqual(statuses.includes('done'), false)
  strictEqual((await stat(join(dir, task.filename))).isFile(), true)
  strictEqual(task.finalizationStage, 'processing')
  strictEqual(task.subtitleFiles?.[0], 'video.en.vtt')
  match(task.subtitleDigests?.[0] ?? '', /^[a-f0-9]{64}$/)
  const restored = sanitizeTasks(JSON.parse(JSON.stringify([task])), dir)[0]
  strictEqual(restored.subtitleFiles?.[0], 'video.en.vtt')
  strictEqual(restored.subtitleDigests?.[0], task.subtitleDigests?.[0])
  const unsafe = sanitizeTasks([{
    ...task, subtitleFiles: ['..\\elsewhere.vtt'], subtitleDigests: ['not-a-digest']
  }], dir)[0]
  strictEqual(unsafe.subtitleFiles?.[0], null)
  strictEqual(unsafe.subtitleDigests?.[0], null)
  await manager.shutdown()
  const restarted = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {}
  })
  t.after(() => restarted.shutdown().catch(() => {}))
  await restarted.load([restored])
  restarted.start([restored.id])
  await waitFor(() => restored.status === 'done')
  strictEqual(restored.finalizationStage, null)
  strictEqual(launches, 1)
  strictEqual(englishRequests, 1)
  strictEqual(frenchRequests, 2)
  match(await readFile(join(dir, 'video.en.vtt'), 'utf8'), /English/)
  match(await readFile(join(dir, 'video.fr.vtt'), 'utf8'), /Recovered/)
  strictEqual(await stat(join(dir, 'video.en (1).vtt')).catch(() => null), null)
})

it('quarantines a scanner failure without ever reporting completion', { timeout: 10_000 }, async (t) => {
  const fixture = await scanningFixture(t, 'process.exit(9)', true)
  await fixture.settled
  strictEqual(fixture.task.status, 'error')
  match(fixture.task.error ?? '', /Security scan failed/)
  strictEqual(fixture.statuses.includes('done'), false)
  strictEqual(await readFile(fixture.file + '.quarantine', 'utf8'), 'earlier quarantined file')
  strictEqual(await readFile(fixture.file + ' (1).quarantine', 'utf8'), 'downloaded video')
})

it('ends in error if a scanner fails after the destination disappears', { timeout: 10_000 }, async (t) => {
  const fixture = await scanningFixture(t, 'setTimeout(() => process.exit(9), 150)')
  await fixture.scanning
  await rm(fixture.task.dir, { recursive: true, force: true })
  await fixture.settled
  strictEqual(fixture.task.status, 'error')
  match(fixture.task.error ?? '', /[Cc]ould not quarantine the file/)
  strictEqual(fixture.statuses.includes('done'), false)
})

it('waits for a cancelled scan before leaving the task stopped', { timeout: 10_000 }, async (t) => {
  const fixture = await scanningFixture(t, 'setTimeout(() => process.exit(0), 8000)')
  await fixture.scanning
  await new Promise((resolve) => setTimeout(resolve, 100))
  await fixture.manager.pause([fixture.task.id], true)
  strictEqual(fixture.task.status, 'error')
  match(fixture.task.error ?? '', /scan was interrupted/)
  strictEqual((await stat(fixture.file)).isFile(), true)
  strictEqual(fixture.statuses.includes('done'), false)
  await fixture.manager.remove([fixture.task.id], true)
  strictEqual(await stat(fixture.file).catch(() => null), null)
})

it('retries an interrupted scan without relaunching the media runner', { timeout: 10_000 }, async (t) => {
  const fixture = await scanningFixture(t,
    "const fs=require('fs');const marker=process.argv[1]+'.attempt';if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');setTimeout(()=>process.exit(0),8000)}else{fs.writeFileSync(process.argv[1]+'.scanned','yes')}"
  )
  await fixture.scanning
  await waitFor(async () => Boolean(await stat(fixture.file + '.attempt').catch(() => null)))
  await fixture.manager.pause([fixture.task.id], true)
  strictEqual(fixture.task.finalizationStage, 'scanning')
  fixture.manager.start([fixture.task.id])
  await waitFor(() => fixture.task.status === 'done')
  strictEqual(fixture.task.finalizationStage, null)
  strictEqual(fixture.launches(), 1)
  strictEqual(await readFile(fixture.file + '.scanned', 'utf8'), 'yes')
})

it('marks an interrupted finalization as needing recovery on restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-finalization-restore-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const task = createTask({ url: 'https://example.test/video.mp4', dir, filename: 'video.mp4' })
  task.status = 'scanning'
  task.completedAt = null
  await writeFile(join(dir, task.filename), 'downloaded video')
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {}
  })
  await manager.load([task])
  strictEqual(task.status, 'error')
  strictEqual(task.finalizationStage, 'scanning')
  match(task.error ?? '', /Final checks were interrupted/)
  strictEqual(task.completedAt, null)
  manager.start([task.id])
  await waitFor(() => Boolean(task.error?.includes('scanner is no longer available')))
  strictEqual(task.status, 'error')
  strictEqual(task.finalizationStage, 'scanning')
  manager.dispose()
})

it('does not start a media transfer when the pending finalization file is missing', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-finalization-missing-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const task = createTask({ url: 'https://example.test/video.mp4', dir, filename: 'video.mp4' })
  task.status = 'error'
  task.finalizationStage = 'scanning'
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: process.execPath,
      antivirusArgs: ['-e', "require('fs').writeFileSync(process.argv[1]+'.scanned','yes')"],
      antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {}
  })
  t.after(() => manager.shutdown().catch(() => {}))
  await manager.load([task])
  manager.start([task.id])
  await waitFor(() => Boolean(task.error?.includes('completed media file is missing')))
  strictEqual(task.status, 'error')
  strictEqual(task.finalizationStage, 'scanning')
  strictEqual(await stat(join(dir, 'video.mp4.scanned')).catch(() => null), null)
})

it('restores a pending scan and retries it from the completed file', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-finalization-retry-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const original = createTask({ url: 'https://example.test/video.mp4', dir, filename: 'video.mp4' })
  original.status = 'scanning'
  original.finalizationStage = 'scanning'
  await writeFile(join(dir, original.filename), 'downloaded video')
  const [task] = sanitizeTasks(JSON.parse(JSON.stringify([original])), dir)
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: process.execPath,
      antivirusArgs: ['-e', "require('fs').writeFileSync(process.argv[1]+'.scanned','yes')"],
      antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {}
  })
  t.after(() => manager.shutdown().catch(() => {}))
  await manager.load([task])
  strictEqual(task.status, 'error')
  strictEqual(task.finalizationStage, 'scanning')
  manager.start([task.id])
  await waitFor(() => task.status === 'done')
  strictEqual(await readFile(join(dir, 'video.mp4.scanned'), 'utf8'), 'yes')
  strictEqual(task.finalizationStage, null)
})

it('reuses a durable empty caption reservation after a crash', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-caption-reservation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const original = createTask({
    url: 'https://example.test/video.mp4', dir, filename: 'video.mp4',
    subtitles: [{ url: 'https://example.test/en.vtt', label: 'English', language: 'en', format: 'vtt' }]
  })
  original.status = 'processing'
  original.finalizationStage = 'processing'
  original.subtitleFiles = ['video.en.vtt']
  await writeFile(join(dir, original.filename), 'downloaded video')
  await writeFile(join(dir, 'video.en.vtt'), '')
  t.mock.method(globalThis, 'fetch', async () => new Response('WEBVTT\n\nRecovered'))
  const task = sanitizeTasks(JSON.parse(JSON.stringify([original])), dir)[0]
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {}
  })
  t.after(() => manager.shutdown().catch(() => {}))
  await manager.load([task])
  manager.start([task.id])
  await waitFor(() => task.status === 'done')
  match(await readFile(join(dir, 'video.en.vtt'), 'utf8'), /Recovered/)
  match(task.subtitleDigests?.[0] ?? '', /^[a-f0-9]{64}$/)
  strictEqual(await stat(join(dir, 'video.en (1).vtt')).catch(() => null), null)
})

it('refuses a changed sidecar without fetching or overwriting it', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-caption-integrity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const task = createTask({
    url: 'https://example.test/video.mp4', dir, filename: 'video.mp4',
    subtitles: [{ url: 'https://example.test/en.vtt', label: 'English', language: 'en', format: 'vtt' }]
  })
  task.status = 'error'
  task.finalizationStage = 'processing'
  task.subtitleFiles = ['video.en.vtt']
  task.subtitleDigests = [createHash('sha256').update('original caption').digest('hex')]
  await writeFile(join(dir, task.filename), 'downloaded video')
  await writeFile(join(dir, 'video.en.vtt'), 'user changed caption')
  let fetched = false
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('should not fetch') })
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {}
  })
  t.after(() => manager.shutdown().catch(() => {}))
  await manager.load([task])
  manager.start([task.id])
  await waitFor(() => Boolean(task.error?.includes('saved caption changed on disk')))
  strictEqual(task.status, 'error')
  strictEqual(fetched, false)
  strictEqual(await readFile(join(dir, 'video.en.vtt'), 'utf8'), 'user changed caption')
})

it('validates a legacy sidecar against its source before adopting a digest', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-caption-legacy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const task = createTask({
    url: 'https://example.test/video.mp4', dir, filename: 'video.mp4',
    subtitles: [{ url: 'https://example.test/en.vtt', label: 'English', language: 'en', format: 'vtt' }]
  })
  task.status = 'error'
  task.finalizationStage = 'processing'
  task.subtitleFiles = ['video.en.vtt']
  task.subtitleDigests = []
  await writeFile(join(dir, task.filename), 'downloaded video')
  await writeFile(join(dir, 'video.en.vtt'), 'WEBVTT\n\nOld caption')
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response('WEBVTT\n\nOld caption')
  })
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
      retryLimit: 0, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
      hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
      antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 10
    }),
    onTasks() {}, onProgress() {}
  })
  t.after(() => manager.shutdown().catch(() => {}))
  await manager.load([task])
  manager.start([task.id])
  await waitFor(() => task.status === 'done')
  strictEqual(requests, 1)
  match(task.subtitleDigests?.[0] ?? '', /^[a-f0-9]{64}$/)
  strictEqual(await stat(join(dir, 'video.en (1).vtt')).catch(() => null), null)
})
