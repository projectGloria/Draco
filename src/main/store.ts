import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  Category,
  ColumnPref,
  DownloadTask,
  MediaCandidate,
  Queue,
  Settings
} from '@shared/types'
import { getPaths } from './bootstrap/paths.ts'
import { defaultCategories } from './categories.ts'

/**
 * Small JSON-file store. Writes go through a temp file + rename so a crash
 * mid-write cannot leave an unparseable file that bricks startup.
 *
 * Import convention in this project: `src/main/engine/**` uses relative `.ts`
 * specifiers so it runs bare under `node tools/dl.ts`; everything else in main
 * uses the `@shared` alias.
 */

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function defaultColumns(): ColumnPref[] {
  return [
    { id: 'name', width: 320, visible: true },
    { id: 'size', width: 90, visible: true },
    { id: 'progress', width: 140, visible: true },
    { id: 'status', width: 110, visible: true },
    { id: 'eta', width: 80, visible: true },
    { id: 'speed', width: 100, visible: true },
    { id: 'queue', width: 100, visible: false },
    { id: 'added', width: 130, visible: true },
    { id: 'description', width: 200, visible: false }
  ]
}

export function defaultSettings(): Settings {
  return {
    downloadDir: getPaths().defaultDownloadDir,
    maxConcurrentTasks: 3,
    maxConnectionsPerTask: 8,
    minSplitSize: 1024 * 1024,
    speedLimit: null,
    retryLimit: 5,
    timeoutMs: 30_000,
    defaultCategoryId: null,
    confirmDelete: true,
    closeToTray: true,
    startMinimized: false,
    takeoverEnabled: true,
    confirmHandoff: true,
    takeoverMinSize: 1024 * 1024,
    takeoverExtensions: [],
    takeoverExcludeHosts: [],
    watchClipboard: false,
    accent: '#38bdf8',
    columns: defaultColumns(),
    sortColumn: 'added',
    sortDirection: 'desc',
    sidebarSelection: 'all'
  }
}

/** Clamps user-supplied values so a hand-edited settings file cannot break the app. */
function sanitizeSettings(input: Partial<Settings>, base: Settings): Settings {
  const merged = { ...base, ...input }

  const columns = Array.isArray(merged.columns) && merged.columns.length > 0
    ? mergeColumns(merged.columns)
    : defaultColumns()

  return {
    ...merged,
    downloadDir: merged.downloadDir?.trim() || base.downloadDir,
    // An unbounded connection count is a good way to get IP-banned; 16 is well
    // past the point where more connections stop helping anyway.
    maxConcurrentTasks: clamp(merged.maxConcurrentTasks, 1, 20, 3),
    maxConnectionsPerTask: clamp(merged.maxConnectionsPerTask, 1, 16, 8),
    minSplitSize: clamp(merged.minSplitSize, 64 * 1024, 256 * 1024 * 1024, 1024 * 1024),
    speedLimit:
      typeof merged.speedLimit === 'number' && merged.speedLimit > 0 ? merged.speedLimit : null,
    retryLimit: clamp(merged.retryLimit, 1, 20, 5),
    timeoutMs: clamp(merged.timeoutMs, 5_000, 300_000, 30_000),
    takeoverMinSize: clamp(merged.takeoverMinSize, 0, 1024 ** 4, 1024 * 1024),
    takeoverExtensions: toLowerList(merged.takeoverExtensions),
    takeoverExcludeHosts: toLowerList(merged.takeoverExcludeHosts),
    columns
  }
}

/** Keeps stored widths but guarantees every known column is present exactly once. */
function mergeColumns(stored: ColumnPref[]): ColumnPref[] {
  const defaults = defaultColumns()
  const byId = new Map(stored.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]))

  const ordered: ColumnPref[] = []
  for (const column of stored) {
    const known = defaults.find((d) => d.id === column?.id)
    if (known && !ordered.some((c) => c.id === known.id)) {
      ordered.push({
        id: known.id,
        width: clamp(column.width, 40, 1200, known.width),
        visible: column.visible !== false
      })
    }
  }

  // A column added in a later release would otherwise be invisible forever.
  for (const fallback of defaults) {
    if (!byId.has(fallback.id)) ordered.push(fallback)
  }

  return ordered
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function toLowerList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

let settings: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  const base = defaultSettings()
  const stored = await readJson<Partial<Settings>>(getPaths().settingsFile)
  settings = stored ? sanitizeSettings(stored, base) : base

  // Migrate the file forward when a release adds settings, so the on-disk shape
  // matches what the app actually uses and stays hand-editable.
  await writeJsonAtomic(getPaths().settingsFile, settings)
  return settings
}

export function getSettings(): Settings {
  if (!settings) throw new Error('settings accessed before load')
  return settings
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  settings = sanitizeSettings({ ...getSettings(), ...patch }, defaultSettings())
  await writeJsonAtomic(getPaths().settingsFile, settings)
  return settings
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

let categories: Category[] = []

export async function loadCategories(): Promise<Category[]> {
  const stored = await readJson<Category[]>(getPaths().categoriesFile)
  categories = Array.isArray(stored) && stored.length > 0 ? sanitizeCategories(stored) : defaultCategories()
  await writeJsonAtomic(getPaths().categoriesFile, categories)
  return categories
}

export function getCategories(): Category[] {
  return categories
}

export async function saveCategories(next: Category[]): Promise<Category[]> {
  categories = sanitizeCategories(next)
  await writeJsonAtomic(getPaths().categoriesFile, categories)
  return categories
}

function sanitizeCategories(input: unknown): Category[] {
  if (!Array.isArray(input)) return defaultCategories()

  const seen = new Set<string>()
  const result: Category[] = []

  for (const raw of input) {
    const candidate = raw as Partial<Category>
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : ''
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())

    result.push({
      id: typeof candidate.id === 'string' && candidate.id ? candidate.id : randomUUID(),
      name: name.slice(0, 60),
      folder: toFolderName(typeof candidate.folder === 'string' && candidate.folder ? candidate.folder : name),
      builtin: candidate.builtin === true,
      // Extensions are matched case-insensitively, so store them folded and
      // strip any leading dot the user typed out of habit.
      extensions: toLowerList(candidate.extensions).map((e) => e.replace(/^\./, ''))
    })
  }

  return result.length > 0 ? result : defaultCategories()
}

const ILLEGAL_PATH_CHARS = /[<>:"/\\|?*]/g
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Turns a category's display name into a subfolder name Windows will accept.
 * Reserved device names (CON, PRN, ...) are real and would fail at mkdir, and a
 * trailing dot or space is silently dropped by the OS - which would make the
 * folder we create and the folder we look for disagree.
 */
export function toFolderName(name: string): string {
  const printable = Array.from(name.trim())
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 32)
    .join('')

  const cleaned = printable
    .replace(ILLEGAL_PATH_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .slice(0, 60)
    .trim()

  if (!cleaned) return 'Untitled'
  if (RESERVED_DEVICE_NAMES.test(cleaned)) return cleaned + '_'
  return cleaned
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export async function loadTasks(): Promise<DownloadTask[]> {
  const stored = await readJson<DownloadTask[]>(getPaths().tasksFile)
  if (!Array.isArray(stored)) return []
  return stored.filter((t) => t && typeof t.id === 'string' && typeof t.url === 'string')
}

let taskWriteTimer: NodeJS.Timeout | null = null
let pendingTasks: DownloadTask[] | null = null

/**
 * Coalesces task writes. Statuses change on every segment completion, and
 * rewriting the whole list each time would put the disk on the hot path for no
 * benefit - a second of staleness costs nothing because the journals, not this
 * file, are what make a download resumable.
 */
export function persistTasks(tasks: DownloadTask[]): void {
  pendingTasks = tasks
  if (taskWriteTimer) return

  taskWriteTimer = setTimeout(() => {
    taskWriteTimer = null
    const snapshot = pendingTasks
    pendingTasks = null
    if (snapshot) void writeJsonAtomic(getPaths().tasksFile, snapshot).catch(() => {})
  }, 1000)
  taskWriteTimer.unref?.()
}

/** Forces the pending write out. Called on quit. */
export async function flushTasks(): Promise<void> {
  if (taskWriteTimer) {
    clearTimeout(taskWriteTimer)
    taskWriteTimer = null
  }
  if (pendingTasks) {
    const snapshot = pendingTasks
    pendingTasks = null
    await writeJsonAtomic(getPaths().tasksFile, snapshot).catch(() => {})
  }
}

/* ------------------------------------------------------------------ */
/* Queues                                                              */
/* ------------------------------------------------------------------ */

export async function loadQueues(): Promise<Queue[]> {
  const stored = await readJson<Queue[]>(getPaths().queuesFile)
  if (!Array.isArray(stored) || stored.length === 0) {
    const main: Queue = {
      id: randomUUID(),
      name: 'Main queue',
      taskIds: [],
      mode: 'manual',
      startTime: null,
      stopTime: null,
      days: [],
      maxConcurrent: 3,
      onComplete: 'none',
      running: false
    }
    await writeJsonAtomic(getPaths().queuesFile, [main])
    return [main]
  }
  // A queue cannot be running before the app that runs it has started.
  return stored.map((q) => ({ ...q, running: false }))
}

export async function saveQueues(queues: Queue[]): Promise<void> {
  await writeJsonAtomic(getPaths().queuesFile, queues)
}

/* ------------------------------------------------------------------ */
/* Media candidates                                                    */
/* ------------------------------------------------------------------ */

export async function loadMedia(): Promise<MediaCandidate[]> {
  const stored = await readJson<MediaCandidate[]>(getPaths().mediaFile)
  return Array.isArray(stored) ? stored : []
}

export async function saveMedia(media: MediaCandidate[]): Promise<void> {
  await writeJsonAtomic(getPaths().mediaFile, media)
}
