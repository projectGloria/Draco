import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { getPaths } from './bootstrap/paths.ts'
import { logger } from './log.ts'
import type { MediaVariant, PageFormat, RequestHeaders } from '../shared/types.ts'
import {
  buildVariants,
  formatsFromPage,
  formatsFromYtDlp,
  selectDirectYtFormat,
  type YtDlpFormat
} from './youtube-ladder.ts'
import { electronNodeRuntimeArgs, electronNodeRuntimeEnv } from './youtube-runtime.ts'

const log = logger('youtube')

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
const MIN_YTDLP_BYTES = 2_000_000
// A normal metadata lookup takes a few seconds. A longer wait gives slow
// connections room while ensuring a task cannot stay on "Getting the download
// link" forever if GitHub, YouTube, or an extractor component stalls.
const YTDLP_LOOKUP_TIMEOUT_MS = 45_000

let ytdlpProvision: Promise<string> | null = null

interface YtDlpInfo {
  id?: string
  title?: string
  duration?: number
  formats?: YtDlpFormat[]
}

/**
 * The quality ladder without touching the network, built from what the browser
 * already had in the page. Returns null when the page gave nothing usable, in
 * which case the caller falls back to `resolveYouTube`.
 */
export function resolveYouTubeInstant(
  pageUrl: string,
  pageTitle: string,
  pageFormats: PageFormat[] | undefined
): { id: string; title: string; variants: MediaVariant[] } | null {
  if (!pageFormats || pageFormats.length === 0) return null

  const variants = buildVariants(formatsFromPage(pageFormats))
  if (variants.length === 0) return null

  return {
    id: extractYouTubeId(pageUrl),
    title: pageTitle.trim() || 'YouTube video',
    variants
  }
}

/** Fills the shared yt-dlp cache before the user asks to download. */
export async function primeYouTube(
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<void> {
  await loadInfo(pageUrl, headers)
}

export async function resolveYouTube(
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<{ id: string; title: string; variants: MediaVariant[] }> {
  const info = await loadInfo(pageUrl, headers)
  const variants = buildVariants(formatsFromYtDlp(Array.isArray(info.formats) ? info.formats : []))

  if (variants.length === 0) {
    throw new Error(
      'yt-dlp found no downloadable YouTube formats. ' +
      'YouTube may be requiring an additional browser/PO token or the video is unavailable.'
    )
  }

  return {
    id: info.id?.trim() || extractYouTubeId(pageUrl),
    title: info.title?.trim() || 'YouTube video',
    variants
  }
}

export async function refreshYouTubeFormat(
  pageUrl: string,
  headers: RequestHeaders | undefined,
  formatId: string,
  force = true
): Promise<string> {
  // Forced only when the URL Draco holds has expired, because the cached lookup
  // is where that expired URL came from. A download that is merely starting
  // wants the cache: `primeYouTube` filled it while the window was open, and
  // insisting on a fresh lookup there is six seconds spent to learn the same
  // thing twice - once per stream, for a video and audio pair.
  let info = await loadInfo(pageUrl, headers, force)
  // The same guard the ladder applies, repeated at the point of use: this is
  // the only place a YouTube download URL comes from, and what reaches the
  // engine must be a file it can fetch rather than an HLS or DASH manifest.
  let format = selectDirectYtFormat(info.formats ?? [], formatId)
  if (!format?.url && headers?.cookie) {
    // Some YouTube sessions accept playback in Chrome but cause the extractor
    // client to receive only a low-quality progressive fallback. Retrying
    // without the browser cookie preserves the requested quality whenever the
    // public extractor response has the normal adaptive stream list.
    log.warn(`YouTube format ${formatId} was unavailable with browser cookies; retrying without them`)
    const { cookie: _cookie, ...headersWithoutCookie } = headers
    info = await loadInfo(
      pageUrl,
      Object.keys(headersWithoutCookie).length > 0 ? headersWithoutCookie : undefined,
      true
    )
    format = selectDirectYtFormat(info.formats ?? [], formatId)
  }
  if (!format?.url) {
    throw new Error(`YouTube format ${formatId} is no longer available`)
  }
  if (format.format_id !== formatId) {
    log.warn(`replacing non-direct YouTube format ${formatId} with ${format.format_id}`)
  }
  return format.url
}

function extractYouTubeId(pageUrl: string): string {
  try {
    const url = new URL(pageUrl)
    if (url.hostname === 'youtu.be' || url.hostname.endsWith('.youtu.be')) {
      return url.pathname.replace(/^\//, '').split('/')[0]
    }
    const queryId = url.searchParams.get('v')
    if (queryId) return queryId
    const match = /^\/(?:shorts|embed|live)\/([^/?#]+)/i.exec(url.pathname)
    return match?.[1] ?? pageUrl
  } catch {
    return pageUrl
  }
}

/* ------------------------------------------------------------------ */
/* Lookup cache                                                        */
/* ------------------------------------------------------------------ */

interface CachedInfo {
  at: number
  promise: Promise<YtDlpInfo>
}

const infoCache = new Map<string, CachedInfo>()
/** Signed URLs outlive this comfortably, and the ladder does not change at all. */
const INFO_TTL_MS = 5 * 60_000
const INFO_CACHE_MAX = 8

/**
 * One yt-dlp lookup, shared.
 *
 * The call costs about six seconds, nearly all of it yt-dlp's own startup and
 * YouTube round trips, and a single result answers every question the app asks
 * about a video: the quality ladder when the window opens, then the signed URL
 * for whichever rung was chosen. Running it twice would double the only wait
 * the user actually feels.
 */
async function loadInfo(
  pageUrl: string,
  headers: RequestHeaders | undefined,
  force = false
): Promise<YtDlpInfo> {
  const key = extractYouTubeId(pageUrl)
  const now = Date.now()

  if (!force) {
    const hit = infoCache.get(key)
    if (hit && now - hit.at < INFO_TTL_MS) {
      log.info(`reusing YouTube extraction cache for ${key}`)
      return hit.promise
    }
  }

  const promise = (async () => {
    const executable = await ensureYtDlp()
    return dumpJson(executable, pageUrl, headers)
  })()

  // A failed lookup is not worth keeping: caching the rejection would make one
  // bad moment stick to the video for the rest of the TTL.
  promise.catch(() => {
    if (infoCache.get(key)?.promise === promise) infoCache.delete(key)
  })

  infoCache.set(key, { at: now, promise })

  for (const [id, entry] of infoCache) {
    if (now - entry.at >= INFO_TTL_MS) infoCache.delete(id)
  }
  while (infoCache.size > INFO_CACHE_MAX) {
    const oldest = infoCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    infoCache.delete(oldest)
  }

  return promise
}

export async function ensureYtDlp(): Promise<string> {
  if (ytdlpProvision) return ytdlpProvision

  ytdlpProvision = provisionYtDlp().finally(() => {
    ytdlpProvision = null
  })
  return ytdlpProvision
}

async function provisionYtDlp(): Promise<string> {
  const existing = await findOnPath('yt-dlp.exe').catch(() => null)
  if (existing && await usable(existing)) {
    log.info(`using yt-dlp from PATH: ${existing}`)
    return existing
  }

  const target = getPaths().ytDlpExe
  if (await usable(target)) return target

  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.download`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), YTDLP_LOOKUP_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(YTDLP_URL, {
        redirect: 'follow',
        headers: { 'user-agent': 'Draco/0.1' },
        signal: controller.signal
      })
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error('yt-dlp installation timed out after 45 seconds')
      }
      throw err
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} while downloading yt-dlp`)
    }

    const body = Buffer.from(await res.arrayBuffer())
    if (body.length < MIN_YTDLP_BYTES) {
      throw new Error(`yt-dlp download was only ${body.length} bytes`)
    }

    await writeFile(tmp, body)
    await rm(target, { force: true })
    await rename(tmp, target)
    await chmod(target, 0o755)

    if (!(await usable(target))) {
      throw new Error('Downloaded yt-dlp executable did not start')
    }

    log.info(`installed yt-dlp from ${YTDLP_URL}`)
    return target
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

async function findOnPath(command: string): Promise<string | null> {
  const { stdout } = await runCapture('where.exe', [command], 5_000)
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return first || null
}

async function usable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (info.size < MIN_YTDLP_BYTES) return false
    await run(path, ['--version'], 15_000)
    return true
  } catch {
    return false
  }
}

async function dumpJson(
  executable: string,
  url: string,
  headers?: RequestHeaders
): Promise<YtDlpInfo> {
  const args = [
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--remote-components',
    'ejs:github',
    ...electronNodeRuntimeArgs(),
    url
  ]

  if (headers?.userAgent) args.push('--user-agent', headers.userAgent)
  if (headers?.referer) args.push('--referer', headers.referer)
  if (headers?.cookie) args.push('--add-header', `Cookie: ${headers.cookie}`)

  // Electron's bundled Node runtime is supplied explicitly above. yt-dlp still
  // owns the challenge implementation; Draco only provides the runtime needed
  // to execute its maintained EJS component.
  const { stdout, stderr, code } = await runCapture(
    executable,
    args,
    YTDLP_LOOKUP_TIMEOUT_MS,
    electronNodeRuntimeEnv()
  )
  if (code !== 0) {
    const detail = lastUsefulLine(stderr) || lastUsefulLine(stdout) || `yt-dlp exited with ${code}`
    throw new Error(normalizeYtDlpError(detail))
  }

  // yt-dlp's JSON is a single object for --no-playlist. Ignore incidental blank
  // lines so a wrapper/update notice cannot break parsing.
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as YtDlpInfo
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Keep looking.
    }
  }

  throw new Error('yt-dlp returned no usable JSON')
}

function normalizeYtDlpError(message: string): string {
  if (/no supported javascript runtime/i.test(message)) {
    return (
      'YouTube needs a supported JavaScript runtime for extraction. ' +
      'Install Deno (recommended) and make sure deno.exe is on PATH, then retry.'
    )
  }

  if (/po token|proof of origin|403|forbidden/i.test(message)) {
    return (
      'YouTube rejected the extractor request (PO token / HTTP 403). ' +
      'This video or client currently needs a browser token or a newer yt-dlp setup.'
    )
  }

  if (/sign in|bot|captcha|confirm you('re| are) not a robot/i.test(message)) {
    return (
      'YouTube requires a browser session or verification for this video. ' +
      'Draco received the page cookies, but YouTube still rejected the extractor.'
    )
  }

  return message
}

function lastUsefulLine(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(Boolean)

  return lines[lines.length - 1] ?? ''
}

function run(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `exit ${code}`))
    })
  })
}

function runCapture(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-25 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-16 * 1024)
    })

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
