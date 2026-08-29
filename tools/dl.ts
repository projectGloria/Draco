/**
 * Terminal harness for the download engine.
 *
 *   node tools/dl.ts <url> [--dir DIR] [--conn N] [--limit BYTES_PER_SEC]
 *                          [--min-split BYTES] [--tasks N]
 *
 * The point of this file is to make the engine verifiable before any UI exists:
 * it prints the live segment table, so you can watch ranges get split off and
 * handed to freed connections, and confirm a Ctrl-C resumes at the right offsets.
 *
 * Runs directly under Node's type stripping - no build step.
 */
import { createTask, validateUrl } from '../src/main/engine/create.ts'
import { DownloadManager, type EngineSettings } from '../src/main/engine/manager.ts'
import { Segmenter } from '../src/main/engine/segmenter.ts'
import type { DownloadTask } from '../src/shared/types.ts'

const args = process.argv.slice(2)
const urls: string[] = []
const flags = new Map<string, string>()

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg.startsWith('--')) {
    flags.set(arg.slice(2), args[++i] ?? '')
  } else {
    urls.push(arg)
  }
}

if (urls.length === 0) {
  console.error('usage: node tools/dl.ts <url> [--dir DIR] [--conn N] [--limit BPS]')
  process.exit(1)
}

const settings: EngineSettings = {
  maxConcurrentTasks: Number(flags.get('tasks') ?? 3),
  maxConnectionsPerTask: Number(flags.get('conn') ?? 8),
  minSplitSize: Number(flags.get('min-split') ?? 1024 * 1024),
  retryLimit: 5,
  timeoutMs: 30_000,
  speedLimit: flags.has('limit') ? Number(flags.get('limit')) : null
}

const dir = flags.get('dir') || process.cwd()
/** Test affordance: take the graceful pause path after N seconds. */
const stopAfter = flags.has('stop-after') ? Number(flags.get('stop-after')) : null

const manager = new DownloadManager({
  getSettings: () => settings,
  onTasks: (tasks) => {
    latest = tasks
  },
  onProgress: () => render()
})

let latest: DownloadTask[] = []
let lastLineCount = 0

const tasks = urls.map((url) => createTask({ url: validateUrl(url), dir }))
for (const task of tasks) manager.add(task)

function bytes(n: number | null): string {
  if (n === null) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function duration(seconds: number | null): string {
  if (seconds === null) return '--:--'
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

function bar(fraction: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function render(): void {
  const lines: string[] = []

  for (const task of latest) {
    const pct = task.size ? task.received / task.size : 0
    lines.push(
      `${task.filename}  ${bytes(task.received)} / ${bytes(task.size)}  ` +
        `${task.status}${task.resumable ? '' : ' (no-resume)'}`
    )
    lines.push(
      `  ${bar(pct)} ${(pct * 100).toFixed(1)}%  ` +
        `${bytes(task.speed)}/s  eta ${duration(task.eta)}  ` +
        `${task.segments.filter((s) => s.active).length}/${task.connections} conn`
    )

    for (const [i, seg] of task.segments.entries()) {
      const total = seg.end < 0 ? 0 : seg.end - seg.start + 1
      const done = seg.position - seg.start
      const frac = total > 0 ? done / total : 0
      lines.push(
        `    seg${String(i).padStart(2)} ${bar(frac, 16)} ` +
          `${String(Math.round(frac * 100)).padStart(3)}%  ` +
          `${seg.start}-${seg.end < 0 ? '?' : seg.end}  ` +
          `left ${bytes(Segmenter.remaining(seg) === Infinity ? null : Segmenter.remaining(seg))}` +
          `${seg.active ? '  <' : ''}`
      )
    }

    if (task.error) lines.push(`  error: ${task.error}`)
    lines.push('')
  }

  // Redraw in place rather than scrolling the terminal.
  if (lastLineCount > 0) process.stdout.write(`[${lastLineCount}A[0J`)
  process.stdout.write(lines.join('\n') + '\n')
  lastLineCount = lines.length + 1
}

let finished = false
setInterval(() => {
  render()
  const allDone = latest.length > 0 && latest.every((t) => t.status === 'done' || t.status === 'error')
  if (allDone && !finished) {
    finished = true
    render()
    const failed = latest.filter((t) => t.status === 'error')
    process.exit(failed.length > 0 ? 1 : 0)
  }
}, 500)

// Ctrl-C must flush the journals, otherwise the whole point of the resume test
// is lost - the run would look resumable but have nothing to resume from.
let stopping = false

function gracefulStop(): void {
  if (stopping) process.exit(130)
  stopping = true
  console.log('\npausing and flushing journals...')
  void manager.shutdown().then(() => {
    render()
    console.log('paused. run the same command again to resume.')
    process.exit(130)
  })
}

process.on('SIGINT', gracefulStop)

// Same path as Ctrl-C, on a timer, so the resume test is reproducible instead of
// depending on how fast a human can hit the key.
if (stopAfter !== null) setTimeout(gracefulStop, stopAfter * 1000)
