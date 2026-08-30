import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  Category,
  ColumnPref,
  DownloadTask,
  Queue,
  SiteGrabProject,
  Settings
} from '@shared/types'
import type { QuotaState } from './engine/limiter.ts'
import { getPaths } from './bootstrap/paths.ts'
import { defaultCategories } from './categories.ts'
import {
  sanitizeCategories,
  sanitizeQueues,
  sanitizeSettings,
  sanitizeTasks
} from './store-sanitize.ts'

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
  // Use a unique temp path. Several IPC calls can legitimately persist the same
  // JSON file concurrently; a shared `<file>.tmp` lets one writer rename/remove
  // another writer's temp file and turns an otherwise valid save into ENOENT.
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
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
    language: 'system',
    theme: 'dark',
    downloadDir: getPaths().defaultDownloadDir,
    maxConcurrentTasks: 3,
    maxConnectionsPerTask: 8,
    minSplitSize: 1024 * 1024,
    speedLimit: null,
    proxyUrl: null,
    hostConnectionLimits: [],
    quotaBytes: null,
    quotaWindowMinutes: 60,
    antivirusProgram: null,
    antivirusArgs: ['{file}'],
    antivirusTimeoutSeconds: 120,
    updateFeedUrl: null,
    autoCheckUpdates: true,
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
    showProgressWindow: true,
    accent: '#38bdf8',
    columns: defaultColumns(),
    sortColumn: 'added',
    sortDirection: 'desc',
    sidebarSelection: 'all'
  }
}

// Persistence sanitizers live in a dependency-free helper so malformed on-disk
// JSON can be fuzzed independently of Electron startup.

let settings: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  const base = defaultSettings()
  const stored = await readJson<Partial<Settings>>(getPaths().settingsFile)
  settings = stored ? sanitizeSettings(stored, base, defaultColumns) : base

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
  settings = sanitizeSettings({ ...getSettings(), ...patch }, defaultSettings(), defaultColumns)
  await writeJsonAtomic(getPaths().settingsFile, settings)
  return settings
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

let categories: Category[] = []

export async function loadCategories(): Promise<Category[]> {
  const stored = await readJson<Category[]>(getPaths().categoriesFile)
  categories = Array.isArray(stored) && stored.length > 0 ? sanitizeCategories(stored, defaultCategories) : defaultCategories()
  await writeJsonAtomic(getPaths().categoriesFile, categories)
  return categories
}

export function getCategories(): Category[] {
  return categories
}

export async function saveCategories(next: Category[]): Promise<Category[]> {
  categories = sanitizeCategories(next, defaultCategories)
  await writeJsonAtomic(getPaths().categoriesFile, categories)
  return categories
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export async function loadTasks(): Promise<DownloadTask[]> {
  const stored = await readJson<unknown>(getPaths().tasksFile)
  return sanitizeTasks(stored, getPaths().defaultDownloadDir)
}

let taskWriteTimer: NodeJS.Timeout | null = null
let pendingTasks: DownloadTask[] | null = null
let taskWritePromise: Promise<void> | null = null

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
    if (!snapshot) return

    taskWritePromise = writeJsonAtomic(getPaths().tasksFile, snapshot)
      .catch(() => {})
      .finally(() => {
        taskWritePromise = null
      })
  }, 1000)
  taskWriteTimer.unref?.()
}

/** Forces the pending write out. Called on quit. */
export async function flushTasks(): Promise<void> {
  if (taskWriteTimer) {
    clearTimeout(taskWriteTimer)
    taskWriteTimer = null
  }

  if (taskWritePromise) {
    await taskWritePromise
  }

  if (pendingTasks) {
    const snapshot = pendingTasks
    pendingTasks = null
    await writeJsonAtomic(getPaths().tasksFile, snapshot).catch(() => {})
  }
}

/* ------------------------------------------------------------------ */
/* Transfer quota                                                      */
/* ------------------------------------------------------------------ */

let quotaWritePromise: Promise<void> = Promise.resolve()

export async function loadQuotaState(): Promise<QuotaState | null> {
  const raw = await readJson<unknown>(getPaths().quotaFile)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  if (!Number.isSafeInteger(source.used) || (source.used as number) < 0) return null
  if (typeof source.startedAt !== 'number' || !Number.isFinite(source.startedAt) || source.startedAt < 0) return null
  return { used: source.used as number, startedAt: source.startedAt }
}

export function persistQuotaState(state: QuotaState): void {
  const snapshot = { ...state }
  quotaWritePromise = quotaWritePromise
    .then(() => writeJsonAtomic(getPaths().quotaFile, snapshot))
    .catch(() => {})
}

export async function flushQuotaState(): Promise<void> {
  await quotaWritePromise
}

/* ------------------------------------------------------------------ */
/* Queues                                                              */
/* ------------------------------------------------------------------ */

export async function loadQueues(): Promise<Queue[]> {
  const stored = await readJson<unknown>(getPaths().queuesFile)
  const sanitized = sanitizeQueues(stored)
  if (sanitized.length === 0) {
    const main: Queue = {
      id: randomUUID(),
      name: 'Main queue',
      taskIds: [],
      mode: 'manual',
      startTime: null,
      stopTime: null,
      days: [],
      maxConcurrent: 3,
      retryLimit: 3,
      retryDelaySeconds: 30,
      onComplete: 'none',
      completionProgram: null,
      completionArgs: [],
      running: false,
      oneTimeCompleted: false,
      lastResult: 'idle'
    }
    await writeJsonAtomic(getPaths().queuesFile, [main])
    return [main]
  }
  // A queue cannot be running before the app that runs it has started.
  const queues = sanitized.map((q) => ({ ...q, running: false }))
  await writeJsonAtomic(getPaths().queuesFile, queues)
  return queues
}

export async function saveQueues(queues: Queue[]): Promise<void> {
  await writeJsonAtomic(getPaths().queuesFile, queues)
}

export async function loadSiteProjects(): Promise<SiteGrabProject[]> {
  const stored = await readJson<unknown>(getPaths().siteProjectsFile)
  if (!Array.isArray(stored)) return []
  const projects: SiteGrabProject[] = []
  for (const raw of stored.slice(0, 100)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const value = raw as Record<string, unknown>
    const options = value.options as Record<string, unknown> | undefined
    if (!options || typeof options.startUrl !== 'string') continue
    let parsed: URL
    try { parsed = new URL(options.startUrl) } catch { continue }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
    projects.push({
      id: typeof value.id === 'string' && value.id ? value.id.slice(0, 128) : randomUUID(),
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 100) : parsed.hostname,
      options: {
        startUrl: parsed.toString(),
        maxDepth: Math.min(5, Math.max(0, Math.round(Number(options.maxDepth)) || 0)),
        maxPages: Math.min(1000, Math.max(1, Math.round(Number(options.maxPages)) || 100)),
        includeAssets: options.includeAssets !== false,
        stayOnHost: options.stayOnHost !== false,
        respectRobots: options.respectRobots !== false,
        autoStart: options.autoStart === true,
        scheduleHours: typeof options.scheduleHours === 'number' && Number.isFinite(options.scheduleHours) && options.scheduleHours >= 1
          ? Math.min(24 * 30, Math.round(options.scheduleHours))
          : null
      },
      rootDir: typeof value.rootDir === 'string' ? value.rootDir.slice(0, 32768) : '',
      knownUrls: Array.isArray(value.knownUrls)
        ? [...new Set(value.knownUrls.filter((url): url is string => typeof url === 'string'))].slice(0, 10_000)
        : [],
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
      lastRunAt: typeof value.lastRunAt === 'number' ? value.lastRunAt : null,
      lastError: typeof value.lastError === 'string' ? value.lastError.slice(0, 2000) : null
    })
  }
  return projects
}

export async function saveSiteProjects(projects: SiteGrabProject[]): Promise<void> {
  await writeJsonAtomic(getPaths().siteProjectsFile, projects)
}

export { toFolderName } from './store-sanitize-path.ts'
