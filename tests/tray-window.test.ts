import { strictEqual, notStrictEqual } from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'node:test'

// Execute the actual window/tray handlers with native Electron objects replaced.
// Each fixture has fresh module state and never opens a UI or touches app data.
class TestWindow extends EventEmitter {
  destroyed = false
  visible = false
  minimized = false
  focused = false
  webContents = {
    setWindowOpenHandler: () => {},
    on: () => {},
    send: () => {}
  }

  isDestroyed() { return this.destroyed }
  isMinimized() { return this.minimized }
  minimize() { this.minimized = true }
  restore() { this.minimized = false }
  show() { this.visible = true }
  hide() { this.visible = false }
  focus() { this.focused = true }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
  close() {
    let prevented = false
    this.emit('close', { preventDefault: () => { prevented = true } })
    if (!prevented) this.destroy()
  }
}

function fixture() {
  const windows: TestWindow[] = []
  const settings = { closeToTray: true }
  let quits = 0
  const app = Object.assign(new EventEmitter(), {
    getAppPath: () => process.cwd(),
    quit: () => { quits++; app.emit('before-quit') }
  })
  const source = readFileSync(new URL('../src/main/windows.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source)
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  const api = runInNewContext(code + '\n({ createMainWindow, createSplashWindow, showMainWindow, getMainWindow })', {
    ...path,
    fileURLToPath,
    __dirname: path.resolve('src/main'),
    process: { resourcesPath: process.cwd(), env: {} },
    existsSync: () => false,
    app,
    BrowserWindow: class extends TestWindow {
      constructor() { super(); windows.push(this) }
    },
    getSettings: () => settings,
    iconForSite: async () => null
  }) as {
    createMainWindow(minimized: boolean): TestWindow
    createSplashWindow(): TestWindow
    showMainWindow(): void
    getMainWindow(): TestWindow | null
  }
  return { api, windows, settings, app, quits: () => quits }
}

describe('reopening Draco from the tray', () => {
  it('restores and focuses the existing hidden/minimized window', () => {
    const { api, windows } = fixture()
    const window = api.createMainWindow(false)
    window.minimize()
    window.hide()
    api.showMainWindow()
    strictEqual(window.visible, true)
    strictEqual(window.minimized, false)
    strictEqual(window.focused, true)
    strictEqual(windows.length, 1)
  })

  it('keeps native Close in the tray and can reopen it', () => {
    const { api } = fixture()
    const window = api.createMainWindow(false)
    window.show()
    window.close()
    strictEqual(window.destroyed, false)
    strictEqual(window.visible, false)
    api.showMainWindow()
    strictEqual(api.getMainWindow(), window)
    strictEqual(window.visible, true)
  })

  it('recreates a destroyed main window without restarting the app', () => {
    const { api, windows, quits } = fixture()
    const old = api.createMainWindow(false)
    old.destroy()
    api.showMainWindow()
    const replacement = api.getMainWindow()!
    notStrictEqual(replacement, old)
    strictEqual(replacement.visible, true)
    strictEqual(replacement.focused, true)
    api.showMainWindow()
    strictEqual(windows.length, 2, 'repeated tray clicks reuse the replacement')
    strictEqual(quits(), 0)
  })

  it('ignores late events from an old destroyed window', () => {
    const { api } = fixture()
    const old = api.createMainWindow(true)
    old.destroyed = true
    api.showMainWindow()
    const replacement = api.getMainWindow()!
    old.emit('closed')
    old.emit('ready-to-show')
    strictEqual(api.getMainWindow(), replacement)
    strictEqual(replacement.minimized, false)
  })

  it('does not minimize again when a tray click beats ready-to-show', () => {
    const { api } = fixture()
    const window = api.createMainWindow(true)
    api.showMainWindow()
    window.emit('ready-to-show')
    strictEqual(window.visible, true)
    strictEqual(window.minimized, false)
  })

  it('preserves start-minimized when there was no open request', () => {
    const { api } = fixture()
    const window = api.createMainWindow(true)
    window.emit('ready-to-show')
    strictEqual(window.minimized, true)
  })

  it('shows the splash rather than opening the main UI before bootstrap', () => {
    const { api, windows } = fixture()
    api.showMainWindow()
    strictEqual(windows.length, 0)
    const splash = api.createSplashWindow()
    api.showMainWindow()
    strictEqual(splash.visible, true)
    strictEqual(splash.focused, true)
    strictEqual(api.getMainWindow(), null)
  })

  it('honors native Close when close-to-tray is disabled', () => {
    const { api, settings, quits } = fixture()
    settings.closeToTray = false
    api.createMainWindow(false).close()
    strictEqual(quits(), 1)
  })

  it('allows quitting and never recreates a window during shutdown', () => {
    const { api, app, windows } = fixture()
    const window = api.createMainWindow(false)
    app.emit('before-quit')
    window.close()
    strictEqual(window.destroyed, true)
    api.showMainWindow()
    strictEqual(api.getMainWindow(), null)
    strictEqual(windows.length, 1)
  })
})

it('tray single-click, double-click and Open Draco all request the UI', () => {
  let opens = 0
  let menu: Array<{ label?: string; click?: () => void }> = []
  class TestTray extends EventEmitter {
    setToolTip() {}
    setContextMenu(value: typeof menu) { menu = value }
  }
  const source = readFileSync(new URL('../src/main/tray.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source)
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
  const { createTray } = runInNewContext(code + '\n({ createTray })', {
    join: path.join,
    existsSync: () => false,
    process: { resourcesPath: process.cwd() },
    app: { getAppPath: () => process.cwd() },
    nativeImage: { createEmpty: () => ({}) },
    Menu: { buildFromTemplate: (value: typeof menu) => value },
    Tray: TestTray
  })
  const tray = createTray({ onShow: () => opens++, onPauseAll: () => {}, onQuit: () => {} })
  tray.emit('click')
  tray.emit('double-click')
  menu.find((item) => item.label === 'Open Draco')!.click!()
  strictEqual(opens, 3)
})
