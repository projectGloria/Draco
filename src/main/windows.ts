import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

/**
 * Window creation. The renderer runs with no Node integration and context
 * isolation on - everything privileged is reached through the preload bridge.
 */

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null

const preload = join(__dirname, '../preload/index.js')

function rendererUrl(
  page: 'index' | 'splash' | 'handoff',
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
    webPreferences: { preload, sandbox: false, contextIsolation: true }
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

export function createMainWindow(startMinimized: boolean): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 860,
    minHeight: 480,
    show: false,
    frame: false,
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hidden',
    webPreferences: { preload, sandbox: false, contextIsolation: true }
  })

  mainWindow.once('ready-to-show', () => {
    if (startMinimized) mainWindow?.minimize()
    else mainWindow?.show()
  })

  // Downloads are full of outbound links; none of them should ever open inside
  // the app's own window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
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

export function createHandoffWindow(requestId: string): BrowserWindow {
  const existing = handoffWindows.get(requestId)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return existing
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
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#0b0e14',
    // Stacked slightly so a burst of downloads does not hide them all behind
    // one another in exactly the same spot.
    x: undefined,
    y: undefined,
    webPreferences: { preload, sandbox: false, contextIsolation: true }
  })

  const offset = handoffWindows.size * 26
  if (offset > 0) {
    const [x, y] = window.getPosition()
    window.setPosition(x + offset, y + offset)
  }

  window.once('ready-to-show', () => {
    window.show()
    window.focus()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
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

export function sendSplash(channel: string, ...args: unknown[]): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send(channel, ...args)
  }
}
