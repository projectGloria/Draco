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
  /** Site passwords, each secret sealed by `safeStorage` - never plain JSON. */
  credentialsFile: string
  /** Streams the extension spotted, kept between runs so the panel survives a restart. */
  mediaFile: string
  clipboardFile: string
  browserHandoffsFile: string
  siteProjectsFile: string
  /** Empty stand-in files the shell is asked for a file-type icon against. */
  iconCache: string
  /** Draco's own copies of every imported `.torrent`, keyed by info hash. */
  torrents: string
  ffmpegExe: string
  ytDlpExe: string
  bundledFfmpegExe: string
  bundledYtDlpExe: string
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

/**
 * The four facts every path below is derived from.
 *
 * Supplied by whoever boots the process rather than read from Electron here:
 * the GUI hands over `app.getPath(...)`, while the `draco` CLI runs under bare
 * Node (or Electron with ELECTRON_RUN_AS_NODE, where `app` does not exist) and
 * derives the same answers from the environment. An `electron` import in this
 * file put the whole yt-dlp/ffmpeg graph out of reach of anything but the GUI.
 */
export interface PathEnvironment {
  /** %APPDATA%/Draco - the one folder that holds everything the app writes. */
  userData: string
  /**
   * Packaged, the extension and host ship as extraResources next to the asar.
   * In dev they are just folders in the repo, so "Load unpacked" works against
   * the working tree without a build.
   */
  resourceRoot: string
  isPackaged: boolean
  /** The user's Downloads folder. */
  downloads: string
}

let environment: PathEnvironment | null = null
let cached: AppPaths | null = null

/**
 * Must run before the first `getPaths()`. Calling it again (diagnostics move
 * userData to a scratch profile) drops the cache so nothing keeps the old root.
 */
export function configurePaths(env: PathEnvironment): void {
  environment = { ...env }
  cached = null
}

export function getPaths(): AppPaths {
  if (cached) return cached
  // Fail loud: silently guessing a root here is how a diagnostic run would end
  // up writing into the user's real profile.
  if (!environment) throw new Error('paths accessed before configurePaths()')

  const { userData: root, resourceRoot, isPackaged, downloads } = environment
  const bin = join(root, 'bin')

  cached = {
    root,
    bin,
    logs: join(root, 'logs'),
    credentialsFile: join(root, 'credentials.json'),
    tempDir: join(root, 'incomplete'),
    settingsFile: join(root, 'settings.json'),
    tasksFile: join(root, 'tasks.json'),
    categoriesFile: join(root, 'categories.json'),
    queuesFile: join(root, 'queues.json'),
    quotaFile: join(root, 'quota.json'),
    mediaFile: join(root, 'media.json'),
    clipboardFile: join(root, 'clipboard.json'),
    browserHandoffsFile: join(root, 'browser-handoffs.json'),
    siteProjectsFile: join(root, 'site-projects.json'),
    iconCache: join(root, 'icon-cache'),
    torrents: join(root, 'torrents'),
    ffmpegExe: join(bin, 'ffmpeg.exe'),
    ytDlpExe: join(bin, 'yt-dlp.exe'),
    bundledFfmpegExe: join(resourceRoot, isPackaged ? 'runtime' : 'resources/runtime', 'ffmpeg.exe'),
    bundledYtDlpExe: join(resourceRoot, isPackaged ? 'runtime' : 'resources/runtime', 'yt-dlp.exe'),
    defaultDownloadDir: join(downloads, 'Draco'),
    extensionDir: join(resourceRoot, 'extension'),
    firefoxExtensionDir: join(resourceRoot, 'extension-firefox'),
    hostExe: isPackaged
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
  for (const dir of [p.root, p.bin, p.logs, p.iconCache, p.torrents, p.tempDir]) {
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
  if (!environment) return
  const legacy = join(environment.resourceRoot, '.dracoTemp')
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
