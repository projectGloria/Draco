import { build } from 'esbuild'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { cpus, totalmem } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// This is a renderer-store CPU baseline, not a browser paint or transfer test.
// Run from the repository root with `npm run bench:list`.
const outputArg = process.argv.find((arg) => arg.startsWith('--output='))
const outputPath = outputArg ? resolve(outputArg.slice('--output='.length)) : null

const bundle = await build({
  stdin: {
    contents: "export { useApp, sortTasks } from './src/renderer/src/store/app.ts'",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  tsconfig: 'tsconfig.web.json'
})
const source = Buffer.from(bundle.outputFiles[0].text).toString('base64')
const { useApp, sortTasks } = await import(`data:text/javascript;base64,${source}`)

let onProgress = () => { throw new Error('Progress subscription was not installed') }
const api = {
  onTasksChanged() {},
  onProgress(callback) { onProgress = callback },
  onPlaylistProgress() {},
  onQueuesChanged() {},
  onPendingAction() {},
  onClipboardItemsChanged() {},
  getSettings: async () => useApp.getState().settings,
  listTasks: async () => [],
  listCategories: async () => [],
  listQueues: async () => [],
  listClipboardItems: async () => [],
  getIntegration: async () => null
}
Object.assign(globalThis, {
  window: { api },
  document: { documentElement: { style: { setProperty() {} } } }
})
await useApp.getState().init()

let sink = 0
const rounds = 12
const iterations = 250
const eventLoop = monitorEventLoopDelay({ resolution: 10 })
eventLoop.enable()
const cpuStart = process.cpuUsage()
const cases = []

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
}

async function measure(action) {
  const times = []
  for (let round = 0; round < rounds; round++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) action(i + round * iterations)
    const elapsed = performance.now() - start
    if (round > 1) times.push(elapsed / iterations) // JIT warm-up
    await new Promise((resolve) => setImmediate(resolve))
  }
  times.sort((a, b) => a - b)
  return {
    medianMsPerOperation: percentile(times, 0.5),
    p95MsPerOperation: percentile(times, 0.95)
  }
}

for (const count of [1, 10, 100, 1000]) {
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: `bench-${index}`,
    filename: `file-${String(count - index).padStart(4, '0')}.bin`,
    status: 'downloading',
    size: 1_000_000,
    received: 0,
    speed: index * 1000,
    eta: index,
    error: null,
    detail: null,
    createdAt: index,
    queueId: null,
    description: ''
  }))
  useApp.setState({ tasks })
  const nameSort = await measure(() => { sink += sortTasks(tasks, 'name', 'asc').length })
  const speedSort = await measure(() => { sink += sortTasks(tasks, 'speed', 'desc').length })
  const progressTick = await measure((iteration) => {
    onProgress([{
      id: tasks[0].id,
      received: iteration,
      size: 1_000_000,
      speed: iteration,
      eta: 100,
      status: 'downloading',
      error: null,
      detail: null
    }])
    sink += useApp.getState().tasks.length
  })
  cases.push({ count, nameSort, speedSort, oneTaskProgressTick: progressTick })
}

eventLoop.disable()
const cpu = process.cpuUsage(cpuStart)
const result = {
  scope: 'Node renderer-store sort and progress update; excludes React render, layout, paint, disk, and network',
  generatedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version
  },
  fixture: { counts: [1, 10, 100, 1000], rounds, iterationsPerRound: iterations, warmupRounds: 2 },
  cases,
  process: {
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    heapUsedBytes: process.memoryUsage().heapUsed,
    eventLoopDelayP95Ms: eventLoop.percentile(95) / 1e6
  },
  sink
}

if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n')
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
