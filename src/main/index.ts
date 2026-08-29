import { app, ipcMain } from 'electron'
import { version } from '../../package.json'
import { randomUUID } from 'node:crypto'
import type {
  BootstrapState,
  BootstrapStep,
  BootstrapStepId,
  HandoffRequest,
  MediaCandidate
} from '@shared/types'
import { ensureDirs } from './bootstrap/paths.ts'
import { ClipboardWatcher } from './clipboard.ts'
import { ensureRegistered } from './bridge/integration.ts'
import { PipeServer } from './bridge/pipe-server.ts'
import type { HostMessage, HostReply } from './bridge/protocol.ts'
import { validateUrl } from './engine/create.ts'
import { closeDispatchers } from './engine/http.ts'
import { DownloadManager } from './engine/manager.ts'
import { HlsRunner } from './hls/runner.ts'
import { handoffToTask, recordMedia, refileTask, registerIpc, type AppContext } from './ipc.ts'
import { logger } from './log.ts'
import { Scheduler } from './queue/scheduler.ts'
import {
  flushTasks,
  getSettings,
  loadCategories,
  loadMedia,
  loadQueues,
  loadSettings,
  loadTasks,
  persistTasks,
  saveQueues
} from './store.ts'
import { createTray, destroyTray } from './tray.ts'
import {
  closeSplash,
  createHandoffWindow,
  createMainWindow,
  createSplashWindow,
  send,
  sendSplash,
  showMainWindow
} from './windows.ts'

import { DashRunner } from './hls/dash.ts'

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
const state: BootstrapState = freshState()
let finished = false

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
        speedLimit: s.speedLimit
      }
    },
    onTasks: (tasks) => {
      persistTasks(tasks)
      send('tasks:changed', tasks)
    },
    onProgress: (updates) => send('tasks:progress', updates),
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
    createDashRunner: (task, context) => new DashRunner(task, context)
  })

  const scheduler = new Scheduler({
    manager,
    onQueues: (queues) => send('queues:changed', queues),
    saveQueues,
    onPending: (pending) => send('queues:pending', pending),
    onExitRequested: () => quit()
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
    ensureDirs()
  })

  await runStep('settings', async () => {
    await loadSettings()
    await loadCategories()
  })

  await runStep('restore', async () => {
    const [tasks, queues, media] = await Promise.all([loadTasks(), loadQueues(), loadMedia()])
    await ctx!.manager.load(tasks)
    ctx!.scheduler.load(queues)
    ctx!.media = media as MediaCandidate[]
  })

  await runStep('bridge', async () => {
    await ctx!.pipe.start()
  })

  await runStep('integration', async () => {
    const registered = await ensureRegistered()
    if (!registered.chrome && !registered.edge && !registered.brave) {
      // Not fatal: the app is perfectly usable without the browser link, and
      // the extension key may simply not have been generated yet.
      throw new Error('No browser could be registered yet')
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

async function handleHostMessage(message: HostMessage): Promise<HostReply> {
  if (!ctx) return { ok: false, error: 'app not ready' }
  ctx.lastHandoffAt = Date.now()

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
  await ctx?.manager.shutdown()
  await ctx?.pipe.stop()
  await flushTasks()
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
