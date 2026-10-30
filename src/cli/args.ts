import type { MediaVariant } from '../shared/types.ts'
import { isTemplate } from './template.ts'

/**
 * Argument parsing and format selection for the `draco` CLI.
 *
 * Kept free of I/O so it can be tested without a network, yt-dlp, or the
 * engine. The flag names follow yt-dlp wherever the concept maps one-to-one,
 * because that is the muscle memory anyone typing `draco <url> -f 720` brings.
 */

export const COOKIE_BROWSERS = ['chrome', 'edge', 'brave', 'firefox', 'chromium', 'opera', 'vivaldi'] as const
export type CookieBrowser = (typeof COOKIE_BROWSERS)[number] | 'none'

/**
 * What the user asked for, before any URL is resolved.
 *
 * - `best` / `worst`: tallest / shortest video rung (with its audio merged in).
 * - `bestaudio`: the highest-bitrate audio-only stream.
 * - `height`: the closest rung at or below N, the same rule the GUI's playlist
 *   dialog uses - quietly fetching 4K for someone who asked for 720 is wrong.
 * - `index`: row N of `-F`, for the formats no keyword describes.
 */
export type FormatSpec =
  | { kind: 'best' }
  | { kind: 'worst' }
  | { kind: 'bestaudio' }
  | { kind: 'height'; height: number }
  | { kind: 'index'; index: number }

export interface CliOptions {
  mediaOptions: Record<string, string | true>
  urls: string[]
  format: FormatSpec
  /** True only when `-f` (or an alias) was actually typed. */
  formatExplicit: boolean
  listFormats: boolean
  getUrl: boolean
  dir: string | null
  output: string | null
  connections: number | null
  concurrent: number | null
  /** Attempts per failed request before a download gives up. */
  retries: number | null
  /** Seconds a stalled connection is given before it is retried. */
  socketTimeout: number | null
  rateLimit: number | null
  proxy: string | null
  cookiesFromBrowser: CookieBrowser | null
  noPlaylist: boolean
  force: boolean
  ignoreConfig: boolean
  /** A draco.cfg other than the one in Draco's root folder. */
  configLocation: string | null
  quiet: boolean
  noProgress: boolean
  verbose: boolean
  help: boolean
  version: boolean
}

export class UsageError extends Error {}

export const HELP = `Usage: draco [OPTIONS] URL [URL...]

Run draco with no arguments in a terminal for the interactive download UI.
Paste a link, choose quality once, and reuse saved preferences. F2: settings. F4: open download folder.

Downloads files, streams and media pages with Draco's segmented engine.
YouTube, X, SoundCloud, Suno and anything yt-dlp understands are resolved
first; plain links, .m3u8/.mpd streams and magnets download directly.

Format selection:
  -f, --format FORMAT          best (default), worst, bestaudio, a height
                               such as 720 / 1080p, or #N for row N of -F
  -best, --best                Same as -f best
  -worst, --worst              Same as -f worst
  -x, --audio-only             Same as -f bestaudio
  -F, --list-formats           List the available formats and exit
  -g, --get-url                Print the chosen media URL(s) and exit

Output:
  -P, --paths DIR              Download directory (default: the current folder, or
                               draco.cfg's -P / Downloads when run from home)
  -o, --output TEMPLATE        File name, or a template such as
                               "%(uploader)s/%(title)s.%(ext)s" (see below)
      --force                  Download even if the file already exists

Network:
  -N, --connections N          Connections per download
  -c, --concurrent N           Downloads running at once (default: 3)
  -R, --retries N              Retries per failed request (default: 5)
      --socket-timeout SECONDS Stall time before a retry (default: 30)
  -r, --limit-rate RATE        Total speed cap, e.g. 500K or 4.2M (bytes/s)
      --proxy URL              HTTP(S) proxy
      --cookies-from-browser B Borrow cookies for yt-dlp (${COOKIE_BROWSERS.join(', ')})

Media options (handled by yt-dlp):
  -S, --format-sort ORDER      Format sorting order
      --merge-output-format F  Output container, e.g. mkv
      --convert-thumbnails F   Thumbnail format, e.g. png
      --cookies FILE           Netscape cookies file
      --write-thumbnail, --embed-thumbnail, --embed-metadata,
      --embed-chapters, --windows-filenames, --no-mtime

Playlists:
      --no-playlist            For watch?v=..&list=.. links, only that video

General:
      --config-location PATH   Read this draco.cfg instead of the default one
      --ignore-config          Do not read draco.cfg
  -q, --quiet                  Only print errors
      --no-progress            No live progress lines
  -v, --verbose                Echo engine logs to the terminal
  -V, --version                Print the version and exit
  -h, --help                   Show this help

Output template fields, as %(name)s (or %(name)03d for numbers):
  title, ext, id, uploader, upload_date, height, resolution, format_id,
  playlist, playlist_index. A field with no value becomes NA. "/" in the
  template makes folders; values themselves can never add folders.

Config: draco.cfg in Draco's folder holds default flags, one or more per
line, # for comments. The command line overrides it.

Ctrl-C pauses and flushes progress; rerun the same command to resume.`

/** Flags that consume the next argument. */
const VALUE_FLAGS = new Map<string, string>([
  ['-f', 'format'], ['--format', 'format'],
  ['-P', 'paths'], ['--paths', 'paths'],
  ['-o', 'output'], ['--output', 'output'],
  ['-N', 'connections'], ['--connections', 'connections'],
  ['-c', 'concurrent'], ['--concurrent', 'concurrent'],
  ['-R', 'retries'], ['--retries', 'retries'],
  ['--socket-timeout', 'socket-timeout'],
  ['--config-location', 'config-location'],
  ['-r', 'limit-rate'], ['--limit-rate', 'limit-rate'],
  ['--proxy', 'proxy'],
  ['--cookies-from-browser', 'cookies-from-browser']
])

/**
 * Boolean flags. `-best` and `-worst` are deliberately single-dash words: that
 * is how people actually type them, and yt-dlp's own reading (`-b -e -s -t`)
 * would be useless here anyway since none of those letters are flags.
 */
const BOOL_FLAGS = new Map<string, string>([
  ['-best', 'best'], ['--best', 'best'],
  ['-worst', 'worst'], ['--worst', 'worst'],
  ['-x', 'audio-only'], ['--audio-only', 'audio-only'],
  ['-F', 'list-formats'], ['--list-formats', 'list-formats'],
  ['-g', 'get-url'], ['--get-url', 'get-url'],
  ['--force', 'force'],
  ['--no-playlist', 'no-playlist'],
  ['--ignore-config', 'ignore-config'],
  ['-q', 'quiet'], ['--quiet', 'quiet'],
  ['--no-progress', 'no-progress'],
  ['-v', 'verbose'], ['--verbose', 'verbose'],
  ['-V', 'version'], ['--version', 'version'],
  ['-h', 'help'], ['--help', 'help']
])

function defaultOptions(): CliOptions {
  return {
    mediaOptions: {},
    urls: [],
    format: { kind: 'best' },
    formatExplicit: false,
    listFormats: false,
    getUrl: false,
    dir: null,
    output: null,
    connections: null,
    concurrent: null,
    retries: null,
    socketTimeout: null,
    rateLimit: null,
    proxy: null,
    cookiesFromBrowser: null,
    noPlaylist: false,
    force: false,
    ignoreConfig: false,
    configLocation: null,
    quiet: false,
    noProgress: false,
    verbose: false,
    help: false,
    version: false
  }
}

/**
 * The options one source (the command line, or draco.cfg) sets explicitly.
 *
 * Only keys that source actually named are present. That is what lets the two
 * layers merge per key: `-f 720` in draco.cfg and `-x` typed on the command
 * line is "the command line wins", not the conflict it would be within one
 * source.
 */
type Layer = Partial<CliOptions>

function parseLayer(argv: string[], source: 'cli' | 'config'): Layer {
  const options: Layer = {}
  const inConfig = source === 'config'

  // Two format flags that disagree (`-best -x`) are almost certainly a typo;
  // silently letting the last one win would download the wrong thing.
  let formatSource: string | null = null
  const setFormat = (spec: FormatSpec, label: string): void => {
    if (formatSource && formatSource !== label) {
      throw new UsageError(`conflicting format options: ${formatSource} and ${label}`)
    }
    formatSource = label
    options.format = spec
    options.formatExplicit = true
  }

  let positionalOnly = false
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]

    if (positionalOnly || !raw.startsWith('-') || raw === '-') {
      // A config that names a URL would download it on every single run.
      if (inConfig) throw new UsageError(`URLs belong on the command line, not in the config: ${raw}`)
      // An empty argument is almost always an unset shell variable
      // (`draco "$URL"`); say so here rather than as a URL error mid-run.
      if (!raw.trim()) throw new UsageError('empty URL argument')
      ;(options.urls ??= []).push(raw)
      continue
    }
    if (raw === '--') {
      positionalOnly = true
      continue
    }

    // `--flag=value` as well as `--flag value`.
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1
    const flag = eq > 0 ? raw.slice(0, eq) : raw
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined

    const mediaValues = new Set(['-S', '--format-sort', '--merge-output-format', '--convert-thumbnails', '--cookies'])
    const mediaBooleans = new Set(['--write-thumbnail', '--embed-thumbnail', '--embed-metadata', '--embed-chapters', '--windows-filenames', '--no-mtime'])
    if (mediaValues.has(flag) || mediaBooleans.has(flag)) {
      const value = mediaValues.has(flag) ? inline ?? argv[++i] : true
      if (value === undefined || value === '' || (typeof value === 'string' && value.startsWith('--'))) throw new UsageError(`${flag} needs a value`)
      if (mediaBooleans.has(flag) && inline !== undefined) throw new UsageError(`${flag} does not take a value`)
      ;(options.mediaOptions ??= {})[flag === '-S' ? '--format-sort' : flag] = value
      continue
    }
    const valueName = VALUE_FLAGS.get(flag)
    if (valueName) {
      const value = inline ?? argv[++i]
      if (value === undefined || value === '') throw new UsageError(`${flag} needs a value`)
      switch (valueName) {
        case 'format':
          setFormat(parseFormat(value), `${flag} ${value}`)
          break
        case 'paths':
          options.dir = value
          break
        case 'output':
          options.output = value
          break
        case 'connections':
          options.connections = parsePositiveInt(value, flag, 64)
          break
        case 'concurrent':
          options.concurrent = parsePositiveInt(value, flag, 32)
          break
        case 'retries':
          options.retries = parseIntRange(value, flag, 0, 100)
          break
        case 'socket-timeout':
          options.socketTimeout = parseIntRange(value, flag, 1, 600)
          break
        case 'limit-rate':
          options.rateLimit = parseRate(value)
          break
        case 'proxy':
          options.proxy = value
          break
        case 'cookies-from-browser': {
          const browser = value.toLowerCase()
          if (browser !== 'none' && !(COOKIE_BROWSERS as readonly string[]).includes(browser)) {
            throw new UsageError(`unsupported browser for --cookies-from-browser: ${value}`)
          }
          options.cookiesFromBrowser = browser as CookieBrowser
          break
        }
        case 'config-location':
          if (inConfig) throw new UsageError(`${flag} only works on the command line`)
          options.configLocation = value
          break
      }
      continue
    }

    const boolName = inline === undefined ? BOOL_FLAGS.get(flag) : undefined
    if (!boolName) throw new UsageError(`unknown option: ${raw}`)
    if (inConfig && (boolName === 'ignore-config' || boolName === 'help' || boolName === 'version')) {
      throw new UsageError(`${flag} only works on the command line`)
    }
    switch (boolName) {
      case 'best':
        setFormat({ kind: 'best' }, flag)
        break
      case 'worst':
        setFormat({ kind: 'worst' }, flag)
        break
      case 'audio-only':
        setFormat({ kind: 'bestaudio' }, flag)
        break
      case 'list-formats':
        options.listFormats = true
        break
      case 'get-url':
        options.getUrl = true
        break
      case 'force':
        options.force = true
        break
      case 'no-playlist':
        options.noPlaylist = true
        break
      case 'ignore-config':
        options.ignoreConfig = true
        break
      case 'quiet':
        options.quiet = true
        break
      case 'no-progress':
        options.noProgress = true
        break
      case 'verbose':
        options.verbose = true
        break
      case 'version':
        options.version = true
        break
      case 'help':
        options.help = true
        break
    }
  }
  return options
}

/**
 * Which config to read, decided from the command line alone - it has to be
 * known before the config itself can be parsed.
 */
export function configRequest(argv: string[]): { ignore: boolean; location: string | null } {
  const layer = parseLayer(argv, 'cli')
  return { ignore: layer.ignoreConfig === true, location: layer.configLocation ?? null }
}

/**
 * The effective options: built-in defaults, then draco.cfg's `config` tokens,
 * then the command line, each later layer overriding per key.
 */
export function parseArgs(argv: string[], config: string[] = []): CliOptions {
  let fromConfig: Layer
  try {
    fromConfig = parseLayer(config, 'config')
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError(`draco.cfg: ${error.message}`)
    throw error
  }
  const fromCli = parseLayer(argv, 'cli')
  const options: CliOptions = { ...defaultOptions(), ...fromConfig, ...fromCli,
    mediaOptions: { ...fromConfig.mediaOptions, ...fromCli.mediaOptions } }

  if (options.help || options.version) return options
  if (options.urls.length === 0) throw new UsageError('no URL given')
  // A template names one file per URL; a literal name can only name one file.
  if (options.output && options.urls.length > 1 && !isTemplate(options.output)) {
    throw new UsageError('-o/--output names one file, but several URLs were given (use a template such as "%(title)s.%(ext)s")')
  }
  return options
}

export function parseFormat(value: string): FormatSpec {
  const v = value.trim().toLowerCase()
  if (v === 'best' || v === 'b' || v === 'bv*+ba/b' || v === 'bestvideo+bestaudio') return { kind: 'best' }
  if (v === 'worst' || v === 'w') return { kind: 'worst' }
  if (v === 'bestaudio' || v === 'ba' || v === 'audio') return { kind: 'bestaudio' }
  const index = /^#(\d+)$/.exec(v)
  if (index) return { kind: 'index', index: Number(index[1]) }
  // "720", "720p", and yt-dlp's "best[height<=720]" / "bv*[height<=720]+ba".
  const height = /^(\d{3,4})p?$/.exec(v) ?? /height<=?(\d{3,4})\]/.exec(v)
  if (height) return { kind: 'height', height: Number(height[1]) }
  throw new UsageError(`unrecognised format: ${value} (try best, worst, bestaudio, 720, or #N from -F)`)
}

function parsePositiveInt(value: string, flag: string, max: number): number {
  return parseIntRange(value, flag, 1, max)
}

function parseIntRange(value: string, flag: string, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`${flag} must be a whole number from ${min} to ${max}`)
  return n
}

/** "500K", "4.2M", "1G", or plain bytes. Binary multiples, as yt-dlp uses. */
export function parseRate(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)i?b?$/i.exec(value.trim())
  if (!match) throw new UsageError(`invalid rate: ${value} (e.g. 500K, 4.2M)`)
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase() as '' | 'k' | 'm' | 'g']
  const bytes = Math.floor(Number(match[1]) * scale)
  if (bytes < 1) throw new UsageError(`rate must be positive: ${value}`)
  return bytes
}

const AUDIO_CONTAINERS = new Set(['m4a', 'mp3', 'opus', 'ogg', 'oga', 'aac', 'flac', 'wav'])

/**
 * Audio-only, whether the resolver said so (yt-dlp variants carry a role) or
 * only the container does (HTML-scraped variants carry no role at all).
 */
export function isAudioVariant(variant: MediaVariant): boolean {
  if (variant.youtube?.role) return variant.youtube.role === 'audio'
  return variant.height === null && AUDIO_CONTAINERS.has((variant.container ?? '').toLowerCase())
}

/**
 * The one variant a format spec names, or null when nothing fits.
 *
 * Ties on height go to bandwidth: two 1080p rungs (avc1 vs vp9) differ, and the
 * higher bitrate is the one "best" means.
 */
export function pickVariant(variants: MediaVariant[], spec: FormatSpec): MediaVariant | null {
  if (variants.length === 0) return null
  if (spec.kind === 'index') return variants[spec.index - 1] ?? null

  const audio = variants.filter(isAudioVariant)
  const byBandwidth = (a: MediaVariant, b: MediaVariant): number => (a.bandwidth ?? 0) - (b.bandwidth ?? 0)

  if (spec.kind === 'bestaudio') {
    return audio.length > 0 ? audio.reduce((best, v) => (byBandwidth(v, best) > 0 ? v : best)) : null
  }

  const video = variants.filter((v) => !isAudioVariant(v))
  // An audio-only page (a SoundCloud track) has no rungs to climb; "best" there
  // is the best audio rather than a refusal.
  if (video.length === 0) return pickVariant(variants, { kind: 'bestaudio' })

  const taller = (a: MediaVariant, b: MediaVariant): number =>
    (a.height ?? 0) - (b.height ?? 0) || byBandwidth(a, b)

  if (spec.kind === 'best') return video.reduce((best, v) => (taller(v, best) > 0 ? v : best))
  if (spec.kind === 'worst') return video.reduce((worst, v) => (taller(v, worst) < 0 ? v : worst))

  const atOrBelow = video.filter((v) => (v.height ?? 0) <= spec.height)
  // Nothing that short: the smallest on offer is the nearest honest answer.
  if (atOrBelow.length === 0) return video.reduce((worst, v) => (taller(v, worst) < 0 ? v : worst))
  return atOrBelow.reduce((best, v) => (taller(v, best) > 0 ? v : best))
}
