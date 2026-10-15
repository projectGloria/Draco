import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { DownloadManager } from '../../src/main/engine/manager.ts'
import { createTask } from '../../src/main/engine/create.ts'

// Local, deterministic HTTP workload. No public site or existing user profile.
const outputArg = process.argv.find((arg) => arg.startsWith('--output='))
const outputPath = outputArg ? resolve(outputArg.slice('--output='.length)) : null
const size = 8 * 1024 * 1024
const responseChunkBytes = 64 * 1024
const responseChunkDelayMs = 3
const body = Buffer.allocUnsafe(size)
for (let index = 0; index < size; index++) body[index] = index % 251
const expectedDigest = createHash('sha256').update(body).digest('hex')
const root = await mkdtemp(join(tmpdir(), 'draco-http-bench-'))
const temporaryRoot = resolve(tmpdir()) + sep
if (!resolve(root).startsWith(temporaryRoot)) throw new Error('Benchmark temporary directory escaped the system temp root')

const server = createServer((request, response) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range ?? ''))
  const start = range ? Number(range[1]) : 0
  const end = range ? (range[2] ? Number(range[2]) : size - 1) : size - 1
  if (start < 0 || end >= size || start > end) {
    response.writeHead(416, { 'content-range': `bytes */${size}` })
    response.end()
    return
  }
  const bytes = body.subarray(start, end + 1)
  response.setHeader('accept-ranges', 'bytes')
  response.setHeader('etag', '"bench-fixed-body"')
  response.setHeader('content-type', 'application/octet-stream')
  response.setHeader('content-length', String(bytes.length))
  if (range) response.setHeader('content-range', `bytes ${start}-${end}/${size}`)
  response.writeHead(range ? 206 : 200)
  if (request.method === 'HEAD') response.end()
  else {
    counters.requests++
    if (range) {
      counters.rangeRequests++
      counters.ranges.push({ start, end })
    }
    else counters.wholeGetRequests++
    // Pace each response so a cancelled split stops the original range before
    // the whole body has already been queued into the loopback socket.
    let offset = 0
    let timer = null
    let closed = false
    response.on('close', () => {
      closed = true
      if (timer) clearTimeout(timer)
    })
    const writeNext = () => {
      if (closed) return
      if (offset >= bytes.length) { response.end(); return }
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + responseChunkBytes))
      offset += chunk.length
      counters.responseBodyBytesWritten += chunk.length
      const ready = response.write(chunk)
      if (ready) timer = setTimeout(writeNext, responseChunkDelayMs)
      else response.once('drain', () => { timer = setTimeout(writeNext, responseChunkDelayMs) })
    }
    writeNext()
  }
})
const counters = { requests: 0, rangeRequests: 0, wholeGetRequests: 0, responseBodyBytesWritten: 0, ranges: [] }
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const address = server.address()
const base = `http://127.0.0.1:${address.port}`

async function runCase(count) {
  counters.requests = 0
  counters.rangeRequests = 0
  counters.wholeGetRequests = 0
  counters.responseBodyBytesWritten = 0
  counters.ranges = []
  const dir = join(root, `tasks-${count}`)
  const terminal = new Set()
  let resolveDone
  let rejectDone
  const completed = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const settings = {
    maxConcurrentTasks: count,
    maxConnectionsPerTask: 4,
    minSplitSize: 64 * 1024,
    retryLimit: 2,
    timeoutMs: 20_000,
    speedLimit: null,
    proxyUrl: null,
    hostConnectionLimits: [],
    quotaBytes: null,
    quotaWindowMinutes: 60,
    antivirusProgram: null,
    antivirusArgs: [],
    antivirusTimeoutSeconds: 30,
    tempDir: dir
  }
  const manager = new DownloadManager({
    getSettings: () => settings,
    onProgress: () => {},
    onTasks: (tasks) => {
      for (const task of tasks) {
        if (task.status !== 'done' && task.status !== 'error') continue
        terminal.add(task.id)
        if (task.status === 'error') rejectDone(new Error(`${task.filename}: ${task.error}`))
      }
      if (terminal.size === count) resolveDone()
    }
  })
  const tasks = Array.from({ length: count }, (_, index) => createTask({
    url: `${base}/file-${index}.bin`, dir, filename: `file-${index}.bin`
  }))
  for (const task of tasks) manager.add(task, false)

  let peakHeap = 0
  let peakRss = 0
  const sample = setInterval(() => {
    const memory = process.memoryUsage()
    peakHeap = Math.max(peakHeap, memory.heapUsed)
    peakRss = Math.max(peakRss, memory.rss)
  }, 50)
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()
  const cpuStart = process.cpuUsage()
  const start = performance.now()
  const timeout = setTimeout(() => rejectDone(new Error('Benchmark transfer timed out')), 120_000)
  try {
    manager.start(tasks.map((task) => task.id))
    await completed
    const elapsedSeconds = (performance.now() - start) / 1000
    const cpu = process.cpuUsage(cpuStart)
    const outputs = await Promise.all(tasks.map((task) => readFile(join(dir, task.filename))))
    for (const output of outputs) {
      if (createHash('sha256').update(output).digest('hex') !== expectedDigest) {
        throw new Error('Downloaded bytes differed from fixture')
      }
    }
    return {
      concurrentTasks: count,
      connectionsPerTask: settings.maxConnectionsPerTask,
      taskBytes: size,
      outputBytes: outputs.reduce((total, output) => total + output.length, 0),
      serverResponseBodyBytesWritten: counters.responseBodyBytesWritten,
      requests: counters.requests,
      rangeRequests: counters.rangeRequests,
      ranges: counters.ranges,
      wholeGetRequests: counters.wholeGetRequests,
      elapsedSeconds,
      outputThroughputMiBPerSecond: (count * size) / 1024 / 1024 / elapsedSeconds,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      peakHeapBytes: peakHeap,
      peakRssBytes: peakRss,
      eventLoopDelayP95Ms: lag.percentile(95) / 1e6
    }
  } finally {
    clearTimeout(timeout)
    clearInterval(sample)
    lag.disable()
    await manager.shutdown().catch(() => {})
  }
}

try {
  const cases = []
  for (const count of [1, 2, 4, 8]) cases.push(await runCase(count))
  const result = {
    scope: 'Local HTTP TaskRunner transfer; excludes browser UI, HLS, MPD, and torrent traffic',
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version
    },
    fixture: { bodyBytes: size, content: 'byte i modulo 251', rangeSupport: true, etag: 'fixed', responseChunkBytes, responseChunkDelayMs, counts: [1, 2, 4, 8] },
    cases
  }
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n')
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  await new Promise((done) => server.close(done))
  await rm(root, { recursive: true, force: true })
}
