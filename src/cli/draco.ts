/**
 * `draco` - the download engine from a terminal.
 *
 *   draco <url> -best
 *   draco <url> -f 720 -P D:\Videos
 *   draco <url> -F
 *
 * Runs the app's own resolvers and engine, not a reimplementation of them: the
 * same yt-dlp lookup, the same quality ladder, the same segmented runner, the
 * same ffmpeg mux. Only the shell differs. It shares Draco's managed yt-dlp and
 * ffmpeg (%APPDATA%/Draco/bin) and reads its saved settings for defaults, but
 * never its task list - a CLI download does not appear in, or fight with, the
 * GUI's queue.
 *
 * The downloading itself lives in `session.ts`; this file is the shell around
 * it: options, paths, and the two front ends (plain output, full screen).
 *
 * Under bare Node (dev, via `npm link`) this runs as source through type
 * stripping. Packaged, `resources/bin/draco.cmd` runs the bundled copy with
 * Draco.exe in ELECTRON_RUN_AS_NODE mode, so no separate Node is required.
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../../package.json' with { type: 'json' }
import { configurePaths, getPaths } from '../main/bootstrap/paths.ts'
import { normalizeDownloadDirectory } from '../main/destination-path.ts'
import { setTorrentStoreDir } from '../main/engine/torrent-store.ts'
import { flushLogs, setLogConsole, setLogDirectory } from '../main/log.ts'
import { setYtDlpCookieBrowser } from '../main/youtube.ts'
import { configRequest, HELP, parseArgs, UsageError, type CliOptions } from './args.ts'
import { defaultConfigPath, loadConfig } from './config.ts'
import { isTemplate, validateTemplate } from './template.ts'
import { openTerminal, shouldOpenTerminal } from './interactive.ts'
import { friendlyError, painter, transferLines, type Transfer } from './progress.ts'
import { runMediaDownload } from './media-download.ts'
import { resolveSaveDir, saveDirLabel, type SaveDir } from './save-dir.ts'
import { createSession, type Reporter } from './session.ts'
import { acquireTerminal } from './terminal-io.ts'

/* ------------------------------------------------------------------ */
/* Bootstrapping                                                       */
/* ------------------------------------------------------------------ */

/** Repo root in dev; the app root inside the asar when bundled. */
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const isPackaged = (): boolean => Boolean(process.versions.electron || process.env.DRACO_CLI_ROOT)

function bootPaths(): void {
  // Running inside Draco.exe (ELECTRON_RUN_AS_NODE) means a packaged install:
  // the bundled yt-dlp/ffmpeg sit under resources/runtime, as for the GUI.
  const packaged = isPackaged()
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  configurePaths({
    // Same folder Electron's `userData` resolves to, so the CLI reuses the
    // tools the GUI already downloaded instead of fetching its own copies.
    userData: join(appData, 'Draco'),
    resourceRoot: packaged
      ? process.env.DRACO_CLI_ROOT ? join(process.env.DRACO_CLI_ROOT, 'resources') : process.resourcesPath ?? join(dirname(process.execPath), 'resources')
      : sourceRoot,
    isPackaged: packaged,
    downloads: join(homedir(), 'Downloads')
  })
}

/**
 * The folder the person was in when they started draco. `npm run cli` moves
 * the process to the package root and keeps the real one in INIT_CWD.
 */
function startedIn(): string {
  return process.env.npm_lifecycle_event && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd()
}

interface LoadedOptions {
  options: CliOptions
  configNote: string
  /** The cfg that was read, if one was. */
  configPath: string | null
  /** The cfg F2 would write to - the one that would be read, even if it does not exist yet. */
  configTarget: string | null
  saveDir: SaveDir
}

/**
 * Reads draco.cfg (unless told not to) and parses it under the command line.
 *
 * The CLI's defaults come from here and from nowhere else - deliberately not
 * from the GUI's settings.json, so what a command does never depends on what
 * someone last clicked in the app's Options.
 */
async function loadOptions(argv: string[]): Promise<LoadedOptions> {
  const request = configRequest(argv)
  const path = request.ignore
    ? null
    : request.location
      ? resolve(request.location)
      : defaultConfigPath(isPackaged(), process.execPath, sourceRoot)
  const tokens = path ? await loadConfig(path, request.location !== null) : null
  let options: CliOptions
  let cfgDir: string | null = null
  try {
    options = parseArgs(argv, tokens ?? [])
    // The cfg's `-P` is a default for "started from nowhere in particular",
    // not an override, so it has to be told apart from a typed one.
    if (tokens) cfgDir = parseArgs([PLACEHOLDER_URL], tokens).dir
  } catch (error) {
    // "draco.cfg: unknown option" alone leaves people hunting for which
    // draco.cfg - the installed one, a dev checkout's, a --config-location one.
    if (error instanceof UsageError && error.message.startsWith('draco.cfg: ')) {
      throw new UsageError(`${error.message.slice(11)} (in ${path})`)
    }
    throw error
  }
  const cliDir = tokens ? parseArgs(argv).dir : options.dir
  const saveDir = resolveSaveDir({
    cliDir,
    cfgDir,
    cwd: startedIn(),
    // Draco's own folder is where the Start-menu shortcut runs it from.
    ignore: isPackaged() ? [dirname(process.execPath)] : []
  })
  return {
    options,
    configNote: request.ignore ? 'Settings file ignored (--ignore-config)' : tokens ? `Using settings from ${path}` : `No settings file at ${path}`,
    configPath: tokens ? path : null,
    configTarget: path,
    saveDir
  }
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

/**
 * Permanent lines scroll; live progress (a card per active download, or one
 * "what is happening" line while resolving) is redrawn in place underneath.
 *
 * Live drawing only happens on a real terminal. Piped into a file or another
 * program, the same run prints just the permanent lines, so logs stay
 * greppable instead of filling with cursor escapes.
 *
 * The full-screen UI does not come through here: it is a `Reporter` of its own.
 */
class Status implements Reporter {
  private transfers: Transfer[] = []
  private drawn = 0
  private message: string | null = null
  // Plain fields, not constructor parameter properties: those are not erasable
  // syntax, and Node's strip-only type stripping refuses to load the file.
  private readonly interactive: boolean
  private readonly quiet: boolean
  private readonly paint = painter(Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env))

  constructor(interactive: boolean, quiet: boolean) {
    this.interactive = interactive
    this.quiet = quiet
  }

  set(message: string | null): void {
    this.message = message
    if (this.interactive) this.redraw()
  }

  info(line: string): void {
    if (!this.quiet) this.print(process.stdout, line)
  }

  error(line: string): void {
    this.print(process.stderr, line)
  }

  saved(_path: string, line: string): void {
    this.info(line)
  }

  progress(transfers: Transfer[]): void {
    // The session ticks every 250 ms; an empty tick on an empty screen is no news.
    if (transfers.length === 0 && this.transfers.length === 0) return
    this.transfers = transfers
    if (this.interactive) this.redraw()
  }

  clear(): void {
    this.transfers = []
    this.message = null
    if (this.interactive) this.redraw()
  }

  private print(stream: NodeJS.WriteStream, line: string): void {
    this.erase()
    stream.write(line + '\n')
    if (this.interactive) this.redraw()
  }

  private erase(): void {
    if (this.drawn > 0) process.stdout.write(`\x1b[${this.drawn}A\x1b[0J`)
    this.drawn = 0
  }

  private redraw(): void {
    this.erase()
    // Fitted one column short of the edge: a line that exactly fills the last
    // column wraps on some consoles, and the cursor-up count would then leave
    // stale fragments behind. Capped at 100 so the bar stays readable.
    const width = Math.max(20, Math.min(100, (process.stdout.columns || 100) - 1))
    const lines = this.transfers.flatMap((t) => transferLines(t, width, this.paint))
    if (this.message && lines.length === 0) lines.push(this.message.length > width ? this.message.slice(0, width - 1) + '…' : this.message)
    if (lines.length === 0) return
    process.stdout.write(lines.join('\n') + '\n')
    this.drawn = lines.length
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

/** Process-wide engine wiring: logs, torrent state, yt-dlp cookies. */
function bootEngine(options: CliOptions): void {
  const paths = getPaths()
  setLogConsole(options.verbose)
  // Its own file: the GUI may be appending to logs/main.log right now, and two
  // processes rolling the same file over would lose lines from both.
  setLogDirectory(join(paths.logs, 'cli'))
  setTorrentStoreDir(paths.torrents)
  const cookieBrowser = options.cookiesFromBrowser ?? 'none'
  setYtDlpCookieBrowser(() => cookieBrowser)
}

/** Stands in for a URL when parsing options for the full-screen UI, which has none yet. */
const PLACEHOLDER_URL = 'https://draco.invalid/'

export async function main(argv: string[]): Promise<number> {
  const terminal = argv.length === 0 ? acquireTerminal() : null
  if (terminal && shouldOpenTerminal(argv, true, true)) {
    // Parse config with a placeholder URL only to obtain defaults. No network
    // request is made until the user submits a link in the terminal.
    try {
      const { options, saveDir, configPath, configTarget } = await loadOptions([PLACEHOLDER_URL])
      bootPaths()
      bootEngine(options)
      // The UI always downloads; inspection flags stay available to ordinary
      // invocations even when draco.cfg sets them as defaults.
      Object.assign(options, { quiet: false, noProgress: false, listFormats: false, getUrl: false, help: false, version: false })
      return await openTerminal({
        version: pkg.version,
        preferencePath: join(getPaths().root, 'cli-preferences.json'),
        defaults: { format: options.format, dir: saveDir.dir, dirSource: saveDir.source },
        config: configPath,
        configTarget,
        // One lane by default: a queue, one download at a time, the next
        // starting as soon as the current one is merging.
        openSession: (reporter, choose) => createSession({ options, dir: saveDir.dir, reporter, choose, lanes: options.concurrent ?? 1 }),
        terminal
      })
    } catch (error) {
      process.stderr.write(`draco: ${(error as Error).message}\n`)
      return 2
    } finally {
      terminal.close()
    }
  }
  terminal?.close()
  let options: CliOptions
  let configNote: string
  let saveDir: SaveDir
  try {
    ;({ options, configNote, saveDir } = await loadOptions(argv))
    // A broken template is a typo in the command (or draco.cfg); refuse it
    // before anything is resolved, not once per URL halfway through a run.
    if (options.output && isTemplate(options.output)) {
      try {
        validateTemplate(options.output)
      } catch (error) {
        throw new UsageError((error as Error).message)
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`draco: ${error.message}\nTry 'draco --help'.\n`)
      return 2
    }
    throw error
  }
  if (options.help) {
    process.stdout.write(HELP + '\n')
    return 0
  }
  if (options.version) {
    process.stdout.write(`draco ${pkg.version}\n`)
    return 0
  }

  bootPaths()
  bootEngine(options)
  const interactive = Boolean(process.stdout.isTTY) && !options.noProgress && !options.quiet
  const dir = normalizeDownloadDirectory(saveDir.dir)

  if (Object.keys(options.mediaOptions).length > 0) {
    const status = new Status(interactive, options.quiet)
    try { return await runMediaDownload({ ...options, dir }, status) }
    catch (error) { status.error(`Could not download: ${friendlyError((error as Error).message)}`); return 1 }
    finally { status.clear(); await flushLogs() }
  }

  const status = new Status(interactive, options.quiet)
  if (options.verbose) status.info(configNote)
  if (options.verbose && saveDir.source !== 'typed') status.info(`Saving to ${dir} (${saveDirLabel(saveDir.source)})`)
  // Several URLs on one command line still download side by side; a
  // playlist's entries run in order whatever this says.
  const session = createSession({ options, dir, reporter: status, lanes: options.concurrent ?? 3 })

  // Ctrl-C pauses rather than aborts: the runners flush their journals, so the
  // same command picks up where this one stopped. A second Ctrl-C is the
  // "I mean it" exit, for when a flush itself is what is stuck.
  let stopping = false
  const onInterrupt = (): void => {
    if (stopping) process.exit(130)
    stopping = true
    status.clear()
    status.error('Pausing and saving progress… (press Ctrl+C again to quit right away)')
    void session.close().finally(() => {
      status.error('Paused. Run the same command again to pick up where it stopped.')
      process.exit(130)
    })
  }
  process.on('SIGINT', onInterrupt)

  // Resolve one URL at a time and hand each result to the engine immediately:
  // the first video downloads while the second is still being looked up, and a
  // playlist starts after one lookup rather than after all of them.
  try {
    for (const input of options.urls) {
      if (stopping) break
      // Failures are reported by the session and counted in `failures`.
      await session.submit(input).catch(() => {})
    }
    await session.idle()
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    if (!stopping) await session.close()
  }
  return stopping ? 130 : session.failures > 0 ? 1 : 0
}
