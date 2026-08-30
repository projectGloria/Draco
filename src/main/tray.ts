import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Menu, Tray, app, nativeImage } from 'electron'

/**
 * The tray is what makes "close to tray" honest: downloads keep running with no
 * window open, so there has to be a way back in.
 */

let tray: Tray | null = null

export interface TrayHandlers {
  onShow(): void
  onPauseAll(): void
  onQuit(): void
}

function icon(): Electron.NativeImage {
  const candidates = [
    join(process.resourcesPath, 'icon.ico'),
    join(app.getAppPath(), 'resources', 'icon.ico'),
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png')
  ]

  for (const path of candidates) {
    if (!existsSync(path)) continue
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) return image
  }

  return nativeImage.createEmpty()
}

export function createTray(handlers: TrayHandlers): Tray {
  if (tray) return tray

  tray = new Tray(icon())
  tray.setToolTip('Draco')

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Draco', click: handlers.onShow },
      { type: 'separator' },
      { label: 'Pause all downloads', click: handlers.onPauseAll },
      { type: 'separator' },
      { label: 'Quit', click: handlers.onQuit }
    ])
  )

  tray.on('click', handlers.onShow)
  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
