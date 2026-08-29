import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Every path the app writes to lives under userData (%APPDATA%/Draco) so that
 * wiping that one folder fully resets the app.
 */
export interface AppPaths {
  root: string
  bin: string
  logs: string
  settingsFile: string
  tasksFile: string
  categoriesFile: string
  queuesFile: string
  /** Streams the extension spotted, kept between runs so the panel survives a restart. */
  mediaFile: string
  ffmpegExe: string
  defaultDownloadDir: string
  /** The folder the user points chrome://extensions -> Load unpacked at. */
  extensionDir: string
  /** The console binary Chrome launches for native messaging. */
  hostExe: string
  /** Where the generated native-messaging manifest is written. */
  hostManifest: string
}

let cached: AppPaths | null = null

export function getPaths(): AppPaths {
  if (cached) return cached

  const root = app.getPath('userData')
  const bin = join(root, 'bin')

  // Packaged, the extension and host ship as extraResources next to the asar.
  // In dev they are just folders in the repo, so "Load unpacked" works against
  // the working tree without a build.
  const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()

  cached = {
    root,
    bin,
    logs: join(root, 'logs'),
    settingsFile: join(root, 'settings.json'),
    tasksFile: join(root, 'tasks.json'),
    categoriesFile: join(root, 'categories.json'),
    queuesFile: join(root, 'queues.json'),
    mediaFile: join(root, 'media.json'),
    ffmpegExe: join(bin, 'ffmpeg.exe'),
    defaultDownloadDir: join(app.getPath('downloads'), 'Draco'),
    extensionDir: join(resourceRoot, 'extension'),
    hostExe: app.isPackaged
      ? join(resourceRoot, 'draco-host.exe')
      : join(resourceRoot, 'host', 'draco-host.exe'),
    hostManifest: join(root, 'com.nihil.draco.json')
  }
  return cached
}

/** Creates the writable tree. Safe to call repeatedly. */
export function ensureDirs(): AppPaths {
  const p = getPaths()
  for (const dir of [p.root, p.bin, p.logs]) {
    mkdirSync(dir, { recursive: true })
  }
  return p
}
