import { create } from 'zustand'
import type {
  Category,
  ClipboardItem,
  ColumnId,
  ColumnPref,
  DownloadTask,
  IntegrationStatus,
  PendingAction,
  PlaylistProgress,
  Queue,
  Settings,
  SortDirection,
  TaskProgress
} from '@shared/types'
import { pruneHistory, recordSpeed } from '../lib/history'
import { reportError } from './toasts'

/**
 * The renderer's whole view of the app. It owns no truth: every mutation goes
 * out over IPC and comes back through a subscription, so what is on screen is
 * always what the main process actually has.
 */

/**
 * `all` | `active` | `queued` | `attention` | `unfinished` |
 * `finished` | `grabber` | `cat:<id>` | `queue:<id>`.
 * Kept as a string because it round-trips through settings.json.
 */
export type SidebarKey = string

/**
 * Placeholder settings used for the handful of frames before the real ones
 * arrive over IPC. Having a value here rather than `null` keeps every consumer
 * free of a non-null assertion; the real defaults live in `main/store.ts`,
 * which is the only place that decides them.
 */
function provisionalSettings(): Settings {
  return {
    language: 'system',
    theme: 'dark',
    downloadDir: '',
    checkDiskSpace: true,
    completionSound: true,
    showDropzone: false,
    catMode: false,
    maxConcurrentTasks: 3,
    exponentialBackoff: true,
    maxConnectionsPerTask: 8,
    adaptiveConnectionCeiling: null,
    minSplitSize: 1024 * 1024,
    speedLimit: null,
    scheduledLimit: null,
    seedTorrents: true,
    seedRatioLimit: 2,
    seedTimeMinutes: null,
    uploadLimit: null,
    cookiesFromBrowser: 'none',
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
    takeoverMinSize: 1024 * 1024,
    confirmHandoff: true,
    takeoverExtensions: [],
    takeoverExcludeHosts: [],
    watchClipboard: true,
    associateTorrents: true,
    cliOnPath: true,
    showProgressWindow: true,
    accent: '#38bdf8',
    columns: [
      { id: 'name', width: 320, visible: true },
      { id: 'size', width: 90, visible: true },
      { id: 'progress', width: 140, visible: true },
      { id: 'status', width: 110, visible: true },
      { id: 'eta', width: 80, visible: true },
      { id: 'speed', width: 100, visible: true },
      { id: 'queue', width: 100, visible: false },
      { id: 'added', width: 130, visible: true },
      { id: 'description', width: 200, visible: false }
    ],
    sortColumn: 'added',
    sortDirection: 'desc',
    sidebarSelection: 'all'
  }
}

interface AppState {
  ready: boolean
  initializing: boolean
  initError: string | null
  tasks: DownloadTask[]
  clipboardItems: ClipboardItem[]
  /** Changes only when task membership or non-progress metadata changes. */
  taskListVersion: number
  categories: Category[]
  queues: Queue[]
  settings: Settings
  integration: IntegrationStatus | null
  pending: PendingAction | null
  /**
   * Playlist expansions still resolving, by group id. Each entry is a separate
   * yt-dlp lookup, so a long listing takes minutes and needs to say so.
   */
  playlists: Record<string, PlaylistProgress>
  /** Task ids, in click order; the last one anchors shift-select. */
  selection: string[]
  sidebar: SidebarKey

  init(): Promise<void>
  refreshIntegration(): Promise<void>
  saveCategories(categories: Category[]): Promise<boolean>

  setSidebar(key: SidebarKey): void
  setSelection(ids: string[]): void
  clickRow(id: string, modifiers: { ctrl: boolean; shift: boolean }, visible: DownloadTask[]): void
  selectAll(visible: DownloadTask[]): void

  /** True only after the settings write commits successfully. */
  patchSettings(patch: Partial<Settings>): Promise<boolean>
  setColumnWidth(id: ColumnId, width: number): void
  toggleColumn(id: ColumnId): void
  setSort(column: ColumnId): void
}

/**
 * Column widths change on every mousemove during a drag. The value is applied
 * locally at once and written to disk once the hand comes off the mouse.
 */
let settingsWriteTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Merged rather than replaced. Restarting the timer with only the newest patch
 * dropped the previous one outright, so resizing a column and then re-sorting
 * inside the same 400 ms lost the width.
 */
let settingsWritePatch: Partial<Settings> = {}
let settingsWriteTail: Promise<void> = Promise.resolve()
let settingsEditVersion = 0
let committedSettings: Settings | null = null

function persistSoon(patch: Partial<Settings>): void {
  settingsEditVersion++
  settingsWritePatch = { ...settingsWritePatch, ...patch }
  if (settingsWriteTimer) clearTimeout(settingsWriteTimer)
  settingsWriteTimer = setTimeout(() => {
    settingsWriteTimer = null
    const pending = settingsWritePatch
    settingsWritePatch = {}
    // A later immediate edit can change columns while this timer waits.
    const current = useApp.getState().settings
    if (pending.columns) pending.columns = current.columns
    if (pending.sortColumn) {
      pending.sortColumn = current.sortColumn
      pending.sortDirection = current.sortDirection
    }
    void useApp.getState().patchSettings(pending)
  }, 400)
}

/**
 * Whether a progress update changes anything the list actually draws.
 *
 * Every field of `TaskProgress` is compared, because every one of them is
 * rendered somewhere - the row, the status bar totals, or the group summary.
 * The point is not to guess which matter but to notice the very common case
 * where none of them moved.
 */
function progressDiffers(task: DownloadTask, update: TaskProgress): boolean {
  return (
    task.received !== update.received ||
    task.size !== update.size ||
    task.speed !== update.speed ||
    task.eta !== update.eta ||
    task.status !== update.status ||
    task.error !== update.error ||
    task.detail !== update.detail
  )
}

let initialized = false
let initPromise: Promise<void> | null = null
let taskEventVersion = 0
let queueEventVersion = 0
let clipboardEventVersion = 0
const startupProgress = new Map<string, TaskProgress>()

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  initializing: false,
  initError: null,
  tasks: [],
  clipboardItems: [],
  taskListVersion: 0,
  categories: [],
  queues: [],
  settings: provisionalSettings(),
  integration: null,
  pending: null,
  playlists: {},
  selection: [],
  sidebar: 'all',

  async init() {
    if (get().ready) return
    if (initPromise) return initPromise
    set({ initializing: true, initError: null })

    // Keep subscriptions across retries; subscribing again would apply each
    // event twice and make task-list versions and selection unreliable.
    if (!initialized) {
      initialized = true
      window.api.onTasksChanged((tasks) => {
        taskEventVersion++
        startupProgress.clear()
        const live = new Set(tasks.map((t) => t.id))
        pruneHistory(live)
        set((state) => ({
          tasks,
          taskListVersion: state.taskListVersion + 1,
          selection: state.selection.filter((id) => live.has(id))
        }))
      })

      window.api.onProgress((updates) => {
        if (!get().ready) {
          for (const update of updates) startupProgress.set(update.id, update)
        }
        set((state) => {
          const byId = new Map(updates.map((u) => [u.id, u]))

          // Rebuilding the array unconditionally invalidated every downstream
          // memo four times a second - the row order, the group summaries, the
          // sidebar counts - even on a tick where nothing drawn had moved. A
          // paused list, or one whose only running task is a torrent between
          // pieces, now costs nothing at all.
          let changed = false
          const tasks = state.tasks.map((task) => {
            const update = byId.get(task.id)
            if (update) recordSpeed(update.id, update.speed)
            if (!update || !progressDiffers(task, update)) return task
            changed = true
            return { ...task, ...update }
          })

          return changed ? { tasks } : {}
        })
      })

      // `total: 0` is the end of an expansion, however it ended - finished,
      // failed, or called off - so the line comes down rather than sticking.
      window.api.onPlaylistProgress((progress) => {
        set((state) => {
          const next = { ...state.playlists }
          if (progress.total === 0) delete next[progress.groupId]
          else next[progress.groupId] = progress
          return { playlists: next }
        })
      })

      window.api.onQueuesChanged((queues) => {
        queueEventVersion++
        set({ queues })
      })
      window.api.onPendingAction((pending) => set({ pending }))
      window.api.onClipboardItemsChanged((clipboardItems) => {
        clipboardEventVersion++
        set({ clipboardItems })
      })
    }

    const taskVersionAtRead = taskEventVersion
    const queueVersionAtRead = queueEventVersion
    const clipboardVersionAtRead = clipboardEventVersion
    initPromise = (async () => {
      try {
        const [settings, tasks, categories, queues, clipboardItems] = await Promise.all([
          window.api.getSettings(),
          window.api.listTasks(),
          window.api.listCategories(),
          window.api.listQueues(),
          window.api.listClipboardItems()
        ])

        committedSettings = settings
        applyAccent(settings.accent)
        set((state) => ({
          settings,
          tasks: taskEventVersion === taskVersionAtRead
            ? tasks.map((task) => {
                const progress = startupProgress.get(task.id)
                return progress ? { ...task, ...progress } : task
              })
            : state.tasks,
          taskListVersion: taskEventVersion === taskVersionAtRead
            ? state.taskListVersion + 1 : state.taskListVersion,
          categories,
          queues: queueEventVersion === queueVersionAtRead ? queues : state.queues,
          clipboardItems: clipboardEventVersion === clipboardVersionAtRead
            ? clipboardItems : state.clipboardItems,
          sidebar: settings.sidebarSelection || 'all',
          ready: true,
          initError: null
        }))
        startupProgress.clear()
        void get().refreshIntegration()
      } catch (err) {
        set({
          ready: false,
          initError: err instanceof Error ? err.message : String(err)
        })
      } finally {
        set({ initializing: false })
        initPromise = null
      }
    })()

    return initPromise
  },

  async refreshIntegration() {
    try {
      set({ integration: await window.api.getIntegration() })
    } catch {
      // The Options dialog shows "unknown" rather than an error card; a browser
      // link that is not wired up yet is a normal state, not a failure.
      set({ integration: null })
    }
  },

  async saveCategories(categories) {
    try {
      // Categories have no broadcast feed. Use the sanitized committed reply
      // so the sidebar and every destination picker reflect this save at once.
      const saved = await window.api.saveCategories(categories)
      set({ categories: saved })
      const sidebar = get().sidebar
      if (sidebar.startsWith('cat:') && !saved.some((category) => `cat:${category.id}` === sidebar)) {
        get().setSidebar('all')
      }
      return true
    } catch (err) {
      reportError('Could not save categories', err)
      return false
    }
  },

  setSidebar(key) {
    set({ sidebar: key, selection: [] })
    persistSoon({ sidebarSelection: key })
  },

  setSelection(ids) {
    set({ selection: ids })
  },

  clickRow(id, modifiers, visible) {
    const { selection } = get()

    if (modifiers.shift && selection.length > 0) {
      const anchor = selection[selection.length - 1]
      const from = visible.findIndex((t) => t.id === anchor)
      const to = visible.findIndex((t) => t.id === id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        // The anchor stays last so a further shift-click still ranges from it.
        const range = visible.slice(lo, hi + 1).map((t) => t.id)
        set({ selection: [...range.filter((rid) => rid !== anchor), anchor] })
        return
      }
    }

    if (modifiers.ctrl) {
      set({
        selection: selection.includes(id)
          ? selection.filter((sid) => sid !== id)
          : [...selection, id]
      })
      return
    }

    set({ selection: [id] })
  },

  selectAll(visible) {
    set({ selection: visible.map((t) => t.id) })
  },

  async patchSettings(patch) {
    // Applied locally first so the UI never lags a checkbox behind a disk write.
    const editVersion = ++settingsEditVersion
    set((state) => ({ settings: { ...state.settings, ...patch } }))
    if (patch.accent) applyAccent(patch.accent)

    const operation = settingsWriteTail.then(() => window.api.saveSettings(patch))
    settingsWriteTail = operation.then(() => {}, () => {})
    try {
      const saved = await operation
      committedSettings = saved
      if (editVersion === settingsEditVersion) {
        applyAccent(saved.accent)
        set({ settings: saved })
      }
      return true
    } catch (err) {
      if (editVersion === settingsEditVersion && committedSettings) {
        applyAccent(committedSettings.accent)
        set({ settings: committedSettings })
      }
      reportError('Could not save settings', err)
      return false
    }
  },

  setColumnWidth(id, width) {
    const columns = get().settings.columns.map((column) =>
      column.id === id ? { ...column, width: Math.max(48, Math.round(width)) } : column
    )
    set((state) => ({ settings: { ...state.settings, columns } }))
    persistSoon({ columns })
  },

  toggleColumn(id) {
    const columns: ColumnPref[] = get().settings.columns.map((column) =>
      column.id === id ? { ...column, visible: !column.visible } : column
    )
    set((state) => ({ settings: { ...state.settings, columns } }))
    void get().patchSettings({ columns })
  },

  setSort(column) {
    const { sortColumn, sortDirection } = get().settings
    // Clicking the sorted column flips it; a new column starts descending for
    // times and sizes, ascending for names - which is what people expect.
    const direction: SortDirection =
      sortColumn === column
        ? sortDirection === 'asc'
          ? 'desc'
          : 'asc'
        : column === 'name' || column === 'description' || column === 'status'
          ? 'asc'
          : 'desc'

    set((state) => ({
      settings: { ...state.settings, sortColumn: column, sortDirection: direction }
    }))
    persistSoon({ sortColumn: column, sortDirection: direction })
  }
}))

/**
 * Pushes the accent into the CSS custom properties the theme reads. The soft
 * and line variants are derived here so a user picking one colour gets a whole
 * consistent set rather than three fields to fill in.
 */
export function applyAccent(hex: string): void {
  const root = document.documentElement
  const { r, g, b } = hexToRgb(hex) ?? { r: 56, g: 189, b: 248 }

  root.style.setProperty('--accent', hex)
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.13)`)
  root.style.setProperty('--accent-line', `rgba(${r}, ${g}, ${b}, 0.38)`)
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/* ------------------------------------------------------------------ */
/* Derived views                                                       */
/* ------------------------------------------------------------------ */

export function filterTasks(
  tasks: DownloadTask[],
  sidebar: SidebarKey
): DownloadTask[] {

  return tasks.filter((task) => {
    if (sidebar === 'active' && !['probing', 'downloading', 'processing', 'scanning'].includes(task.status)) return false
    if (sidebar === 'queued' && task.status !== 'queued') return false
    if (sidebar === 'attention' && task.status !== 'error' && task.status !== 'missing') return false
    if (sidebar === 'unfinished' && task.status === 'done') return false
    if (sidebar === 'finished' && task.status !== 'done') return false
    if (sidebar.startsWith('cat:') && task.categoryId !== sidebar.slice(4)) return false
    if (sidebar.startsWith('queue:') && task.queueId !== sidebar.slice(6)) return false

    return true
  })
}

/** Ordering used by the status column, so "downloading" sorts above "done". */
const STATUS_RANK: Record<DownloadTask['status'], number> = {
  downloading: 0,
  processing: 1,
  scanning: 2,
  probing: 3,
  queued: 4,
  paused: 5,
  error: 6,
  missing: 7,
  done: 8
}

// Reusing the collator avoids rebuilding locale/numeric comparison state for
// every pair in a name sort. A 1,000-row sort invokes this thousands of times.
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true })

export function sortTasks(
  tasks: DownloadTask[],
  column: ColumnId,
  direction: SortDirection
): DownloadTask[] {
  const sign = direction === 'asc' ? 1 : -1

  return [...tasks].sort((a, b) => {
    // Missing values are not a duration and stay below known ETAs even when
    // the user asks to see the longest remaining downloads first.
    if (column === 'eta' && (a.eta === null || b.eta === null)) {
      if (a.eta !== b.eta) return a.eta === null ? 1 : -1
    }
    const result = compare(a, b, column)
    // A stable tiebreak on creation time keeps rows from swapping places on
    // every progress tick when their sort key is equal.
    return (result === 0 ? a.createdAt - b.createdAt : result * sign) || 0
  })
}

function compare(a: DownloadTask, b: DownloadTask, column: ColumnId): number {
  switch (column) {
    case 'name':
      return NAME_COLLATOR.compare(a.filename, b.filename)
    case 'size':
      return (a.size ?? -1) - (b.size ?? -1)
    case 'progress':
      return progressOf(a) - progressOf(b)
    case 'status':
      return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    case 'eta':
      // No ETA sorts last in either direction; "unknown" is not "zero seconds".
      return (a.eta ?? Number.MAX_SAFE_INTEGER) - (b.eta ?? Number.MAX_SAFE_INTEGER)
    case 'speed':
      return a.speed - b.speed
    case 'queue':
      return (a.queueId ?? '').localeCompare(b.queueId ?? '')
    case 'description':
      return a.description.localeCompare(b.description)
    case 'added':
    default:
      return a.createdAt - b.createdAt
  }
}

function progressOf(task: DownloadTask): number {
  if (!task.size) return task.status === 'done' ? 1 : 0
  return task.received / task.size
}

export function categoryName(categories: Category[], id: string | null): string {
  if (!id) return ''
  return categories.find((c) => c.id === id)?.name ?? ''
}

export function queueName(queues: Queue[], id: string | null): string {
  if (!id) return ''
  return queues.find((q) => q.id === id)?.name ?? ''
}
