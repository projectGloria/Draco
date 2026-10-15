// Must run before anything dispatches to libuv's threadpool (fs, dns): the
// pool is sized on first use, and the default of 4 is six times narrower than
// the 24 concurrent segment writes the engine is configured to keep busy
// (maxConcurrentTasks x maxConnectionsPerTask), before HLS/recovery scans add
// their own load on top.
process.env.UV_THREADPOOL_SIZE ??= '32'

import { app, dialog, ipcMain, powerSaveBlocker, Notification } from 'electron'
import { version } from '../../package.json'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, sep, join } from 'node:path'
import type {
  BootstrapState,
  BootstrapStep,
  BootstrapStepId,
  DownloadTask,
  HandoffRequest,
  TaskStatus,
  Queue
} from '@shared/types'
import { ensureDirs, getPaths } from './bootstrap/paths.ts'
import { loadCredentials, resolveCredentials } from './credentials.ts'
import { ClipboardWatcher } from './clipboard.ts'
import { ensureRegistered } from './bridge/integration.ts'
import { PipeServer, ensurePipeSecret } from './bridge/pipe-server.ts'
import { batchHandoffId, commitBrowserTasks, committedBrowserTaskCount } from './bridge/admission.ts'
import { BrowserHandoffInbox } from './bridge/handoff-inbox.ts'
import { electronJsonCipher, ensureElectronJsonCipherReady } from './electron-json-cipher.ts'
import type { HostMessage, HostReply } from './bridge/protocol.ts'
import { validateUrl } from './engine/create.ts'
import { setTorrentStoreDir } from './engine/torrent-store.ts'
import { closeDispatchers } from './engine/http.ts'
import { DownloadManager } from './engine/manager.ts'
import { MpdRunner } from './dash/runner.ts'
import { HlsRunner } from './hls/runner.ts'
import { announce, handoffToTask, openShellTarget, prepareClipboardItem, pushPendingHandoff, recordMedia, refileTask, registerIpc, type AppContext } from './ipc.ts'
import { logger, setLogDirectory } from './log.ts'
import { publicTasks } from './public-task.ts'
import { Scheduler } from './queue/scheduler.ts'
import { SiteProjectManager } from './site-grabber/projects.ts'
import {
  flushTasks,
  flushQuotaState,
  getSettings,
  loadCategories,
  loadClipboardItems,
  loadQueues,
  loadQuotaState,
  loadSettings,
  loadSiteProjects,
  loadTasks,
  persistTasks,
  persistQuotaState,
  setPersistenceErrorHandler,
  saveSettings,
  saveQueues,
  saveSiteProjects
} from './store.ts'
import { registerShellHandlers, shellTargetsFromArgv } from './shell-integration.ts'
import { createTray, destroyTray } from './tray.ts'
import { getToolStatus } from './tools.ts'
import { checkForUpdates } from './update.ts'
import {
  broadcast,
  cancelQuit,
  closeSplash,
  closeHandoffWindow,
  createHandoffWindow,
  createMainWindow,
  createSplashWindow,
  progressWindowTaskIds,
  send,
  sendSplash,
  showMainWindow,
  syncDropzoneWindow,
  updateProgressWindow
} from './windows.ts'

import { DashRunner } from './hls/dash.ts'
import {
  primeYouTube,
  refreshYouTubeFormat,
  resolveMediaPage,
  resolveYouTube,
  resolveYouTubeInstant
} from './youtube.ts'
import { isSupportedYouTubeUrl, youtubeFormatId } from './youtube-url.ts'
import { xPostUrl } from '../shared/x-post.ts'

const log = logger('main')
// Package smoke tests use disposable profiles. Reject a non-temporary target
// so diagnostics cannot touch real download state.
const verifyProfileRequested = process.argv.includes('--verify-profile')
const smokeBridgeRequested = process.argv.includes('--smoke-bridge')
const diagnosticRoot = verifyProfileRequested
  ? process.env.DRACO_VERIFY_PROFILE_ROOT
  : smokeBridgeRequested ? process.env.DRACO_SMOKE_PROFILE_ROOT : undefined
if ((verifyProfileRequested || smokeBridgeRequested) && !diagnosticRoot) {
  throw new Error('Disposable profile path is required for diagnostics')
}
if (diagnosticRoot) {
  const root = resolve(diagnosticRoot)
  if (!root.startsWith(resolve(tmpdir()) + sep)) {
    throw new Error('Diagnostics require a temporary directory')
  }
  mkdirSync(root, { recursive: true })
  app.setPath('userData', root)
}
const lastPersistenceNotice = new Map<string, number>()
setPersistenceErrorHandler((scope, error) => {
  log.error(`could not save ${scope}: ${String(error)}`)
  const now = Date.now()
  if (now - (lastPersistenceNotice.get(scope) ?? 0) < 30_000) return
  lastPersistenceNotice.set(scope, now)
  send('toast', { kind: 'error', message: `Could not save ${scope}. Check available disk space and permissions.` })
})

/**
 * Startup is a real sequence, not a delay: the splash goes up before any slow
 * work, each step reports in, and the main window is only created once the app
 * can actually function. A failed step turns the splash into an error card with
 * Retry / Continue - it must never hang on a spinner, and it must never quietly
 * carry on as though nothing had gone wrong.
 */

const STEPS: Array<{ id: BootstrapStepId; label: string }> = [
  { id: 'appdata', label: 'Preparing app data' },
  { id: 'settings', label: 'Preparing secure storage and settings' },
  { id: 'restore', label: 'Restoring downloads' },
  { id: 'bridge', label: 'Starting the browser bridge' },
  { id: 'integration', label: 'Registering browser integration' }
]

let ctx: AppContext | null = null
/** Restored dialogs appear only when a browser confirms it still owns the paused item. */
const restoredHandoffsAwaitingStatus = new Set<string>()
/** Shell targets arriving from a second instance before the manager exists. */
const earlyShellTargets: ReturnType<typeof shellTargetsFromArgv> = []
let clipboardWatcher: ClipboardWatcher | null = null

export function updateClipboardWatcher(enabled: boolean) {
  if (enabled) clipboardWatcher?.start()
  else clipboardWatcher?.stop()
}
const state: BootstrapState = freshState()
let finished = false
let powerSaveBlockerId: number | null = null
let initialRestoreDone = false
const taskStatuses = new Map<string, TaskStatus>()

/**
 * Updates only the progress windows actually open, rather than doing a
 * progressWindows lookup for every task in the list - the two counts diverge
 * a lot once someone has a long download history.
 */
function updateOpenProgressWindows(tasks: DownloadTask[]): void {
  const openIds = progressWindowTaskIds()
  if (openIds.length === 0) return
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const id of openIds) {
    const task = byId.get(id)
    if (task) updateProgressWindow(task)
  }
}

/* ------------------------------------------------------------------ */
/* Single instance                                                     */
/* ------------------------------------------------------------------ */

// Two copies would fight over the named pipe and over tasks.json. The second
// launch just surfaces the first - which is also what the native host relies on
// when it starts the app to service a handoff.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Double-clicking a `.torrent` while Draco is already running is a second
    // launch: Windows hands the path to the new process, which finds the lock
    // taken and forwards its whole command line here.
    const targets = shellTargetsFromArgv(argv)
    if (ctx) {
      for (const target of targets) void openShellTarget(ctx, target)
    } else {
      // Still bootstrapping: `openShellTarget` needs the manager, which does
      // not exist yet. Buffer the targets so `finish()` drains them instead of
      // silently dropping a double-clicked torrent.
      earlyShellTargets.push(...targets)
    }
    showMainWindow()
  })
  // A throw in here would otherwise leave the splash spinning forever with the
  // reason buried in an unhandled rejection warning.
  void main().catch((err) => {
    log.error('startup failed', err)
    state.error = {
      step: 'appdata',
      message: err instanceof Error ? err.message : String(err),
      canContinue: false
    }
    publish()
  })
}

/**
 * Runs once. Everything built here - the singletons, the IPC handlers, the
 * splash - must not be built twice, which is why the retryable part lives in
 * `runBootstrap` instead.
 */
async function main(): Promise<void> {
  process.on('uncaughtException', (error) => {
    log.error('Uncaught Exception', error)
  })

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled Rejection', reason)
  })

  await app.whenReady()
  app.setAppUserModelId('com.nihil.draco')

  if (verifyProfileRequested) {
    await verifyDisposableProfile()
    return
  }

  const splash = smokeBridgeRequested ? null : createSplashWindow()
  // Bootstrap starts before the splash renderer has finished loading, so any
  // state published in that gap would never be heard - worst case a startup
  // error that leaves a spinner on screen with no Retry/Continue. Re-publish
  // the current state the moment the splash can receive it.
  splash?.webContents.on('did-finish-load', () => publish())

  /**
   * The scheduler owns the queues and is built after the manager, which needs
   * to ask it about them. A late-bound lookup keeps that one-way: the manager
   * still holds no queue list of its own.
   */
  let queueSpeedLimitLookup: (queueId: string) => number | null = () => null
  let queuePolicyLookup: (queueId: string) => Queue | undefined = () => undefined

  const manager = new DownloadManager({
    /*
     * `Settings` is a structural superset of `EngineSettings`, so it is handed
     * over whole rather than copied field by field. The hand-written copy that
     * used to live here silently dropped `catMode`, `checkDiskSpace`,
     * `exponentialBackoff` and `adaptiveConnectionCeiling` - all four optional
     * on `EngineSettings`, so nothing complained and four settings the Options
     * dialog offers simply did nothing.
     */
    getSettings: () => ({ ...getSettings(), tempDir: getPaths().tempDir }),
    onTasks: (tasks) => {
      persistTasks(tasks)
      // Broadcast rather than sent: each open progress window is watching the
      // same feed for the one task it is about.
      broadcast('tasks:changed', publicTasks(tasks))
      updateOpenProgressWindows(tasks)

      let newlyDone = 0
      let lastNewlyDoneName: string | null = null
      let hasActive = false
      const seen = new Set<string>()
      for (const t of tasks) {
        seen.add(t.id)
        if (t.status === 'done' && taskStatuses.get(t.id) !== 'done') {
          newlyDone++
          lastNewlyDoneName = t.filename
        }
        taskStatuses.set(t.id, t.status)
        if (t.status === 'downloading' || t.status === 'probing' || t.status === 'processing' || t.status === 'scanning') {
          hasActive = true
        }
      }
      // taskStatuses otherwise remembers every task id the app has ever seen,
      // unlike every other cache in main (pendingHandoffs, ctx.media,
      // hostReplyCache), all of which are deliberately bounded.
      for (const id of taskStatuses.keys()) {
        if (!seen.has(id)) taskStatuses.delete(id)
      }

      if (newlyDone > 0 && initialRestoreDone) {
        if (getSettings().completionSound) send('download:complete', null)
        const notification = new Notification({
          silent: true,
          title: newlyDone === 1 ? 'Download Complete' : `${newlyDone} Downloads Complete`,
          body: newlyDone === 1
            ? lastNewlyDoneName ?? 'Your download has finished.'
            : 'Your files have finished downloading.',
        })
        let dismissTimer: ReturnType<typeof setTimeout> | undefined
        notification.once('show', () => {
          dismissTimer = setTimeout(() => notification.close(), 5000)
          dismissTimer.unref()
        })
        notification.once('close', () => clearTimeout(dismissTimer))
        notification.show()
      }

      if (hasActive && powerSaveBlockerId === null) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      } else if (!hasActive && powerSaveBlockerId !== null) {
        powerSaveBlocker.stop(powerSaveBlockerId)
        powerSaveBlockerId = null
      }
    },
    onFinalizationStage: flushTasks,
    onProgress: (updates) => {
      broadcast('tasks:progress', updates)
      for (const update of updates) {
        const task = manager.get(update.id)
        if (task) updateProgressWindow(task)
      }
    },
    onQuotaState: persistQuotaState,
    onProbed: (task) => refileTask(task),
    createHlsRunner: (task, context) =>
      new HlsRunner(
        task,
        {
          maxConnections: context.maxConnections,
          retryLimit: context.retryLimit,
          timeoutMs: context.timeoutMs,
          // Without this the playlist runner kept its pieces beside the
          // destination while every other runner used the workspace, and the
          // two disagreed about where `remove` should look.
          tempDir: context.tempDir,
          checkDiskSpace: context.checkDiskSpace,
          exponentialBackoff: context.exponentialBackoff
        },
        {
          limiter: context.limiter,
          onUpdate: context.onUpdate,
          onFinished: context.onFinished,
          onProbed: context.onProbed
        }
      ),
    createMpdRunner: (task, context) => new MpdRunner(task, context),
    // The engine asks; only this side of the wall can open the sealed store.
    resolveCredentials,
    // Queues belong to the scheduler, so the manager asks rather than owning a
    // second copy of the list. Assigned after the scheduler exists, below.
    queueSpeedLimit: (queueId) => queueSpeedLimitLookup(queueId),
    queuePolicy: (queueId) => queuePolicyLookup(queueId),
    createDashRunner: (task, context) => new DashRunner(task, context),
    refreshYouTube: async (task, force) => {
      if (!task.youtube) throw new Error('Missing YouTube source metadata')
      const audio = task.youtube.role === 'audio'
      // Role-correct: the audio half of a merged download must resolve its own
      // itag, not the video's - see `youtubeFormatId`.
      const formatId = youtubeFormatId(task.youtube)
      if (!formatId) throw new Error('Missing YouTube format identity')
      // What the itag was a name for, so a format yt-dlp has never heard of
      // resolves to the same quality rather than failing the download.
      return refreshYouTubeFormat(task.youtube.pageUrl, task.headers, formatId, force, {
        kind: audio ? 'audio' : 'video',
        height: audio ? null : task.youtube.height ?? null
      })
    }
  })

  const scheduler = new Scheduler({
    manager,
    onQueues: (queues) => send('queues:changed', queues),
    saveQueues,
    onPending: (pending) => send('queues:pending', pending),
    onExitRequested: () => quit()
  })

  queueSpeedLimitLookup = (queueId) =>
    scheduler.list().find((queue) => queue.id === queueId)?.speedLimit ?? null
  queuePolicyLookup = (queueId) => scheduler.list().find((queue) => queue.id === queueId)

  const siteProjects = new SiteProjectManager({
    manager,
    downloadDir: () => getSettings().downloadDir,
    load: loadSiteProjects,
    save: saveSiteProjects
  })

  const pipe = new PipeServer({
    onMessage: (message) => handleHostMessage(message)
  })

  clipboardWatcher = new ClipboardWatcher({
    enabled: () => getSettingsSafe()?.watchClipboard === true,
    onUrl: (url) => {
      if (ctx) prepareClipboardItem(ctx, url)
    }
  })

  ctx = {
    manager,
    scheduler,
    siteProjects,
    pipe,
    media: [],
    pendingHandoffs: [],
    browserInbox: new BrowserHandoffInbox(getPaths().browserHandoffsFile, electronJsonCipher),
    handoffCommits: new Map(),
    pendingOpens: [],
    clipboardItems: [],
    lastHandoffAt: null,
    quit,
    setClipboardWatch: updateClipboardWatcher
  }

  registerIpc(ctx)
  ipcMain.handle('bootstrap:retry', () => void runBootstrap())
  ipcMain.handle('bootstrap:continue', () => {
    if (state.error?.canContinue) finish()
  })

  await runBootstrap()
}

/** Runs the real packaged state loaders and recovery without registering browsers. */
async function verifyDisposableProfile(): Promise<void> {
  const paths = ensureDirs()
  const reportPath = join(paths.root, 'profile-verification.json')
  try {
    await ensureElectronJsonCipherReady(paths.root)
    await loadSettings()
    const originalSettings = getSettings()
    const chosenTheme = originalSettings.theme === 'dark' ? 'light' : 'dark'
    const chosenLanguage = originalSettings.language === 'tr' ? 'en' : 'tr'
    await Promise.all([
      saveSettings({ theme: chosenTheme }),
      saveSettings({ language: chosenLanguage })
    ])
    if (getSettings().theme !== chosenTheme || getSettings().language !== chosenLanguage) {
      throw new Error('Concurrent settings patches did not both commit')
    }
    const savedSettings = JSON.parse(await readFile(paths.settingsFile, 'utf8'))
    if (savedSettings.theme !== chosenTheme || savedSettings.language !== chosenLanguage) {
      throw new Error('Concurrent settings patches were not durable')
    }
    const heldSettings = paths.settingsFile + '.smoke-held'
    await rename(paths.settingsFile, heldSettings)
    try {
      await mkdir(paths.settingsFile)
      try {
        await saveSettings({ theme: originalSettings.theme })
        throw new Error('Blocked settings write unexpectedly succeeded')
      } catch (error) {
        if (String(error).includes('unexpectedly succeeded')) throw error
      }
      if (getSettings().theme !== chosenTheme) {
        throw new Error('Failed settings write changed the live settings')
      }
    } finally {
      await rm(paths.settingsFile, { recursive: true, force: true })
      await rename(heldSettings, paths.settingsFile)
    }
    await saveSettings({ theme: originalSettings.theme })
    const settingsCommitPassed = getSettings().theme === originalSettings.theme
    const tasks = await loadTasks()
    const manager = new DownloadManager({
      getSettings: () => ({ ...getSettings(), tempDir: paths.tempDir }),
      onTasks: persistTasks,
      onProgress() {}
    })
    let writeRetryPassed = false
    if (process.env.DRACO_VERIFY_FAIL_FIRST_WRITE === '1') {
      // The profile is already constrained to a disposable temp directory.
      // Block the primary rename once, then confirm a second flush keeps the
      // restored task snapshot instead of silently losing it.
      const held = paths.tasksFile + '.smoke-held'
      await rename(paths.tasksFile, held)
      try {
        await mkdir(paths.tasksFile)
        await manager.load(tasks)
        try {
          await flushTasks()
          throw new Error('Blocked task write unexpectedly succeeded')
        } catch (error) {
          if (String(error).includes('unexpectedly succeeded')) throw error
        }
      } finally {
        await rm(paths.tasksFile, { recursive: true, force: true })
        await rename(held, paths.tasksFile)
      }
      await flushTasks()
      writeRetryPassed = true
    } else {
      await manager.load(tasks)
      await flushTasks()
    }
    const inbox = new BrowserHandoffInbox(paths.browserHandoffsFile, electronJsonCipher)
    const handoffs = await inbox.load()
    await writeFile(reportPath, JSON.stringify({
      tasks: manager.list().map((task) => ({
        id: task.id, handoffId: task.handoffId, status: task.status, received: task.received
      })),
      writeRetryPassed,
      settingsCommitPassed,
      handoffIds: handoffs.map((item) => item.id)
    }), 'utf8')
    manager.dispose()
    app.exit(0)
  } catch (error) {
    await writeFile(reportPath, JSON.stringify({ error: String(error) }), 'utf8').catch(() => {})
    app.exit(1)
  }
}

/** The retryable half. A step that already succeeded is not run again. */
let bootstrapWork: Promise<void> | null = null
function runBootstrap(): Promise<void> {
  if (bootstrapWork) return bootstrapWork
  bootstrapWork = runBootstrapOnce().finally(() => { bootstrapWork = null })
  return bootstrapWork
}

async function runBootstrapOnce(): Promise<void> {
  if (!ctx) return
  if (finished) return
  state.error = null

  await runStep('appdata', async () => {
    const paths = ensureDirs()
    setLogDirectory(paths.logs)
    setTorrentStoreDir(paths.torrents)
  })
  if (state.error) return

  await runStep('settings', async () => {
    await ensureElectronJsonCipherReady(getPaths().root)
    await loadSettings()
    // Before any task can run, so the first protected download of the session
    // is answered from the store rather than failing while it loads.
    await loadCredentials()
    ctx!.manager.restoreQuota(await loadQuotaState())
    await loadCategories()
  })
  if (state.error) return

  await runStep('restore', async () => {
    const [tasks, queues, clipboardItems] = await Promise.all([
      loadTasks(),
      loadQueues(),
      loadClipboardItems()
    ])
    await ctx!.manager.load(tasks)
    // A failed restore step can be retried from the splash. Rebuild this view
    // from disk instead of appending the same confirmation a second time.
    ctx!.pendingHandoffs = ctx!.pendingHandoffs.filter((request) => request.kind !== 'file')
    restoredHandoffsAwaitingStatus.clear()
    const restoredHandoffs = await ctx!.browserInbox.load()
    const acceptedHandoffs = new Set(tasks.map((task) => task.handoffId).filter(Boolean))
    for (const request of restoredHandoffs) {
      if (acceptedHandoffs.has(request.id)) {
        await ctx!.browserInbox.remove(request.id).catch((error) =>
          log.warn(`could not clear already accepted browser confirmation ${request.id}: ${String(error)}`)
        )
      } else {
        ctx!.pendingHandoffs.push(request)
        restoredHandoffsAwaitingStatus.add(request.id)
      }
    }
    initialRestoreDone = true
    ctx!.scheduler.load(queues)
    await ctx!.siteProjects.start()
    ctx!.media = []
    ctx!.clipboardItems = clipboardItems.map((item) => item.status === 'fetching'
      ? { ...item, status: 'error', error: 'Preparation was interrupted when Draco closed.' }
      : item)
  })
  if (state.error) return

  await runStep('bridge', async () => {
    // The host authenticates with this before it may send anything, so the
    // secret has to exist before the pipe accepts its first connection.
    const secret = await ensurePipeSecret()
    await ctx!.pipe.start(secret)
  })
  if (state.error) return

  await runStep('integration', async () => {
    if (smokeBridgeRequested) return
    // The installer already claims `.torrent` and `magnet:`, but a dev run and
    // a portable copy have no installer, and another client may have taken
    // them since. Best-effort, like the browser registration below it.
    if (getSettings().associateTorrents) {
      await registerShellHandlers().catch((error) =>
        log.warn(`could not register the torrent handlers: ${String(error)}`)
      )
    }

    const registered = await ensureRegistered()
    if (!Object.values(registered).some(Boolean)) {
      // Browser integration is optional. A machine with no supported Chromium
      // browser, a portable install, or a missing extension key must not prevent
      // the download manager itself from starting. The integration can be retried
      // from Options after the user installs/enables it.
      log.warn('no browser integration registered; continuing without browser takeover')
    }
  })

  // A failed step leaves the splash showing Retry / Continue. Opening the main
  // window anyway would make both of those buttons meaningless.
  if (state.error) return

  state.done = true
  publish()
  finish()
}

function finish(): void {
  if (!ctx || finished) return
  finished = true

  if (smokeBridgeRequested) {
    log.info('disposable browser bridge ready')
    return
  }

  // What this launch was asked to open, if it was started by a double-clicked
  // torrent or a magnet link rather than by the user.
  const shellTargets = shellTargetsFromArgv(process.argv)

  closeSplash()
  // A handoff that arrived during startup is what caused this launch in the
  // first place; the window must not open minimised on top of it. The same
  // goes for a torrent the shell handed us.
  createMainWindow(
    getSettings().startMinimized &&
    ctx.pendingHandoffs.every((request) => restoredHandoffsAwaitingStatus.has(request.id)) &&
    shellTargets.length === 0
  )
  createTray({
    onShow: showMainWindow,
    onPauseAll: () => void ctx!.manager.pauseAll(true),
    onQuit: quit
  })

  const expiryTimer = setInterval(() => {
    if (!ctx) return
    void ctx.browserInbox.prune(Date.now(), (id) => ctx?.handoffCommits.has(id) ?? false)
      .then((expired) => {
        for (const id of expired) {
          restoredHandoffsAwaitingStatus.delete(id)
          const at = ctx?.pendingHandoffs.findIndex((request) => request.id === id) ?? -1
          if (at >= 0) ctx?.pendingHandoffs.splice(at, 1)
          closeHandoffWindow(id)
        }
      })
      .catch((error) => log.error(`could not expire browser confirmations: ${String(error)}`))
  }, 10_000)
  expiryTimer.unref?.()

  ctx.scheduler.start()
  clipboardWatcher?.start()
  const updateSettings = getSettings()
  syncDropzoneWindow(updateSettings.showDropzone)
  if (updateSettings.autoCheckUpdates && updateSettings.updateFeedUrl) {
    void checkForUpdates(updateSettings.updateFeedUrl)
      .then((info) => {
        if (info.available) send('toast', {
          kind: 'info',
          message: `Draco ${info.latestVersion} is available. Open Options to download it.`
        })
      })
      .catch((error) => log.warn(`automatic update check failed: ${String(error)}`))
  }

  if (updateSettings.autoCheckUpdates) void announceToolUpdates()

  // After the window exists, so the Add-torrent dialog has somewhere to open.
  // The queue in `ctx.pendingOpens` is what the renderer actually drains, so
  // this cannot race the first paint. Shell targets forwarded by a second
  // instance while bootstrap was still running are drained here too.
  for (const target of [...earlyShellTargets.splice(0), ...shellTargets]) {
    void openShellTarget(ctx, target)
  }

  log.info('ready')
}

/* ------------------------------------------------------------------ */
/* Bootstrap plumbing                                                  */
/* ------------------------------------------------------------------ */

/**
 * Asks the two fetched binaries' publishers whether they have moved on, and
 * tells the window if they have.
 *
 * Delayed and fire-and-forget: it is two HTTPS requests and two `-version`
 * spawns, none of which anybody is waiting for, and startup is already busy.
 * Only ever announced - nothing installs itself, the same rule the app's own
 * update check follows.
 */
async function announceToolUpdates(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  try {
    const tools = await getToolStatus(true)
    const behind = tools.filter((tool) => tool.updateAvailable)
    if (behind.length === 0) return
    log.info(`tool updates available: ${behind.map((t) => `${t.name} ${t.latestVersion}`).join(', ')}`)
    send('tools:updates', behind)
  } catch (error) {
    log.warn(`tool update check failed: ${String(error)}`)
  }
}

function freshState(): BootstrapState {
  return {
    steps: STEPS.map<BootstrapStep>((s) => ({
      id: s.id,
      label: s.label,
      status: 'pending',
      percent: null,
      detail: null
    })),
    overall: 0,
    done: false,
    error: null
  }
}

async function runStep(id: BootstrapStepId, work: () => Promise<void>): Promise<void> {
  const step = state.steps.find((s) => s.id === id)
  if (!step) return

  // Re-running a step that already worked is at best wasted effort and at worst
  // a second listener on the same named pipe.
  if (step.status === 'done') return

  step.status = 'running'
  step.detail = null
  publish()

  try {
    await work()
    step.status = 'done'
  } catch (err) {
    step.status = 'failed'
    step.detail = err instanceof Error ? err.message : String(err)
    // Restoring saved state is load-bearing too: continuing with an empty
    // manager could overwrite downloads that failed to load.
    state.error = {
      step: id,
      message: step.detail,
      canContinue: id === 'bridge' || id === 'integration'
    }
    log.error(`bootstrap step ${id} failed`, err)
  }

  const done = state.steps.filter((s) => s.status === 'done').length
  state.overall = Math.round((done / state.steps.length) * 100)
  publish()
}

function publish(): void {
  sendSplash('bootstrap:state', state)
}

/* ------------------------------------------------------------------ */
/* Messages from the browser                                           */
/* ------------------------------------------------------------------ */

const hostReplyCache = new Map<string, { expiresAt: number; reply: HostReply }>()
const hostReplyInFlight = new Map<string, Promise<HostReply>>()
const cancelledHandoffs = new Map<string, number>()
const HOST_REPLY_TTL_MS = 5 * 60_000
const HOST_REPLY_CACHE_MAX = 512

function hostMessageCanMutate(type: HostMessage['type']): boolean {
  return type === 'download' || type === 'downloadBatch' || type === 'youtube' || type === 'media'
}

function pruneHostReplyCache(now: number): void {
  for (const [id, expiresAt] of cancelledHandoffs) {
    if (expiresAt <= now) cancelledHandoffs.delete(id)
  }
  for (const [key, entry] of hostReplyCache) {
    if (entry.expiresAt <= now) hostReplyCache.delete(key)
  }
  while (hostReplyCache.size > HOST_REPLY_CACHE_MAX) {
    const first = hostReplyCache.keys().next().value as string | undefined
    if (first === undefined) break
    hostReplyCache.delete(first)
  }
}

async function handleHostMessage(message: HostMessage): Promise<HostReply> {
  if (!ctx) return { ok: false, error: 'app not ready' }
  // Captured once. The module-level `ctx` is a mutable `let`, so narrowing it
  // here does not survive into the async closure below.
  const app = ctx
  app.lastHandoffAt = Date.now()

  const now = Date.now()
  pruneHostReplyCache(now)
  const requestId = message.requestId
  if (requestId && hostMessageCanMutate(message.type)) {
    // Download replies are reconstructed from durable task/inbox state below.
    // A cached `taken` after the user removes a task could cancel a browser
    // replay even though no recoverable Draco task exists any more.
    const cached = message.type === 'download' || message.type === 'downloadBatch'
      ? undefined : hostReplyCache.get(requestId)
    if (cached && cached.expiresAt > now) return cached.reply

    const existing = hostReplyInFlight.get(requestId)
    if (existing) return existing

    const work = (async () => {
      const reply = await handleHostMessageOnce(app, message)
      if (message.type !== 'download' && message.type !== 'downloadBatch') {
        hostReplyCache.set(requestId, { expiresAt: Date.now() + HOST_REPLY_TTL_MS, reply })
        pruneHostReplyCache(Date.now())
      }
      return reply
    })()

    hostReplyInFlight.set(requestId, work)
    try {
      return await work
    } finally {
      if (hostReplyInFlight.get(requestId) === work) hostReplyInFlight.delete(requestId)
    }
  }

  return handleHostMessageOnce(app, message)
}

/** `ctx` is a parameter rather than the module-level singleton: the caller has
 * already established that the app is ready, and this must not re-check it. */
async function handleHostMessageOnce(ctx: AppContext, message: HostMessage): Promise<HostReply> {
  switch (message?.type) {
    case 'ping':
      return { ok: true, version }

    case 'config': {
      const s = getSettings()
      return {
        ok: true,
        config: {
          enabled: s.takeoverEnabled,
          minSize: s.takeoverMinSize,
          extensions: s.takeoverExtensions,
          excludeHosts: s.takeoverExcludeHosts
        }
      }
    }

    case 'handoffStatus':
    case 'handoffCancel': {
      const commit = ctx.handoffCommits.get(message.handoffId)
      if (message.type === 'handoffStatus' && commit) return { ok: true, pending: true }
      if (commit) await commit.catch(() => {})
      const accepted = committedBrowserTaskCount(ctx.manager, message.handoffId) > 0
      if (accepted) return { ok: true, taken: true }
      if (message.type === 'handoffCancel') {
        cancelledHandoffs.set(message.handoffId, Date.now() + HOST_REPLY_TTL_MS)
        try {
          await ctx.browserInbox.remove(message.handoffId)
        } catch (error) {
          return { ok: false, pending: true, error: `Could not clear browser confirmation: ${String(error)}` }
        }
        const at = ctx.pendingHandoffs.findIndex((request) => request.id === message.handoffId)
        if (at >= 0) ctx.pendingHandoffs.splice(at, 1)
        restoredHandoffsAwaitingStatus.delete(message.handoffId)
        closeHandoffWindow(message.handoffId)
        return { ok: true, taken: false }
      }
      const request = ctx.pendingHandoffs.find((entry) => entry.id === message.handoffId)
      if (request?.expiresAt && request.expiresAt <= Date.now()) {
        await ctx.browserInbox.remove(request.id)
        ctx.pendingHandoffs.splice(ctx.pendingHandoffs.indexOf(request), 1)
        restoredHandoffsAwaitingStatus.delete(request.id)
        closeHandoffWindow(request.id)
        return { ok: true, pending: false }
      }
      const pending = Boolean(request)
      if (!pending) restoredHandoffsAwaitingStatus.delete(message.handoffId)
      if (pending && restoredHandoffsAwaitingStatus.delete(message.handoffId)) {
        createHandoffWindow(message.handoffId)
      }
      return { ok: true, pending }
    }

    case 'download': {
      if (committedBrowserTaskCount(ctx.manager, message.requestId) > 0) {
        return { ok: true, taken: true }
      }
      if (message.requestId && cancelledHandoffs.has(message.requestId)) {
        return { ok: true, taken: false }
      }
      const settings = getSettings()
      if (!settings.takeoverEnabled) return { ok: true, taken: false }

      try {
        // The extension is not a trusted source - everything it sends started
        // life in a web page - so the URL is validated before the browser is
        // told we have taken it. Rejecting here leaves the download with the
        // browser, which is the safe outcome.
        //
        // `allowPrivate: false` because this is the boundary a page controls:
        // it must not be able to aim the app at localhost or the router with
        // the cookies the extension attaches for that address. URLs the user
        // types themselves keep the default and may still reach an intranet.
        const url = validateUrl(message.url, { allowPrivate: false })

        /*
         * IDM's behaviour: a click in the browser opens a window asking where
         * the file should go, rather than starting it behind your back. Bulk
         * actions skip it, because "download all links" must not mean forty
         * dialogs.
         */
        if (settings.confirmHandoff && !message.bulk) {
          const handoffId = message.requestId ?? randomUUID()
          if (ctx.pendingHandoffs.some((request) => request.id === handoffId)) {
            return { ok: true, pending: true, handoffId }
          }
          if (ctx.pendingHandoffs.length >= 12) return { ok: true, taken: false }
          const request: HandoffRequest = {
            id: handoffId,
            expiresAt: message.handoffExpiresAt ?? Date.now() + 5 * 60_000,
            kind: 'file',
            url,
            filename: message.filename,
            headers: {
              referer: message.referer,
              cookie: message.cookie,
              userAgent: message.userAgent
            },
            size: message.size ?? null,
            mimeType: message.mimeType ?? null,
            pageUrl: message.referer
          }

          await ctx.browserInbox.offer(request)
          try {
            pushPendingHandoff(ctx, request)
          } catch (error) {
            await ctx.browserInbox.remove(request.id)
            throw error
          }

          log.info(`asking about ${message.filename ?? url}`)
          // Its own small window, in front of the browser. The main window is
          // deliberately left where it was: the question was asked in the
          // browser and the answer belongs there too.
          createHandoffWindow(request.id)
          return { ok: true, pending: true, handoffId }
        }

        const task = handoffToTask(ctx, message, false)
        task.handoffId = message.requestId
        await commitBrowserTasks(ctx.manager, [task.id], flushTasks)
        announce(task)
        log.info(`took over ${task.filename}`)
        showMainWindow()
        return { ok: true, taken: true }
      } catch (err) {
        return { ok: false, taken: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    case 'downloadBatch': {
      const settings = getSettings()
      if (!settings.takeoverEnabled) return { ok: true, queued: 0 }

      // A bulk action never asks. That is the whole reason it is a bulk action,
      // and it is why these skip the confirm window and the progress windows
      // that a single click would open.
      const accepted: string[] = []
      let alreadyQueued = 0
      const existingReceipts = new Set(ctx.manager.list().map((task) => task.handoffId))
      for (const [index, item] of message.items.entries()) {
        const receiptId = batchHandoffId(message.requestId, index)
        if (receiptId && existingReceipts.has(receiptId)) {
          alreadyQueued++
          continue
        }
        try {
          const url = validateUrl(item.url, { allowPrivate: false })
          const task = handoffToTask(ctx, {
            url,
            filename: item.filename,
            referer: message.referer,
            cookie: item.cookie,
            userAgent: message.userAgent,
            bulk: true
          }, false)
          task.handoffId = receiptId
          accepted.push(task.id)
        } catch (err) {
          // One bad link in a page's worth of them is not a reason to drop the
          // rest; the count tells the extension how many actually landed.
          log.warn(`skipped a bulk link: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (accepted.length > 0) {
        try {
          await commitBrowserTasks(ctx.manager, accepted, flushTasks)
        } catch (error) {
          return { ok: false, queued: 0, error: `Could not save accepted downloads: ${String(error)}` }
        }
        showMainWindow()
      }
      const queued = alreadyQueued + accepted.length
      log.info(`took over ${queued} of ${message.items.length} bulk link(s)`)
      return { ok: true, queued }
    }

    case 'youtube': {
      try {
        const handoffStartedAt = Date.now()
        if (!isSupportedYouTubeUrl(message.pageUrl)) {
          return { ok: false, error: 'Not a supported YouTube URL' }
        }

        const headers = {
          referer: message.referer ?? message.pageUrl,
          cookie: message.cookie,
          userAgent: message.userAgent
        }

        /*
         * The browser already parsed the ladder in order to play the video, so
         * take it from there. The final dialog is shown only once its variants
         * already carry usable media URLs: either straight from the live player
         * or, when that player exposes metadata only, from yt-dlp here during
         * the browser button's earlier "Checking" stage.
         */
        const instant = resolveYouTubeInstant(
          message.pageUrl,
          message.pageTitle,
          message.pageFormats
        )
        // The page already knows the complete quality ladder even when some
        // entries carry signatureCipher instead of a direct URL. Show that
        // ladder now; the chosen itags are prepared only after confirmation.
        const pagePrepared = Boolean(
          instant && instant.variants.every((variant) =>
            Boolean(variant.url) && (!variant.youtube?.audioFormatId || Boolean(variant.audioUrl))
          )
        )
        const resolved = instant ?? await resolveYouTube(message.pageUrl, headers)
        log.info(
          instant
            ? `instant page ladder: ${resolved.variants.length} qualities` +
              (pagePrepared ? ' (resources prepared)' : ' (resources prepare after selection)')
            : `ladder from yt-dlp: ${resolved.variants.length} qualities` +
              ' (the extension sent no page formats - is it reloaded?)'
        )

        // Cipher resolution overlaps with the time spent choosing a quality.
        // It never delays the window and the selection reuses this cached call.
        if (instant && !pagePrepared) void primeYouTube(message.pageUrl, headers).catch(() => {})

        const candidate = recordMedia(ctx, {
          pageUrl: message.pageUrl,
          pageTitle: resolved.title || message.pageTitle,
          mediaUrl: message.pageUrl,
          variants: resolved.variants,
          kind: 'file',
          referer: message.referer ?? message.pageUrl,
          cookie: message.cookie,
          userAgent: message.userAgent
        })

        const request: HandoffRequest = {
          id: randomUUID(),
          kind: 'media',
          url: candidate.mediaUrl,
          headers: candidate.headers,
          size: null,
          mimeType: null,
          pageUrl: candidate.pageUrl,
          pageTitle: candidate.pageTitle,
          mediaId: candidate.id
        }

        pushPendingHandoff(ctx, request)

        createHandoffWindow(request.id)
        log.info(`YouTube handoff window ready in ${Date.now() - handoffStartedAt} ms`)
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    case 'youtubePrime': {
      if (!isSupportedYouTubeUrl(message.pageUrl)) {
        return { ok: false, primed: false, error: 'Not a supported YouTube URL' }
      }

      const primeStartedAt = Date.now()
      try {
        await primeYouTube(message.pageUrl, {
          referer: message.referer ?? message.pageUrl,
          cookie: message.cookie,
          userAgent: message.userAgent
        })
        log.info(`YouTube extraction cache ready in ${Date.now() - primeStartedAt} ms`)
        return { ok: true, primed: true }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log.warn(`YouTube extraction prefetch failed: ${error}`)
        return { ok: false, primed: false, error }
      }
    }

    case 'media': {
      try {
        // Same untrusted boundary as `download`: the media URL was observed in
        // a page, and resolving it makes the app fetch it.
        validateUrl(message.mediaUrl, { allowPrivate: false })
        if (message.audioUrl) {
          validateUrl(message.audioUrl, { allowPrivate: false })
        }
        for (const relatedUrl of message.relatedMediaUrls ?? []) {
          validateUrl(relatedUrl, { allowPrivate: false })
        }
        const postUrl = message.mediaUrl === message.pageUrl ? xPostUrl(message.pageUrl) : null
        const post = postUrl ? await resolveMediaPage(postUrl, {
          referer: postUrl,
          cookie: message.cookie,
          userAgent: message.userAgent
        }) : null
        const candidate = postUrl
          ? recordMedia(ctx, {
              ...message,
              pageUrl: postUrl,
              mediaUrl: postUrl,
              pageTitle: post!.title,
              variants: post!.variants,
              kind: 'file' as const,
              relatedMediaUrls: []
            })
          : recordMedia(ctx, message)

        // A media message only ever arrives because someone pressed the button
        // on a video, so it gets the same window an ordinary download gets -
        // with a quality to pick before anything starts.
        const request: HandoffRequest = {
          id: randomUUID(),
          kind: 'media',
          url: candidate.mediaUrl,
          headers: candidate.headers,
          size: null,
          mimeType: null,
          pageUrl: candidate.pageUrl,
          pageTitle: candidate.pageTitle,
          mediaId: candidate.id
        }

        pushPendingHandoff(ctx, request)

        createHandoffWindow(request.id)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    default:
      return { ok: false, error: 'unknown message type' }
  }
}

/* ------------------------------------------------------------------ */
/* Shutdown                                                            */
/* ------------------------------------------------------------------ */

function quit(): void {
  app.quit()
}

let shutdownStarted = false

app.on('before-quit', (event) => {
  if (shutdownStarted) return

  // Downloads must be paused and their journals flushed before the process goes
  // away, or the next launch loses everything since the last flush. Quitting is
  // therefore asynchronous: hold the quit, drain, then exit for real.
  shutdownStarted = true
  event.preventDefault()
  void shutdown().then(() => {
    destroyTray()
    app.exit(0)
  }).catch((error) => {
    shutdownStarted = false
    cancelQuit()
    log.error(`shutdown could not save state: ${String(error)}`)
    showMainWindow()
    dialog.showErrorBox('Draco could not quit safely',
      `One or more downloads could not stop or their latest state could not be saved. Draco remains open. Check disk space and folder permissions, then try Quit again.\n\n${String(error)}`)
  })
})

async function shutdown(): Promise<void> {
  log.info('shutting down')
  clipboardWatcher?.stop()
  ctx?.scheduler.stop()
  ctx?.siteProjects.dispose()
  let managerError: unknown = null
  try {
    await ctx?.manager.shutdown()
  } catch (error) {
    managerError = error
    log.error('manager shutdown encountered an error', error)
  }
  await ctx?.pipe.stop().catch((error) => log.error('pipe server stop failed', error))
  const flushes = await Promise.allSettled([flushTasks(), flushQuotaState()])
  const failures = flushes.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  await closeDispatchers().catch(() => {})
  if (managerError) throw managerError
  if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'State flush failed')
}

app.on('window-all-closed', () => {
  // The tray keeps the app alive on Windows; closing the window is not quitting
  // unless the user turned that off.
  if (!getSettingsSafe()?.closeToTray) quit()
})

function getSettingsSafe(): ReturnType<typeof getSettings> | null {
  try {
    return getSettings()
  } catch {
    return null
  }
}
