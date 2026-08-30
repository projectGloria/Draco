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
  quotaFile: string
  /** Streams the extension spotted, kept between runs so the panel survives a restart. */
  mediaFile: string
  siteProjectsFile: string
  /** Empty stand-in files the shell is asked for a file-type icon against. */
  iconCache: string
  ffmpegExe: string
  ytDlpExe: string
  defaultDownloadDir: string
  /** The folder the user points chrome://extensions -> Load unpacked at. */
  extensionDir: string
  firefoxExtensionDir: string
  /** The console binary Chrome launches for native messaging. */
  hostExe: string
  /** Where the generated native-messaging manifest is written. */
  hostManifest: string
  firefoxHostManifest: string
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
    quotaFile: join(root, 'quota.json'),
    mediaFile: join(root, 'media.json'),
    siteProjectsFile: join(root, 'site-projects.json'),
    iconCache: join(root, 'icon-cache'),
    ffmpegExe: join(bin, 'ffmpeg.exe'),
    ytDlpExe: join(bin, 'yt-dlp.exe'),
    defaultDownloadDir: join(app.getPath('downloads'), 'Draco'),
    extensionDir: join(resourceRoot, 'extension'),
    firefoxExtensionDir: join(resourceRoot, 'extension-firefox'),
    hostExe: app.isPackaged
      ? join(resourceRoot, 'draco-host.exe')
      : join(resourceRoot, 'host', 'draco-host.exe'),
    hostManifest: join(root, 'com.nihil.draco.json'),
    firefoxHostManifest: join(root, 'com.nihil.draco.firefox.json')
  }
  return cached
}

/** Creates the writable tree. Safe to call repeatedly. */
export function ensureDirs(): AppPaths {
  const p = getPaths()
  for (const dir of [p.root, p.bin, p.logs, p.iconCache]) {
    mkdirSync(dir, { recursive: true })
  }
  return p
}
