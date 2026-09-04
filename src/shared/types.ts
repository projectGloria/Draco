/**
 * The contract between the main process and the renderer.
 * Everything crossing the contextBridge is described here.
 *
 * Changing an IPC channel means touching three files in lockstep:
 * this file, `main/ipc.ts`, and `preload/index.ts`.
 */

/* ------------------------------------------------------------------ */
/* Bootstrap / splash                                                  */
/* ------------------------------------------------------------------ */

export type BootstrapStepId = 'appdata' | 'settings' | 'restore' | 'bridge' | 'integration'

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface BootstrapStep {
  id: BootstrapStepId
  label: string
  status: StepStatus
  /** 0-100 while measurable, null when the work has no meaningful progress */
  percent: number | null
  /** Short human line under the step */
  detail: string | null
}

export interface BootstrapState {
  steps: BootstrapStep[]
  /** Overall 0-100 across all steps */
  overall: number
  done: boolean
  error: { step: BootstrapStepId; message: string; canContinue: boolean } | null
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

export type TaskStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'paused'
  | 'done'
  | 'error'
  /** Terminal-but-recoverable: the file vanished from disk after completion. */
  | 'missing'

/** What the engine is downloading. HLS is a pre-split segment list plus a mux. */
export type TaskKind = 'file' | 'hls' | 'dash' | 'torrent'

/**
 * One byte range owned by exactly one connection. Segments never overlap, which
 * is why the writers need no locking.
 */
export interface Segment {
  /** First byte of the range, absolute within the file. */
  start: number
  /** Last byte, inclusive. -1 when the total length is unknown. */
  end: number
  /** Next byte this segment will write; position - start is what it has done. */
  position: number
  /** True while a connection is actively pulling this range. */
  active: boolean
}

/** Headers captured from the browser so the server sees the same caller it did. */
export interface RequestHeaders {
  cookie?: string
  referer?: string
  userAgent?: string
  authorization?: string
  extra?: Record<string, string>
}

export interface SubtitleTrack {
  url: string
  label: string
  language: string | null
  format: 'vtt' | 'srt' | 'ttml'
}

export interface TorrentRuntimeFile {
  path: string
  size: number
  downloaded: number
  selected: boolean
}

export interface TorrentRuntimePeer {
  address: string
  client: string
  type: string
  downloadSpeed: number
  uploadSpeed: number
}

export interface TorrentRuntimeInfo {
  infoHash: string
  files: TorrentRuntimeFile[]
  peers: TorrentRuntimePeer[]
  trackers: string[]
  sources: string[]
  uploaded: number
  ratio: number
}

export interface DownloadTask {
  id: string
  /** True if this task is currently being briefly downloaded by Cat Mode. */
  isCatMode?: boolean
  /** Timestamp of when this task was last pinged by Cat Mode. */
  lastCatPingAt?: number
  expectedChecksum?: string
  postProcess?: 'none' | 'mp4' | 'mp3'
  selectedFiles?: string[]
  /** Metadata learned before start, used for selection and representative icon. */
  torrentFiles?: TorrentFile[]
  /** Live BitTorrent diagnostics for the details tabs. */
  torrentInfo?: TorrentRuntimeInfo
  /** What the user or the browser handed us. */
  url: string
  /** Page/origin the download was discovered on, used for its persisted favicon. */
  sourceUrl?: string
  /** Shared identity for files selected from one inspected web page. */
  groupId?: string
  groupName?: string
  /** Safe child folder appended to the chosen/category destination. */
  groupFolder?: string
  /** The separate audio stream URL to fetch and mux, if any. */
  audioUrl?: string | null
  /**
   * Stable source identity for expiring signed streams (currently YouTube).
   *
   * `height` is the rung the user actually chose. The itags beside it are the
   * *page's* names for it, and yt-dlp - a different YouTube client - does not
   * always list the same ones, so the rung is what a refresh falls back to when
   * an itag has no counterpart in yt-dlp's ladder.
   */
  youtube?: {
    pageUrl: string
    videoFormatId: string
    audioFormatId?: string | null
    height?: number | null
    role?: 'video' | 'audio'
  }
  /** Where the redirects actually landed; this is what the workers request. */
  finalUrl: string
  filename: string
  /**
   * True when the user named the file themselves (Save As). The probe then
   * leaves it alone instead of replacing it with Content-Disposition's idea.
   */
  filenameLocked: boolean
  /** Absolute directory the finished file lands in. */
  dir: string
  categoryId: string | null
  queueId: string | null
  queueRetryCount: number
  nextQueueAttemptAt: number | null
  /**
   * The user stopped this one by hand, so a running queue must leave it alone.
   * Without it the scheduler treated every `paused` task as "waiting its turn"
   * and started it again within the half-minute.
   */
  manualPause: boolean
  kind: TaskKind
  /** Total bytes, or null when the server would not say. */
  size: number | null
  received: number
  status: TaskStatus
  /** True once a 206 has actually been seen - not merely Accept-Ranges. */
  resumable: boolean
  /** Sticky compatibility mode for servers that advertise ranges then ignore them. */
  singleConnectionFallback: boolean
  segments: Segment[]
  /** Connection budget for this task. */
  connections: number
  /** Smoothed bytes/sec over the recent window. */
  speed: number
  /** Seconds remaining, or null when unknowable. */
  eta: number | null
  error: string | null
  /**
   * A short line about what is happening right now when the status alone does
   * not say it - "Fetching ffmpeg", "Muxing". Null the rest of the time.
   */
  detail: string | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  etag: string | null
  lastModified: string | null
  headers: RequestHeaders
  /** External caption files captured from the page and saved beside the media. */
  subtitles?: SubtitleTrack[]
  mimeType: string | null
  description: string
}

/** The 4 Hz batched update. Only the fields that actually move. */
export interface TaskProgress {
  id: string
  received: number
  size: number | null
  speed: number
  eta: number | null
  status: TaskStatus
  segments: Segment[]
  error: string | null
  detail: string | null
  torrentInfo?: TorrentRuntimeInfo
}

/** What Add URL and the browser handoff both submit. */
export interface NewDownload {
  url: string
  sourceUrl?: string
  groupId?: string
  groupName?: string
  groupFolder?: string
  audioUrl?: string | null
  /** Stable YouTube format identity used to refresh expiring signed URLs. */
  youtube?: { pageUrl: string; videoFormatId: string; audioFormatId?: string | null; height?: number | null; role?: 'video' | 'audio' }
  filename?: string
  dir?: string
  categoryId?: string | null
  queueId?: string | null
  headers?: RequestHeaders
  subtitles?: SubtitleTrack[]
  description?: string
  expectedChecksum?: string
  postProcess?: 'none' | 'mp4' | 'mp3'
  selectedFiles?: string[]
  torrentFiles?: TorrentFile[]
  kind?: TaskKind
  /** When false the task is created paused instead of starting immediately. */
  autoStart?: boolean
  /** Creates the task without opening the separate floating progress window. */
  suppressProgressWindow?: boolean
}

/**
 * A download the browser handed over that is waiting for the user to confirm.
 *
 * IDM's behaviour: clicking a link in the browser opens a window showing what
 * the file is and where it is about to go, rather than silently starting it.
 */
export interface HandoffRequest {
  id: string
  /**
   * `file` is an ordinary download the browser was about to start. `media` is a
   * stream someone pressed the button on, which has a quality ladder to choose
   * from before anything can start.
   */
  kind: 'file' | 'media'
  url: string
  /** The name the browser had picked, when it had one. */
  filename?: string
  /** Cookies, referer and user-agent captured from the browser. */
  headers: RequestHeaders
  /** What the browser thought the size was, before Draco probes for itself. */
  size: number | null
  mimeType: string | null
  /** The page the download came from, shown as context. */
  pageUrl?: string
  pageTitle?: string
  /** For `media`: the grabber candidate this window resolves qualities from. */
  mediaId?: string
}

export interface TorrentFile {
  path: string
  size: number
}

/** What a probe learned before any bytes were committed to disk. */
export interface ProbeResult {
  finalUrl: string
  filename: string
  size: number | null
  resumable: boolean
  etag: string | null
  lastModified: string | null
  mimeType: string | null
  statusCode: number
  torrentFiles?: TorrentFile[]
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export interface Category {
  id: string
  name: string
  /** Lowercase, no leading dot. Matched against the filename extension. */
  extensions: string[]
  hosts: string[]
  /** Subfolder under the download root, already Windows-safe. */
  folder: string
  /** Built-ins can be edited but not deleted, mirroring IDM. */
  builtin: boolean
}

/* ------------------------------------------------------------------ */
/* Queues and the scheduler                                            */
/* ------------------------------------------------------------------ */

export type QueueMode = 'manual' | 'onetime' | 'periodic'

export type QueueCompletionAction = 'none' | 'run' | 'exit' | 'sleep' | 'hibernate' | 'shutdown'

export interface Queue {
  id: string
  name: string
  /** Ordered - the queue runs its tasks top to bottom. */
  taskIds: string[]
  mode: QueueMode
  /** "HH:MM" local time, or null when the mode does not use it. */
  startTime: string | null
  stopTime: string | null
  /** 0 = Sunday. Only meaningful for periodic queues. */
  days: number[]
  maxConcurrent: number
  /** Additional attempts after the engine has exhausted its own request retries. */
  retryLimit: number
  retryDelaySeconds: number
  onComplete: QueueCompletionAction
  completionProgram: string | null
  completionArgs: string[]
  /** True while the scheduler (or the user) has this queue running. */
  running: boolean
  /** One-time schedules latch after they have drained so they cannot rerun every day. */
  oneTimeCompleted: boolean
  lastResult: 'idle' | 'completed' | 'completed-with-errors'
}

/** A pending shutdown/sleep the user can still call off. */
export interface PendingAction {
  action: QueueCompletionAction
  queueId: string
  /** Epoch ms at which it fires. */
  firesAt: number
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export type SortDirection = 'asc' | 'desc'

export type ColumnId =
  | 'name'
  | 'size'
  | 'progress'
  | 'status'
  | 'eta'
  | 'speed'
  | 'queue'
  | 'added'
  | 'description'

export interface ColumnPref {
  id: ColumnId
  width: number
  visible: boolean
}

export interface Settings {
  language: 'system' | 'en' | 'tr'
  theme: 'system' | 'dark' | 'light'
  /** Root for downloads; categories add a subfolder under it. */
  downloadDir: string
  /** Prevent downloading if free space is less than the file size. */
  checkDiskSpace: boolean
  /** Show a floating desktop dropzone widget. */
  showDropzone: boolean
  /** 🐱 Keeps waiting downloads alive by occasionally downloading tiny chunks. */
  catMode: boolean
  /** How many tasks run at once. */
  maxConcurrentTasks: number
  /** Double the wait time on each network retry. */
  exponentialBackoff: boolean
  /** Connection budget per task - IDM's "max connections". */
  maxConnectionsPerTask: number
  /**
   * How far the adaptive ramp may climb when the extra connections keep
   * earning their keep, or null to stop at `maxConnectionsPerTask`. It is only
   * ever reached on a server that measurably rewards them; a per-host rule
   * still overrides it.
   */
  adaptiveConnectionCeiling: number | null
  /** A segment is only split when its remaining bytes exceed this. */
  minSplitSize: number
  /** Global cap in bytes/sec, or null for unlimited. */
  speedLimit: number | null
  /** HTTP(S) proxy URL. Authentication may be embedded in the URL. */
  proxyUrl: string | null
  /** Per-origin connection exceptions, matched by hostname and subdomains. */
  hostConnectionLimits: Array<{ host: string; connections: number }>
  /** Rolling transfer allowance, or null for no quota. */
  quotaBytes: number | null
  /** Length of the quota window in minutes. */
  quotaWindowMinutes: number
  antivirusProgram: string | null
  antivirusArgs: string[]
  antivirusTimeoutSeconds: number
  updateFeedUrl: string | null
  autoCheckUpdates: boolean
  /** Per-segment attempts before the task is failed. */
  retryLimit: number
  /** Socket/headers timeout in ms. */
  timeoutMs: number
  /** Categories are stored separately; this only names the fallback. */
  defaultCategoryId: string | null
  /** Ask before deleting tasks that have partial data on disk. */
  confirmDelete: boolean
  closeToTray: boolean
  startMinimized: boolean
  /** Master switch for the browser extension handoff. */
  takeoverEnabled: boolean
  /**
   * Show the Save As window when the browser hands a download over, instead of
   * starting it immediately. This is what IDM does, and it is the only chance
   * to redirect or rename a download before it begins.
   */
  confirmHandoff: boolean
  /** Downloads smaller than this are left to the browser. */
  takeoverMinSize: number
  /** Lowercase extensions Draco claims. Empty means every download. */
  takeoverExtensions: string[]
  /** Hosts the extension must never take over (banking, intranet, ...). */
  takeoverExcludeHosts: string[]
  /** Watch the clipboard for URLs while running. */
  watchClipboard: boolean
  /**
   * Open a progress window of its own for each download the user starts, the
   * way IDM does. Off leaves the main list as the only place a download shows.
   */
  showProgressWindow: boolean
  accent: string
  columns: ColumnPref[]
  sortColumn: ColumnId
  sortDirection: SortDirection
  /** Persisted sidebar selection, e.g. all, cat:<id>, queue:<id>. */
  sidebarSelection: string
}

/* ------------------------------------------------------------------ */
/* Media grabber                                                       */
/* ------------------------------------------------------------------ */

/** A stream the extension spotted on a page. */
export interface MediaCandidate {
  id: string
  pageUrl: string
  pageTitle: string
  mediaUrl: string
  type: 'hls' | 'dash' | 'file'
  /** Filled in once the playlist has been parsed. */
  variants: MediaVariant[]
  headers: RequestHeaders
  subtitles: SubtitleTrack[]
  discoveredAt: number
}

/**
 * One YouTube format as the page's own player response describes it.
 *
 * The optional URL is the already-playing Googlevideo resource. It is accepted
 * only after strict CDN/path/itag validation, allowing the final Download click
 * to start transferring without another extractor round trip.
 */
export interface PageFormat {
  itag: number
  mimeType: string | null
  bitrate: number | null
  width: number | null
  height: number | null
  fps: number | null
  contentLength: number | null
  url?: string | null
}

export interface MediaVariant {
  /**
   * The variant playlist URL, or the media URL itself for progressive files.
   *
   * Empty only when the page did not expose a validated direct resource.
   */
  url: string
  /** The separate audio stream URL, if the stream is demuxed. */
  audioUrl?: string | null
  /** e.g. "1080p" */
  label: string
  height: number | null
  bandwidth: number | null
  codecs: string | null
  /** Estimated bytes, when the playlist gives enough to guess. */
  estimatedSize: number | null
  /**
   * Extension the finished file will carry - "mp4", "webm", "mkv".
   *
   * What a person picking a quality wants to know is what they will end up
   * with; a bitrate is a number they cannot act on. It is also the container
   * the mux must actually produce, so the two cannot drift apart.
   */
  container?: string | null
  /** Stable YouTube format identity, used to refresh expiring signed media URLs. */
  youtube?: { videoFormatId: string; audioFormatId?: string | null; role?: 'video' | 'audio' }
}

/** Status of the background yt-dlp lookup that resolves a YouTube video's direct links. */
export type YouTubePrimeState =
  | { state: 'idle' }
  | { state: 'pending'; startedAt: number }
  | { state: 'ready'; tookMs: number }
  | { state: 'failed'; tookMs: number; error: string }

export interface YouTubeResolution {
  id: string
  title: string
  variants: MediaVariant[]
  thumbnailUrl?: string | null
}

export interface ClipboardItem {
  id: string
  url: string
  kind: 'file' | 'torrent' | 'youtube' | 'media'
  status: 'fetching' | 'ready' | 'error'
  createdAt: number
  updatedAt: number
  filename: string | null
  size: number | null
  mimeType: string | null
  error: string | null
  probe?: ProbeResult
  youtube?: YouTubeResolution
  media?: YouTubeResolution
}

/* ------------------------------------------------------------------ */
/* Browser integration status                                          */
/* ------------------------------------------------------------------ */

export interface IntegrationStatus {
  /** Absolute path the user points "Load unpacked" at. */
  extensionPath: string
  firefoxExtensionPath: string
  /** The pinned ID derived from the extension key, or null if not generated. */
  extensionId: string | null
  /** Which browsers have the native-messaging registry key pointing at us. */
  registered: { chrome: boolean; edge: boolean; brave: boolean; opera: boolean; vivaldi: boolean; firefox: boolean }
  /** True while the named-pipe server is accepting host connections. */
  bridgeListening: boolean
  /** Epoch ms of the last message received from the extension, if any. */
  lastHandoffAt: number | null
}

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  available: boolean
  downloadUrl: string | null
  notes: string | null
}

/** The external binaries Draco fetches on demand rather than shipping. */
export type ToolId = 'ffmpeg' | 'yt-dlp'

export interface ToolStatus {
  id: ToolId
  name: string
  /** One line on what breaks without it, for the panel that offers the update. */
  purpose: string
  /** Where the copy in use lives, or null when there is not one yet. */
  path: string | null
  /** True only for the copy under %APPDATA%/Draco/bin - the one Draco may replace. */
  managed: boolean
  installedVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  error: string | null
}

export interface SiteGrabOptions {
  startUrl: string
  maxDepth: number
  maxPages: number
  includeAssets: boolean
  stayOnHost: boolean
  respectRobots: boolean
  autoStart: boolean
  scheduleHours?: number | null
}

export interface SiteGrabResult {
  discovered: number
  added: number
  rootDir: string
  projectId: string
}

export interface SiteGrabProject {
  id: string
  name: string
  options: SiteGrabOptions
  rootDir: string
  knownUrls: string[]
  createdAt: number
  lastRunAt: number | null
  lastError: string | null
}

/* ------------------------------------------------------------------ */
/* Renderer API                                                        */
/* ------------------------------------------------------------------ */

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
}

export interface RendererApi {
  /* bootstrap */
  onBootstrap(cb: (state: BootstrapState) => void): () => void
  bootstrapRetry(): Promise<void>
  bootstrapContinue(): Promise<void>

  /* tasks */
  listTasks(): Promise<DownloadTask[]>
  /** One task, for the windows that show a single download rather than the list. */
  getTask(id: string): Promise<DownloadTask | null>
  addDownload(input: NewDownload): Promise<DownloadTask>
  /** Adds many URLs as one IPC round-trip and opens at most one progress
   * window, instead of the caller firing N `addDownload`s that each open one. */
  addDownloads(inputs: NewDownload[]): Promise<DownloadTask[]>
  probe(url: string, headers?: RequestHeaders): Promise<ProbeResult>
  resolveYouTube(url: string): Promise<YouTubeResolution>
  resolveMediaPage(url: string): Promise<YouTubeResolution>
  listClipboardItems(): Promise<ClipboardItem[]>
  retryClipboardItem(id: string): Promise<void>
  removeClipboardItem(id: string): Promise<void>
  onClipboardItemsChanged(cb: (items: ClipboardItem[]) => void): () => void
  startTasks(ids: string[]): Promise<void>
  pauseTasks(ids: string[]): Promise<void>
  pauseAll(): Promise<void>
  removeTasks(ids: string[], deleteFiles: boolean): Promise<void>
  removeCompleted(): Promise<void>
  updateTask(id: string, patch: Partial<DownloadTask>): Promise<DownloadTask | null>
  redownload(id: string): Promise<void>
  /** Both resolve false when the file is gone, having marked the task missing. */
  openFile(id: string): Promise<boolean>
  revealFile(id: string): Promise<boolean>
  openTorrentItem(id: string, path: string): Promise<boolean>
  revealTorrentItem(id: string, path: string): Promise<boolean>
  onTasksChanged(cb: (tasks: DownloadTask[]) => void): () => void
  onProgress(cb: (updates: TaskProgress[]) => void): () => void

  /* the confirm window */
  /** Which request this window is for; read from its own query string. */
  getHandoff(id: string): Promise<HandoffRequest | null>
  acceptHandoff(id: string, input: NewDownload): Promise<void>
  /** For a media handoff: the quality ladder, fetched on demand. */
  resolveHandoffMedia(id: string): Promise<MediaCandidate>
  acceptHandoffMedia(id: string, opts: { variantUrl: string; filename: string; dir?: string; categoryId?: string; queueId?: string; audioUrl?: string | null; youtube?: { videoFormatId: string; audioFormatId?: string | null; role?: 'video' | 'audio' } }): Promise<void>
  /** Whether yt-dlp's background priming for this YouTube video has finished. Safe to poll. */
  getYouTubePrimeStatus(pageUrl: string): Promise<YouTubePrimeState>
  /** Cancel: drops the request and closes the window. */
  dismissHandoff(id: string): Promise<void>

  /* categories */
  listCategories(): Promise<Category[]>
  saveCategories(categories: Category[]): Promise<Category[]>

  /* queues */
  listQueues(): Promise<Queue[]>
  saveQueue(queue: Queue): Promise<Queue>
  removeQueue(id: string): Promise<void>
  startQueue(id: string): Promise<void>
  stopQueue(id: string): Promise<void>
  onQueuesChanged(cb: (queues: Queue[]) => void): () => void
  onPendingAction(cb: (pending: PendingAction | null) => void): () => void
  cancelPendingAction(): Promise<void>

  /* settings + integration */
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  chooseDirectory(current?: string): Promise<string | null>
  getIntegration(): Promise<IntegrationStatus>
  registerIntegration(): Promise<IntegrationStatus>
  readClipboard(): Promise<string>
  copyToClipboard(text: string): Promise<void>
  checkForUpdates(): Promise<UpdateInfo>
  openUpdate(url: string): Promise<void>
  /** `checkLatest: false` reads the disk only; true also asks the publishers. */
  getToolStatus(checkLatest: boolean): Promise<ToolStatus[]>
  updateTool(id: ToolId): Promise<ToolStatus>
  /** Fired once per run when a fetched-on-demand binary has fallen behind. */
  onToolUpdates(cb: (tools: ToolStatus[]) => void): () => void
  startSiteGrab(options: SiteGrabOptions): Promise<SiteGrabResult>
  listSiteGrabs(): Promise<SiteGrabProject[]>
  runSiteGrab(id: string): Promise<SiteGrabResult>
  removeSiteGrab(id: string): Promise<void>

  /* icons */
  /**
   * The icon the shell associates with this file type, as a data URL, or null
   * when Windows had nothing to give. Cached in main, so calling it per row is
   * cheap after the first of each type.
   */
  fileIcon(extension: string): Promise<string | null>
  /** The favicon of the site a download came from, as a data URL. */
  siteIcon(url: string): Promise<string | null>

  /* window */
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  /** Minimises whichever window asked, for the same reason as `closeSelf`. */
  minimizeSelf(): Promise<void>
  /** Closes whichever window asked - the per-download windows own no other. */
  closeSelf(): Promise<void>
  /** The frame is custom, so the restore glyph has to be told when to change. */
  onMaximizeChange(cb: (maximized: boolean) => void): () => void
  onToast(cb: (toast: Toast) => void): () => void
}

declare global {
  interface Window {
    api: RendererApi
  }
}
