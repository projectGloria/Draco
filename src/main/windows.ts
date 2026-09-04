import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { DownloadTask } from '../shared/types.ts'
import { iconForSite } from './icons.ts'

function getIconPath(): string {
  const packaged = join(process.resourcesPath, 'icon.ico')
  const dev = join(app.getAppPath(), 'resources', 'icon.ico')
  return existsSync(packaged) ? packaged : dev
}

/**
 * Window creation. The renderer runs with no Node integration and context
 * isolation on - everything privileged is reached through the preload bridge.
 *
 * `sandbox: true` throughout, which is affordable precisely because that bridge
 * is the whole surface: the preload asks for nothing but `electron`'s
 * `ipcRenderer`, and a sandboxed preload can still have that. It puts every
 * renderer in an OS-level sandbox, so a bug in one of them is not a bug with
 * the run of the machine.
 */

/**
 * Hands a link to the desktop, but only ever a web link.
 *
 * `shell.openExternal` will launch whatever protocol handler Windows has
 * registered, so passing it an unfiltered string means a page-supplied
 * `ms-something:` or `file:` URL would be executed by the shell rather than
 * opened by a browser. Nothing renders anchors today; this keeps that from
 * being the only thing standing between a page and the shell.
 */
function openExternally(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
  } catch {
    return
  }
  void shell.openExternal(url)
}

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null

const preload = join(__dirname, '../preload/index.js')

function rendererUrl(
  page: 'index' | 'splash' | 'handoff' | 'progress',
  query = ''
): { url?: string; file?: string; query: string } {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) return { url: `${devServer}/${page}.html${query}`, query }
  return { file: join(__dirname, `../renderer/${page}.html`), query }
}

export function createSplashWindow(): BrowserWindow {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    resizable: false,
    show: true,
    backgroundColor: '#0b0e14',
    icon: getIconPath(),
    webPreferences: { preload, sandbox: true, contextIsolation: true }
  })

  const target = rendererUrl('splash')
  if (target.url) void splashWindow.loadURL(target.url)
  else void splashWindow.loadFile(target.file!)

  splashWindow.on('closed', () => {
    splashWindow = null
  })

  return splashWindow
}

export function getSplashWindow(): BrowserWindow | null {
  return splashWindow
}

export function closeSplash(): void {
  splashWindow?.destroy()
  splashWindow = null
}

let dropzoneWindow: BrowserWindow | null = null

export function syncDropzoneWindow(show: boolean): void {
  if (show) {
    if (!dropzoneWindow || dropzoneWindow.isDestroyed()) {
      dropzoneWindow = new BrowserWindow({
        width: 100,
        height: 100,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true }
      })
      
      const target = rendererUrl('index', '#dropzone')
      if (target.url) void dropzoneWindow.loadURL(target.url)
      else void dropzoneWindow.loadFile(target.file!, { hash: 'dropzone' })
      
      dropzoneWindow.on('closed', () => {
        dropzoneWindow = null
      })
    } else {
      dropzoneWindow.show()
    }
  } else {
    if (dropzoneWindow && !dropzoneWindow.isDestroyed()) {
      dropzoneWindow.close()
    }
  }
}

export function createMainWindow(startMinimized: boolean): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 620,
    minHeight: 480,
    show: false,
    frame: false,
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hidden',
    icon: getIconPath(),
    webPreferences: { preload, sandbox: true, contextIsolation: true }
  })

  mainWindow.once('ready-to-show', () => {
    if (startMinimized) mainWindow?.minimize()
    else mainWindow?.show()
  })

  // Downloads are full of outbound links; none of them should ever open inside
  // the app's own window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  const target = rendererUrl('index')
  if (target.url) void mainWindow.loadURL(target.url)
  else void mainWindow.loadFile(target.file!)

  // The window can also be maximized by double-clicking the drag region or by
  // Win+Up, so the renderer cannot infer this from its own button presses.
  mainWindow.on('maximize', () => send('window:maximized', true))
  mainWindow.on('unmaximize', () => send('window:maximized', false))

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/* ------------------------------------------------------------------ */
/* The confirm window                                                  */
/* ------------------------------------------------------------------ */

/**
 * IDM's download dialog: a small window of its own that appears in front of
 * whatever you were doing, rather than a modal buried inside the main window.
 *
 * That distinction matters in practice. The click that triggered this happened
 * in the browser, so the answer has to arrive on top of the browser - dragging
 * the whole download manager to the foreground to ask a two-field question is
 * exactly the interruption IDM avoids.
 */
const handoffWindows = new Map<string, BrowserWindow>()
/** Each is a Chromium renderer process; a page firing a burst of downloads
 * must not be able to open an unbounded number of them. */
const MAX_HANDOFF_WINDOWS = 12

export function createHandoffWindow(requestId: string): BrowserWindow {
  const existing = handoffWindows.get(requestId)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return existing
  }

  if (handoffWindows.size >= MAX_HANDOFF_WINDOWS) {
    const oldestId = handoffWindows.keys().next().value
    if (oldestId !== undefined) closeHandoffWindow(oldestId)
  }

  const window = new BrowserWindow({
    width: 520,
    // Sized to the taller of the two layouts - the media one, which carries a
    // quality picker the file one does not.
    height: 486,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: true,
    alwaysOnTop: true,
    backgroundColor: '#0b0e14',
    icon: getIconPath(),
    // Stacked slightly so a burst of downloads does not hide them all behind
    // one another in exactly the same spot.
    x: undefined,
    y: undefined,
    webPreferences: { preload, sandbox: true, contextIsolation: true }
  })

  const offset = (handoffCounter++ % 10) * 26
  if (offset > 0) {
    const [x, y] = window.getPosition()
    window.setPosition(x + offset, y + offset)
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  const target = rendererUrl('handoff', `?id=${encodeURIComponent(requestId)}`)
  if (target.url) void window.loadURL(target.url)
  else void window.loadFile(target.file!, { search: target.query.replace(/^\?/, '') })

  window.on('closed', () => handoffWindows.delete(requestId))
  handoffWindows.set(requestId, window)
  return window
}

export function closeHandoffWindow(requestId: string): void {
  const window = handoffWindows.get(requestId)
  if (window && !window.isDestroyed()) window.close()
  handoffWindows.delete(requestId)
}

/** Finds the request a given web contents belongs to, for its own Close button. */
export function handoffIdForWebContents(id: number): string | null {
  for (const [requestId, window] of handoffWindows) {
    if (!window.isDestroyed() && window.webContents.id === id) return requestId
  }
  return null
}

/* ------------------------------------------------------------------ */
/* The progress window                                                 */
/* ------------------------------------------------------------------ */

/**
 * IDM's per-download window: one small window per download the user started,
 * showing what it is doing and offering the three buttons that matter, and
 * turning into the "download complete" card when it finishes.
 *
 * It is a window rather than a row highlight because the whole point is that it
 * is visible without the main window: the download was started from the browser
 * and the person is still in the browser.
 */
const progressWindows = new Map<string, BrowserWindow>()
const progressWindowIconOrigins = new Map<string, string>()
let handoffCounter = 0
let progressCounter = 0
/** Same reasoning as MAX_HANDOFF_WINDOWS: dropping 40 links must not open 40
 * Chromium renderer processes. */
const MAX_PROGRESS_WINDOWS = 8

export function createProgressWindow(taskId: string): BrowserWindow {
  const existing = progressWindows.get(taskId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    return existing
  }

  if (progressWindows.size >= MAX_PROGRESS_WINDOWS) {
    const oldestId = progressWindows.keys().next().value
    if (oldestId !== undefined) closeProgressWindow(oldestId)
  }

  const window = new BrowserWindow({
    width: 470,
    height: 300,
    resizable: false,
    // Minimisable, unlike the confirm window: that one asks a question and is
    // gone, this one may sit there for an hour and has to be got out of the way
    // without abandoning the download.
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: true,
    backgroundColor: '#0b0e14',
    icon: getIconPath(),
    webPreferences: { preload, sandbox: true, contextIsolation: true }
  })

  // Same reason the confirm windows stagger: a handful of downloads started in
  // a row must not stack into one apparent window.
  const offset = (progressCounter++ % 10) * 26
  if (offset > 0) {
    const [x, y] = window.getPosition()
    window.setPosition(x + offset, y + offset)
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  const target = rendererUrl('progress', `?id=${encodeURIComponent(taskId)}`)
  if (target.url) void window.loadURL(target.url)
  else void window.loadFile(target.file!, { search: target.query.replace(/^\?/, '') })

  window.on('closed', () => {
    progressWindows.delete(taskId)
    progressWindowIconOrigins.delete(taskId)
  })
  progressWindows.set(taskId, window)
  return window
}

export function closeProgressWindow(taskId: string): void {
  const window = progressWindows.get(taskId)
  if (window && !window.isDestroyed()) window.close()
  progressWindows.delete(taskId)
}

/** The task ids that currently have an open progress window. */
export function progressWindowTaskIds(): string[] {
  return [...progressWindows.keys()]
}

/** Keeps Windows' taskbar hover text and progress indicator useful while the
 * frameless per-download window is minimized. */
export function updateProgressWindow(task: DownloadTask): void {
  const window = progressWindows.get(task.id)
  if (!window || window.isDestroyed()) return

  const knownPercent = task.size && task.size > 0
    ? Math.max(0, Math.min(100, Math.floor((task.received / task.size) * 100)))
    : null
  const label = task.filename || 'Preparing download'
  const state = task.status === 'done'
    ? 'Complete'
    : task.status === 'paused'
      ? knownPercent === null ? 'Paused' : `Paused · ${knownPercent}%`
      : task.status === 'error' || task.status === 'missing'
        ? 'Failed'
        : knownPercent === null
          ? 'Downloading'
          : `${knownPercent}%`

  window.setTitle(`${state} · ${label} — Draco`)
  updateProgressWindowSiteIcon(window, task)

  if (task.status === 'done') {
    window.setProgressBar(-1)
  } else if (task.status === 'error' || task.status === 'missing') {
    window.setProgressBar(knownPercent === null ? 1 : knownPercent / 100, { mode: 'error' })
  } else if (task.status === 'paused') {
    window.setProgressBar(knownPercent === null ? 1 : knownPercent / 100, { mode: 'paused' })
  } else if (task.status === 'downloading' || task.status === 'probing' || task.status === 'queued') {
    window.setProgressBar(knownPercent === null ? 2 : knownPercent / 100, { mode: 'normal' })
  } else {
    window.setProgressBar(-1)
  }
}

function updateProgressWindowSiteIcon(window: BrowserWindow, task: DownloadTask): void {
  const sourceUrl = task.sourceUrl ?? task.youtube?.pageUrl ?? task.url
  let origin: string
  try {
    origin = new URL(sourceUrl).origin
  } catch {
    return
  }
  if (progressWindowIconOrigins.get(task.id) === origin) return
  progressWindowIconOrigins.set(task.id, origin)

  void iconForSite(sourceUrl).then((dataUrl) => {
    if (!dataUrl || window.isDestroyed() || progressWindowIconOrigins.get(task.id) !== origin) return
    const image = nativeImage.createFromDataURL(dataUrl)
    if (!image.isEmpty()) window.setIcon(image)
  })
}

/** Brings the window back from the tray or a minimised state. */
export function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Sends on a channel only when there is a live window to receive it. */
export function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

/**
 * Sends to every window that shows live download state.
 *
 * The progress windows are fed the same `tasks:changed` and `tasks:progress`
 * feeds the main list is, rather than a private per-task channel: one source of
 * truth means a paused download cannot read as running in one window and paused
 * in the other.
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  send(channel, ...args)
  for (const window of progressWindows.values()) {
    if (!window.isDestroyed()) window.webContents.send(channel, ...args)
  }
}

export function sendSplash(channel: string, ...args: unknown[]): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send(channel, ...args)
  }
}
