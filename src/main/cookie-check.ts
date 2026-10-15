import { spawn } from 'node:child_process'
import { killTree } from './proc.ts'
import {
  advance,
  cookiesReadFrom,
  looksDowngraded,
  progressFor,
  verdictFor,
  type CookieCheckProgress,
  type CookieCheckResult
} from './cookie-report.ts'
import { isCookieBrowser, type CookieBrowser } from './ytdlp-cookies.ts'
import { logger } from './log.ts'
import { ensureYtDlp } from './youtube.ts'
import { electronNodeRuntimeArgs, electronNodeRuntimeEnv } from './youtube-runtime.ts'

const log = logger('cookies')

/**
 * Does borrowing this browser's cookies actually get YouTube to talk?
 *
 * The honest way to answer that is to try it, so this runs the same lookup a
 * real download runs, against one video, and reports what came back. Nothing is
 * downloaded and nothing is written; the result is a ladder and a verdict.
 *
 * The test video is deliberately a fixed, ancient, unlisted-by-nobody public
 * upload rather than whatever the user last copied: the check has to mean the
 * same thing every time it is run, and a video that is region-locked or has
 * since been made private would report a broken session that is perfectly fine.
 * What is actually being measured is whether anything above 360p comes back -
 * see `verdictFor` - so the only requirement of the video is that it has more
 * than 360p to offer.
 */
const TEST_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

/** Long enough for a cold yt-dlp start plus a cookie database copy. */
const CHECK_TIMEOUT_MS = 120_000

export async function checkCookies(
  browser: string,
  onProgress: (progress: CookieCheckProgress) => void
): Promise<CookieCheckResult> {
  if (!isCookieBrowser(browser)) {
    throw new Error(`${browser} is not a browser Draco can read cookies from`)
  }

  onProgress({ stage: 'starting', percent: 5, message: 'Starting yt-dlp' })
  const executable = await ensureYtDlp()

  const lines = await runCheck(executable, browser, onProgress)

  const info = parseInfo(lines.stdout)
  const all = [...lines.stdout, ...lines.stderr]
  const heights = fetchableHeights(info)
  let anonymousHeights: number[] = []
  if (lines.code === 0 && info && Math.max(0, ...heights) <= 360) {
    onProgress({ stage: 'formats', percent: 92, message: 'Comparing public video formats' })
    try {
      const publicLines = await runCheck(executable, null, () => {})
      if (publicLines.code === 0) anonymousHeights = fetchableHeights(parseInfo(publicLines.stdout))
    } catch (error) {
      log.warn(`public cookie-check comparison failed: ${String(error)}`)
    }
  }
  onProgress({ stage: 'done', percent: 100, message: 'Finished' })

  const result = verdictFor({
    browser,
    cookiesRead: cookiesReadFrom(all),
    downgraded: looksDowngraded(all),
    heights,
    anonymousHeights,
    error: lines.code === 0 && info ? null : lastUsefulLine(lines.stderr) || lastNonJson(lines.stdout) || `yt-dlp exited with ${lines.code}`
  })

  log.info(
    `cookie check on ${browser}: ${result.ok ? 'working' : 'not accepted'}` +
    ` (${result.cookiesRead ?? 'no'} cookies, best ${result.bestQuality ?? 'none'})`
  )
  return result
}

function runCheck(
  executable: string,
  browser: CookieBrowser | null,
  onProgress: (progress: CookieCheckProgress) => void
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '--dump-single-json',
        '--skip-download',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        /*
         * A dump normally silences the running commentary, and the commentary
         * is what drives the progress bar. `--no-quiet` puts it back; it shares
         * stdout with the JSON, which is why the parse below scans for the last
         * line that happens to be an object rather than reading the whole
         * stream as one.
         */
        '--no-quiet',
        '--remote-components',
        'ejs:github',
        ...(browser ? ['--cookies-from-browser', browser] : []),
        ...electronNodeRuntimeArgs(),
        TEST_VIDEO
      ],
      {
        shell: false,
        windowsHide: true,
        env: electronNodeRuntimeEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    const stdout: string[] = []
    const stderr: string[] = []
    let current: CookieCheckProgress = { stage: 'starting', percent: 5, message: 'Starting yt-dlp' }
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      reject(new Error(`The cookie check timed out after ${Math.round(CHECK_TIMEOUT_MS / 1000)}s`))
    }, CHECK_TIMEOUT_MS)

    // Line-buffered by hand: a chunk boundary lands mid-line often enough that
    // the progress messages would otherwise be missed at random.
    const reader = (sink: string[]): ((chunk: Buffer) => void) => {
      let carry = ''
      return (chunk: Buffer) => {
        carry += chunk.toString('utf8')
        const parts = carry.split(/\r?\n/)
        carry = parts.pop() ?? ''
        for (const line of parts) {
          sink.push(line)
          const step = progressFor(line, browser ?? 'browser')
          if (!step) continue
          const next = advance(current, step)
          if (next !== current) {
            current = next
            onProgress(current)
          }
        }
      }
    }

    child.stdout.on('data', reader(stdout))
    child.stderr.on('data', reader(stderr))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

interface CheckInfo {
  formats?: Array<{
    url?: string
    protocol?: string
    vcodec?: string
    height?: number
  }>
}

function parseInfo(lines: readonly string[]): CheckInfo | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].trim()
    if (!text.startsWith('{')) continue
    try {
      const parsed = JSON.parse(text) as CheckInfo
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Keep looking - a commentary line can start with a brace too.
    }
  }
  return null
}

/**
 * Heights of the formats the engine could actually fetch.
 *
 * The same restriction the ladder applies: an HLS rendition is listed with a
 * height but its URL is a playlist, so counting it would report a working
 * session on a ladder nothing could be downloaded from.
 */
function fetchableHeights(info: CheckInfo | null): number[] {
  return (info?.formats ?? [])
    .filter((format) => {
      if (!format.url || !/^https?:/i.test(format.url)) return false
      const protocol = (format.protocol ?? '').toLowerCase()
      if (protocol && protocol !== 'https' && protocol !== 'http') return false
      if (/[.]m3u8([?#]|$)|\/manifest\//i.test(format.url)) return false
      return Boolean(format.vcodec && format.vcodec !== 'none')
    })
    .map((format) => format.height ?? 0)
    .filter((height) => height > 0)
}

function lastUsefulLine(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].replace(/\x1b\[[0-9;]*m/g, '').trim()
    if (text) return text
  }
  return ''
}

function lastNonJson(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].trim()
    if (text && !text.startsWith('{')) return text
  }
  return ''
}
