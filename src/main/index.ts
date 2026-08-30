import { app, ipcMain, powerSaveBlocker, Notification } from 'electron'
import { version } from '../../package.json'
import { randomUUID } from 'node:crypto'
import type {
  BootstrapState,
  BootstrapStep,
  BootstrapStepId,
  HandoffRequest,
  TaskStatus
} from '@shared/types'
import { ensureDirs } from './bootstrap/paths.ts'
import { ClipboardWatcher } from './clipboard.ts'
import { ensureRegistered } from './bridge/integration.ts'
import { PipeServer } from './bridge/pipe-server.ts'
import type { HostMessage, HostReply } from './bridge/protocol.ts'
import { validateUrl } from './engine/create.ts'
import { closeDispatchers } from './engine/http.ts'
import { DownloadManager } from './engine/manager.ts'
import { MpdRunner } from './dash/runner.ts'
import { HlsRunner } from './hls/runner.ts'
import { handoffToTask, recordMedia, refileTask, registerIpc, type AppContext } from './ipc.ts'
import { logger, setLogDirectory } from './log.ts'
import { Scheduler } from './queue/scheduler.ts'
import { SiteProjectManager } from './site-grabber/projects.ts'
import {
  flushTasks,
  flushQuotaState,
  getSettings,
  loadCategories,
  loadQueues,
  loadQuotaState,
  loadSettings,
  loadSiteProjects,
  loadTasks,
  persistTasks,
  persistQuotaState,
  saveQueues,
  saveSiteProjects
} from './store.ts'
import { createTray, destroyTray } from './tray.ts'
import { checkForUpdates } from './update.ts'
import {
  broadcast,
  closeSplash,
  createHandoffWindow,
  createMainWindow,
  createSplashWindow,
  send,
  sendSplash,
  showMainWindow,
  updateProgressWindow
} from './windows.ts'

import { DashRunner } from './hls/dash.ts'
import {
  primeYouTube,
  refreshYouTubeFormat,
  resolveYouTube,
  resolveYouTubeInstant
} from './youtube.ts'

const log = logger('main')

/**
 * Startup is a real sequence, not a delay: the splash goes up before any slow
 * work, each step reports in, and the main window is only created once the app
 * can actually function. A failed step turns the splash into an error card with
 * Retry / Continue - it must never hang on a spinner, and it must never quietly
 * carry on as though nothing had gone wrong.
 */

const STEPS: Array<{ id: BootstrapStepId; label: string }> = [
  { id: 'appdata', label: 'Preparing app data' },
  { id: 'settings', label: 'Loading settings' },
  { id: 'restore', label: 'Restoring downloads' },
  { id: 'bridge', label: 'Starting the browser bridge' },
  { id: 'integration', label: 'Registering browser integration' }
]

let ctx: AppContext | null = null
let clipboardWatcher: ClipboardWatcher | null = null

export function updateClipboardWatcher(enabled: boolean) {
  if (enabled) clipboardWatcher?.start()
  else clipboardWatcher?.stop()
}
const state: BootstrapState = freshState()
let finished = false
let powerSaveBlockerId: number | null = null
const taskStatuses = new Map<string, TaskStatus>()

/* ------------------------------------------------------------------ */
/* Single instance                                                     */
/* ------------------------------------------------------------------ */

// Two copies would fight over the named pipe and over tasks.json. The second
// launch just surfaces the first - which is also what the native host relies on
// when it starts the app to service a handoff.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
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

  createSplashWindow()

  const manager = new DownloadManager({
    getSettings: () => {
      const s = getSettings()
      return {
        maxConcurrentTasks: s.maxConcurrentTasks,
        maxConnectionsPerTask: s.maxConnectionsPerTask,
        minSplitSize: s.minSplitSize,
        retryLimit: s.retryLimit,
        timeoutMs: s.timeoutMs,
        speedLimit: s.speedLimit,
        proxyUrl: s.proxyUrl,
        hostConnectionLimits: s.hostConnectionLimits,
        quotaBytes: s.quotaBytes,
        quotaWindowMinutes: s.quotaWindowMinutes,
        antivirusProgram: s.antivirusProgram,
        antivirusArgs: s.antivirusArgs,
        antivirusTimeoutSeconds: s.antivirusTimeoutSeconds
      }
    },
    onTasks: (tasks) => {
      persistTasks(tasks)
      // Broadcast rather than sent: each open progress window is watching the
      // same feed for the one task it is about.
      broadcast('tasks:changed', tasks)
      for (const task of tasks) updateProgressWindow(task)

      let newlyDone = 0
      let hasActive = false
      for (const t of tasks) {
        if (t.status === 'done' && taskStatuses.get(t.id) !== 'done') {
          newlyDone++
        }
        taskStatuses.set(t.id, t.status)
        if (t.status === 'downloading' || t.status === 'probing') {
          hasActive = true
        }
      }

      if (newlyDone > 0) {
        new Notification({
          title: newlyDone === 1 ? 'Download Complete' : `${newlyDone} Downloads Complete`,
          body: newlyDone === 1 ? tasks.find(t => t.status === 'done')?.filename : 'Your files have finished downloading.',
        }).show()
      }

      if (hasActive && powerSaveBlockerId === null) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      } else if (!hasActive && powerSaveBlockerId !== null) {
        powerSaveBlocker.stop(powerSaveBlockerId)
        powerSaveBlockerId = null
      }
    },
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
          timeoutMs: context.timeoutMs
        },
        {
          limiter: context.limiter,
          onUpdate: context.onUpdate,
          onFinished: context.onFinished,
          onProbed: context.onProbed
        }
      ),
    createMpdRunner: (task, context) => new MpdRunner(task, context),
    createDashRunner: (task, context) => new DashRunner(task, context),
    refreshYouTube: async (task, force) => {
      if (!task.youtube) throw new Error('Missing YouTube source metadata')
      const formatId = task.youtube.role === 'audio' ? task.youtube.audioFormatId : task.youtube.videoFormatId
      if (!formatId) throw new Error('Missing YouTube format identity')
      return refreshYouTubeFormat(task.youtube.pageUrl, task.headers, formatId, force)
    }
  })

  const scheduler = new Scheduler({
    manager,
    onQueues: (queues) => send('queues:changed', queues),
    saveQueues,
    onPending: (pending) => send('queues:pending', pending),
    onExitRequested: () => quit()
  })

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
      // Only a suggestion: the renderer opens Save As with it, and the user is
      // one Escape away from ignoring it.
      showMainWindow()
      send('clipboard:url', url)
    }
  })

  ctx = {
    manager,
    scheduler,
    siteProjects,
    pipe,
    media: [],
    pendingHandoffs: [],
    lastHandoffAt: null,
    quit
  }

  registerIpc(ctx)
  ipcMain.handle('bootstrap:retry', () => void runBootstrap())
  ipcMain.handle('bootstrap:continue', () => finish())

  await runBootstrap()
}

/** The retryable half. A step that already succeeded is not run again. */
async function runBootstrap(): Promise<void> {
  if (!ctx) return
  state.error = null

  await runStep('appdata', async () => {
    const paths = ensureDirs()
    setLogDirectory(paths.logs)
  })

  await runStep('settings', async () => {
    await loadSettings()
    ctx!.manager.restoreQuota(await loadQuotaState())
    await loadCategories()
  })

  await runStep('restore', async () => {
    const [tasks, queues] = await Promise.all([loadTasks(), loadQueues()])
    await ctx!.manager.load(tasks)
    ctx!.scheduler.load(queues)
    await ctx!.siteProjects.start()
    ctx!.media = []
  })

  await runStep('bridge', async () => {
    await ctx!.pipe.start()
  })

  await runStep('integration', async () => {
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

  closeSplash()
  // A handoff that arrived during startup is what caused this launch in the
  // first place; the window must not open minimised on top of it.
  createMainWindow(getSettings().startMinimized && ctx.pendingHandoffs.length === 0)
  createTray({
    onShow: showMainWindow,
    onPauseAll: () => void ctx!.manager.pauseAll(),
    onQuit: quit
  })

  ctx.scheduler.start()
  clipboardWatcher?.start()
  const updateSettings = getSettings()
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
  log.info('ready')
}

/* ------------------------------------------------------------------ */
/* Bootstrap plumbing                                                  */
/* ------------------------------------------------------------------ */

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
    // Only the first two steps are load-bearing; the rest degrade gracefully,
    // so the splash offers "Continue anyway" rather than a dead end.
    state.error = {
      step: id,
      message: step.detail,
      canContinue: id !== 'appdata' && id !== 'settings'
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
const HOST_REPLY_TTL_MS = 5 * 60_000
const HOST_REPLY_CACHE_MAX = 512

function hostMessageCanMutate(type: HostMessage['type']): boolean {
  return type === 'download' || type === 'youtube' || type === 'media'
}

function pruneHostReplyCache(now: number): void {
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
    const cached = hostReplyCache.get(requestId)
    if (cached && cached.expiresAt > now) return cached.reply

    const existing = hostReplyInFlight.get(requestId)
    if (existing) return existing

    const work = (async () => {
      const reply = await handleHostMessageOnce(app, message)
      hostReplyCache.set(requestId, { expiresAt: Date.now() + HOST_REPLY_TTL_MS, reply })
      pruneHostReplyCache(Date.now())
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

    case 'download': {
      const settings = getSettings()
      if (!settings.takeoverEnabled) return { ok: true, taken: false }

      try {
        // The extension is not a trusted source - everything it sends started
        // life in a web page - so the URL is validated before the browser is
        // told we have taken it. Rejecting here leaves the download with the
        // browser, which is the safe outcome.
        const url = validateUrl(message.url)

        /*
         * IDM's behaviour: a click in the browser opens a window asking where
         * the file should go, rather than starting it behind your back. Bulk
         * actions skip it, because "download all links" must not mean forty
         * dialogs.
         */
        if (settings.confirmHandoff && !message.bulk) {
          const request: HandoffRequest = {
            id: randomUUID(),
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

          ctx.pendingHandoffs.push(request)
          // Bounded: a page that fires a burst of downloads must not be able to
          // stack up an unbounded pile of windows.
          if (ctx.pendingHandoffs.length > 12) ctx.pendingHandoffs.shift()

          log.info(`asking about ${message.filename ?? url}`)
          // Its own small window, in front of the browser. The main window is
          // deliberately left where it was: the question was asked in the
          // browser and the answer belongs there too.
          createHandoffWindow(request.id)
          return { ok: true, taken: true }
        }

        const task = handoffToTask(ctx, message)
        log.info(`took over ${task.filename}`)
        showMainWindow()
        return { ok: true, taken: true }
      } catch (err) {
        return { ok: false, taken: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    case 'youtube': {
      try {
        const handoffStartedAt = Date.now()
        if (!/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com)(?:\/|$)|^https?:\/\/youtu\.be\//i.test(message.pageUrl)) {
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

        ctx.pendingHandoffs.push(request)
        if (ctx.pendingHandoffs.length > 12) ctx.pendingHandoffs.shift()

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
        const candidate = recordMedia(ctx, message)

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

        ctx.pendingHandoffs.push(request)
        if (ctx.pendingHandoffs.length > 12) ctx.pendingHandoffs.shift()

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

function isSupportedYouTubeUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (
      /(^|\.)youtube\.com$/i.test(url.hostname) ||
      /(^|\.)youtu\.be$/i.test(url.hostname)
    )
  } catch {
    return false
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
  void shutdown().finally(() => app.exit(0))
})

async function shutdown(): Promise<void> {
  log.info('shutting down')
  destroyTray()
  clipboardWatcher?.stop()
  ctx?.scheduler.stop()
  ctx?.siteProjects.dispose()
  await ctx?.manager.shutdown()
  await ctx?.pipe.stop()
  await flushTasks()
  await flushQuotaState()
  await closeDispatchers()
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
