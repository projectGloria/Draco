import { randomUUID } from 'node:crypto'
import type {
  Category,
  ClipboardItem,
  ColumnPref,
  DownloadTask,
  Queue,
  SiteGrabProject,
  Settings
} from '@shared/types'
import type { QuotaState } from './engine/limiter.ts'
import { getPaths } from './bootstrap/paths.ts'
import { readJson, readJsonOrThrowIfPresent, writeJsonAtomic } from './json-file.ts'
import { electronJsonCipher } from './electron-json-cipher.ts'
import { readSealedJsonFile, sealJson } from './sealed-json.ts'
import { defaultCategories } from './categories.ts'
import {
  sanitizeCategories,
  sanitizeQueues,
  sanitizeSettings,
  sanitizeTasks
} from './store-sanitize.ts'

/**
 * Small JSON-file store. Writes go through a temp file + rename so a crash
 * mid-write cannot leave an unparseable file that bricks startup. Task records
 * are sealed before writing because URLs and request headers can contain tokens.
 *
 * Import convention in this project: `src/main/engine/**` uses relative `.ts`
 * specifiers so it runs bare under `node tools/dl.ts`; everything else in main
 * uses the `@shared` alias.
 */

/* ------------------------------------------------------------------ */
/* Clipboard inbox                                                     */
/* ------------------------------------------------------------------ */

export async function loadClipboardItems(): Promise<ClipboardItem[]> {
  const stored = await readJson<unknown>(getPaths().clipboardFile)
  if (!Array.isArray(stored)) {
    await writeJsonAtomic(getPaths().clipboardFile, [])
    return []
  }
  return stored.filter((item): item is ClipboardItem => {
    if (!item || typeof item !== 'object') return false
    const value = item as Partial<ClipboardItem>
    return typeof value.id === 'string' && typeof value.url === 'string' &&
      (value.status === 'fetching' || value.status === 'ready' || value.status === 'error')
  }).slice(-100)
}

export async function saveClipboardItems(items: ClipboardItem[]): Promise<void> {
  await writeJsonAtomic(getPaths().clipboardFile, items.slice(-100))
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
    checkDiskSpace: true,
    completionSound: true,
    catMode: false,
    maxConcurrentTasks: 3,
    exponentialBackoff: true,
    maxConnectionsPerTask: 8,
    adaptiveConnectionCeiling: null,
    minSplitSize: 1024 * 1024,
    speedLimit: null,
    scheduledLimit: null,
    // Seeding on, with a ratio target that ends it on its own. A default of
    // "seed forever" would be a background upload the user never asked for.
    seedTorrents: true,
    seedRatioLimit: 2,
    seedTimeMinutes: null,
    uploadLimit: null,
    proxyUrl: null,
    // Off by default: reading another program's cookie store is not something
    // to start doing without being asked.
    cookiesFromBrowser: 'none',
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
    watchClipboard: true,
    associateTorrents: true,
    cliOnPath: true,
    showDropzone: false,
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
let settingsSaveTail: Promise<void> = Promise.resolve()

export async function loadSettings(): Promise<Settings> {
  const base = defaultSettings()
  const [stored, clipboardInbox] = await Promise.all([
    readJsonOrThrowIfPresent<Partial<Settings>>(getPaths().settingsFile),
    readJson<unknown>(getPaths().clipboardFile)
  ])
  if (stored !== null && (typeof stored !== 'object' || Array.isArray(stored))) {
    throw new Error('Saved settings must be an object')
  }
  settings = stored ? sanitizeSettings(stored, base, defaultColumns) : base

  // The old clipboard monitor defaulted off because it opened a modal whenever
  // it noticed a link. The inbox is deliberately quiet, so enable it once when
  // this new persisted store is first introduced. Later user choices survive:
  // a missing or corrupt clipboard.json (antivirus quarantine, disk trouble)
  // must not re-enable the watcher over the user's explicit off.
  if (!Array.isArray(clipboardInbox) && stored === null) settings.watchClipboard = true

  // Migrate the file forward when a release adds settings, so the on-disk shape
  // matches what the app actually uses and stays hand-editable.
  await writeJsonAtomic(getPaths().settingsFile, settings)
  return settings
}

export function getSettings(): Settings {
  if (!settings) throw new Error('settings accessed before load')
  return settings
}

export function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  // Compute each patch against the last committed value. A failed write must
  // not become the in-memory setting or leak into a later, unrelated patch.
  const operation = settingsSaveTail.then(async () => {
    const next = sanitizeSettings({ ...getSettings(), ...patch }, defaultSettings(), defaultColumns)
    await writeJsonAtomic(getPaths().settingsFile, next)
    settings = next
    return next
  })
  settingsSaveTail = operation.then(() => {}, () => {})
  return operation
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

let categories: Category[] = []
let categoriesSaveTail: Promise<void> = Promise.resolve()

export async function loadCategories(): Promise<Category[]> {
  const stored = await readJsonOrThrowIfPresent<Category[]>(getPaths().categoriesFile)
  if (stored !== null && !Array.isArray(stored)) throw new Error('Saved categories must be a list')
  categories = Array.isArray(stored) && stored.length > 0 ? sanitizeCategories(stored, defaultCategories) : defaultCategories()
  await writeJsonAtomic(getPaths().categoriesFile, categories)
  return categories
}

export function getCategories(): Category[] {
  return categories
}

export function saveCategories(next: Category[]): Promise<Category[]> {
  const snapshot = sanitizeCategories(next, defaultCategories)
  const operation = categoriesSaveTail.then(async () => {
    await writeJsonAtomic(getPaths().categoriesFile, snapshot)
    categories = snapshot
    return snapshot
  })
  categoriesSaveTail = operation.then(() => {}, () => {})
  return operation
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export async function loadTasks(): Promise<DownloadTask[]> {
  const opened = await readSealedJsonFile(getPaths().tasksFile, electronJsonCipher)
  if (opened === null) return []
  if (!Array.isArray(opened.value)) throw new Error('Saved tasks must be a list')
  const tasks = sanitizeTasks(opened.value, getPaths().defaultDownloadDir)
  if (opened.legacy || opened.repairBackup) {
    // Replace both the primary and its backup. A normal atomic write would
    // preserve the old readable JSON as the backup during this migration.
    await writeJsonAtomic(getPaths().tasksFile, sealJson(tasks.map(persistable), electronJsonCipher), false, 'replace')
  }
  return tasks
}

let taskWriteTimer: NodeJS.Timeout | null = null
let pendingTasks: DownloadTask[] | null = null
let taskWritePromise: Promise<void> = Promise.resolve()
let taskWriteError: unknown = null
let taskWriteRevision = 0
let quotaWriteError: unknown = null
let persistenceErrorHandler: ((scope: 'tasks' | 'quota', error: unknown) => void) | null = null

export function setPersistenceErrorHandler(handler: ((scope: 'tasks' | 'quota', error: unknown) => void) | null): void {
  persistenceErrorHandler = handler
}

function queueTaskWrite(snapshot: DownloadTask[]): void {
  const revision = ++taskWriteRevision
  let write: Promise<void>
  try {
    write = writeJsonAtomic(getPaths().tasksFile,
      sealJson(snapshot.map(persistable), electronJsonCipher), false)
  } catch (error) {
    write = Promise.reject(error)
  }
  taskWritePromise = write
    .then(() => { taskWriteError = null }, (error: unknown) => {
      taskWriteError = error
      // A failed quit flush must retain its snapshot for the next quit attempt.
      // Do not requeue an older revision if a newer write is already queued or
      // a newer state snapshot is waiting for its coalescing timer.
      if (revision === taskWriteRevision && !pendingTasks) pendingTasks = snapshot
      persistenceErrorHandler?.('tasks', error)
    })
}

/**
 * How long task writes are coalesced for.
 *
 * The journals beside each part file - not this one - are what actually make a
 * download resumable, so this file being a few seconds stale costs nothing.
 * What it buys is that a busy app is not running a synchronous
 * `JSON.stringify` over the whole download list once a second on the same
 * thread that is draining sockets.
 */
const TASK_WRITE_COALESCE_MS = 4000

/**
 * The persistable shape of a task.
 *
 * `torrentInfo` is live diagnostics - a full file list plus a peer list - and
 * `sanitizeTasks` has never restored it, so every byte of it written here was
 * stringified and then discarded on the next launch. `speed` and `eta` are
 * likewise recomputed the moment a task runs again. Dropping the three keeps
 * the write proportional to what is actually read back.
 */
function persistable(task: DownloadTask): DownloadTask {
  const { torrentInfo: _torrentInfo, ...rest } = task
  return { ...rest, speed: 0, eta: null } as DownloadTask
}

/**
 * Coalesces task writes. Statuses change on every segment completion, and
 * rewriting the whole list each time would put the disk on the hot path for no
 * benefit.
 */
export function persistTasks(tasks: DownloadTask[]): void {
  pendingTasks = tasks
  if (taskWriteTimer) return

  taskWriteTimer = setTimeout(() => {
    taskWriteTimer = null
    const snapshot = pendingTasks
    pendingTasks = null
    if (!snapshot) return

    queueTaskWrite(snapshot)
  }, TASK_WRITE_COALESCE_MS)
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
    queueTaskWrite(snapshot)
  }
  await taskWritePromise
  if (taskWriteError) throw taskWriteError
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
  quotaWritePromise = writeJsonAtomic(getPaths().quotaFile, snapshot)
    .then(() => { quotaWriteError = null }, (error: unknown) => {
      quotaWriteError = error
      persistenceErrorHandler?.('quota', error)
    })
}

export async function flushQuotaState(): Promise<void> {
  await quotaWritePromise
  if (quotaWriteError) throw quotaWriteError
}

/* ------------------------------------------------------------------ */
/* Queues                                                              */
/* ------------------------------------------------------------------ */

export async function loadQueues(): Promise<Queue[]> {
  const stored = await readJsonOrThrowIfPresent<unknown>(getPaths().queuesFile)
  if (stored !== null && !Array.isArray(stored)) throw new Error('Saved queues must be a list')
  const sanitized = sanitizeQueues(stored)
  if (sanitized.length === 0) {
    const main: Queue = {
      id: randomUUID(),
      name: 'Main queue',
      taskIds: [],
      mode: 'manual',
      speedLimit: null,
      startTime: null,
      stopTime: null,
      days: [],
      maxConcurrent: 1,
      parallelismConfigured: true,
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
