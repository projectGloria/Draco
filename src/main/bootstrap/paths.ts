import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'

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
  clipboardFile: string
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
  /**
   * Workspace for incomplete downloads.
   *
   * Under userData like everything else the app writes. It lived beside the
   * installed resources for one release, which put multi-gigabyte partials
   * inside the install directory: the uninstaller took them with it, a portable
   * run lost them every launch, and an install under Program Files could not
   * create the directory at all - which failed the one bootstrap step the
   * splash cannot offer to continue past.
   *
   * Used only when it shares a volume with the destination; see
   * `engine/workspace.ts` for why.
   */
  tempDir: string
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
    tempDir: join(root, 'incomplete'),
    settingsFile: join(root, 'settings.json'),
    tasksFile: join(root, 'tasks.json'),
    categoriesFile: join(root, 'categories.json'),
    queuesFile: join(root, 'queues.json'),
    quotaFile: join(root, 'quota.json'),
    mediaFile: join(root, 'media.json'),
    clipboardFile: join(root, 'clipboard.json'),
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
  for (const dir of [p.root, p.bin, p.logs, p.iconCache, p.tempDir]) {
    mkdirSync(dir, { recursive: true })
  }
  migrateLegacyTempDir(p)
  return p
}

/**
 * Moves partials left in the old workspace into the new one.
 *
 * One release kept incomplete downloads in `.dracoTemp` beside the installed
 * resources. Those are multi-gigabyte files, and simply changing the path would
 * strand them somewhere nothing looks - so they are carried across once, on the
 * first launch after the move.
 *
 * Same volume in the overwhelming majority of cases, which makes this a rename
 * rather than a copy. Entirely best-effort: a failure here must never stop the
 * app starting, and the worst case is the old folder staying where it is.
 */
function migrateLegacyTempDir(paths: AppPaths): void {
  const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const legacy = join(resourceRoot, '.dracoTemp')
  if (legacy === paths.tempDir) return

  let entries: string[]
  try {
    entries = readdirSync(legacy)
  } catch {
    return
  }

  let moved = 0
  for (const name of entries) {
    try {
      renameSync(join(legacy, name), join(paths.tempDir, name))
      moved++
    } catch {
      // Already there, locked, or across a volume boundary. Leaving it behind
      // costs the resume; failing the launch would cost far more.
    }
  }

  if (moved > 0) {
    try {
      rmdirSync(legacy)
    } catch {
      // Not empty, because something above could not be moved. Fine.
    }
  }
}
