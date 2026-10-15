import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { killTree } from './proc.ts'
import { createHash, randomUUID } from 'node:crypto'
import { getPaths } from './bootstrap/paths.ts'
import { fetchGuarded } from './fetch-guard.ts'
import { readResponseText } from './response-limit.ts'
import { cookieArgs, explainCookieFailure } from './ytdlp-cookies.ts'
import { MAX_PLAYLIST_ENTRIES, parseFlatPlaylist, type PlaylistListing } from './youtube-playlist.ts'
import { getSettings } from './store.ts'
import { logger } from './log.ts'
import { parseYtDlpVersion } from './tools-version.ts'
import { verifyYtDlpDigest } from './ytdlp-digest.ts'
import { replaceVerifiedExecutable } from './hls/replace-executable.ts'
import type { MediaVariant, PageFormat, RequestHeaders, YouTubeResolution } from '../shared/types.ts'
import {
  buildVariants,
  buildAudioVariants,
  directFormats,
  formatsFromPage,
  formatsFromYtDlp,
  offeredTiers,
  rungsBelow,
  selectDirectYtFormat,
  tierFor,
  tierLabel,
  type WantedFormat,
  type YtDlpFormat
} from './youtube-ladder.ts'
import { isSupportedYouTubeUrl } from './youtube-url.ts'
import { electronNodeRuntimeArgs, electronNodeRuntimeEnv } from './youtube-runtime.ts'
import { describeQualityShortfall, normalizeYtDlpError } from './youtube-error.ts'
import { isSunoUrl } from './media-url.ts'
import { resolveSuno } from './suno.ts'
import { isKhinsiderUrl, resolveKhinsider } from './khinsider.ts'
import { resolveHtmlPageMedia } from './page-media.ts'
import { isXPage, xPostUrl } from '../shared/x-post.ts'
import { resolveTwitterPost } from './twitter.ts'
import { loadYouTubeSessions, type YtDlpInfo } from './youtube-sessions.ts'

const log = logger('youtube')

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
/** Metadata for the same release, which is where the version number lives. */
const YTDLP_RELEASE_URL = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
/** The digests GitHub publishes as an asset of that release. */
const YTDLP_SUMS_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS'
const MIN_YTDLP_BYTES = 2_000_000
// A normal metadata lookup takes a few seconds. A longer wait gives slow
// connections room while ensuring a task cannot stay on "Getting the download
// link" forever if GitHub, YouTube, or an extractor component stalls.
const YTDLP_LOOKUP_TIMEOUT_MS = 45_000

let ytdlpProvision: Promise<string> | null = null

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

  const formats = formatsFromPage(pageFormats)
  const variants = [...buildVariants(formats), ...buildAudioVariants(formats)]
  if (variants.length === 0) return null

  return {
    id: extractYouTubeId(pageUrl),
    title: pageTitle.trim() || 'YouTube video',
    variants
  }
}

/** Strips the browser session cookie from a header set, keeping referer/UA. */
function withoutCookie(headers: RequestHeaders | undefined): RequestHeaders | undefined {
  if (!headers?.cookie) return headers
  const { cookie: _cookie, ...rest } = headers
  return Object.keys(rest).length > 0 ? rest : undefined
}

/** Fills the shared yt-dlp cache before the user asks to download. */
export async function primeYouTube(
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<void> {
  // Prime the same public + account format list used by selection and refresh.
  await loadInfo(pageUrl, headers)
}

export async function resolveYouTube(
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<{ id: string; title: string; variants: MediaVariant[]; thumbnailUrl: string }> {
  const info = await loadInfo(pageUrl, headers)
  const formats = formatsFromYtDlp(Array.isArray(info.formats) ? info.formats : [])
  const variants = [...buildVariants(formats), ...buildAudioVariants(formats)]

  if (variants.length === 0) {
    throw new Error(
      'yt-dlp found no downloadable YouTube formats. ' +
      'YouTube may be requiring an additional browser/PO token or the video is unavailable.'
    )
  }

  const id = info.id?.trim() || extractYouTubeId(pageUrl)
  return {
    id,
    title: info.title?.trim() || 'YouTube video',
    variants,
    thumbnailUrl: safeYouTubeThumbnail(info.thumbnail) ?? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`
  }
}

/**
 * Everything one playlist or channel link stands for.
 *
 * `--flat-playlist` is the whole point: yt-dlp lists the entries without
 * resolving any of them, so a 200-video channel costs one lookup instead of
 * two hundred. Each entry is resolved later, when its own download starts,
 * which is also the only moment at which YouTube's signed URLs are still fresh.
 */
export async function resolvePlaylist(pageUrl: string): Promise<PlaylistListing> {
  const executable = await ensureYtDlp()
  const cookieBrowser = getSettings().cookiesFromBrowser

  const { stdout, stderr, code } = await runCapture(
    executable,
    [
      '--dump-single-json',
      '--flat-playlist',
      '--skip-download',
      '--no-warnings',
      '--no-progress',
      // One more than the cap, so a listing that was truncated can be reported
      // as truncated rather than silently ending on a round number.
      '--playlist-end',
      String(MAX_PLAYLIST_ENTRIES + 1),
      ...cookieArgs(cookieBrowser),
      ...electronNodeRuntimeArgs(),
      pageUrl
    ],
    PLAYLIST_LOOKUP_TIMEOUT_MS,
    electronNodeRuntimeEnv()
  )

  if (code !== 0) {
    const cookieProblem = explainCookieFailure(stderr, cookieBrowser)
    if (cookieProblem) throw new Error(cookieProblem)
    const detail = lastUsefulLine(stderr) || lastUsefulLine(stdout) || `yt-dlp exited with ${code}`
    throw new Error(normalizeYtDlpError(detail, pageUrl))
  }

  let parsed: unknown = null
  for (const line of stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).reverse()) {
    try {
      parsed = JSON.parse(line)
      break
    } catch {
      // Keep looking - an update notice can share the stream.
    }
  }

  const listing = parseFlatPlaylist(parsed)
  if (listing.entries.length === 0) {
    throw new Error('That link lists no videos Draco can download')
  }
  log.info(`playlist ${listing.title}: ${listing.entries.length} entries`)
  return listing
}

export async function resolveMediaPage(
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<YouTubeResolution> {
  if (isSunoUrl(pageUrl)) return resolveSuno(pageUrl, headers)
  // khinsider publishes each track in several formats behind its own page, so
  // neither the extractor nor the generic HTML pass can see past the album
  // page's track links. Its own reader knows where the files actually are.
  if (isKhinsiderUrl(pageUrl)) return resolveKhinsider(pageUrl, headers)
  if (isXPage(pageUrl)) {
    const postUrl = xPostUrl(pageUrl)
    if (!postUrl) {
      throw new Error('Open a specific X post, or click Draco on the video in your X feed. The feed contains media from many posts.')
    }
    // Resolving via the Twitter syndication endpoint directly discovers full-resolution
    // photos, galleries, animated GIFs, and videos without yt-dlp dependency.
    const syndication = await resolveTwitterPost(postUrl, headers).catch(() => null)
    if (syndication && syndication.variants.length > 0) {
      return syndication
    }

    // Scanning the HTML of a status also collects replies and recommendations.
    // The extractor resolves this one status and its available video formats.
    const info = await loadInfo(postUrl, headers)
    const rawFormats = Array.isArray(info.formats)
      ? info.formats
      : Array.isArray(info.entries)
        ? info.entries.flatMap((entry: { formats?: YtDlpFormat[] }) => (Array.isArray(entry.formats) ? entry.formats : []))
        : []
    const formats = formatsFromYtDlp(rawFormats)
    const variants = buildVariants(formats)
    if (variants.length === 0) throw new Error('No downloadable video qualities were found for this X post.')
    return {
      id: info.id?.trim() || postUrl,
      title: info.title?.trim() || 'X video',
      variants,
      thumbnailUrl: safeHttpsThumbnail(info.thumbnail)
    }
  }
  // Run both paths: an extractor understands embedded players, while the HTML
  // pass sees direct/lazy images and site-builder video attributes. Ordinary
  // pages often contain both, and returning only whichever completed first
  // would hide valid downloads from the same link.
  const [extracted, declared] = await Promise.allSettled([
    (async (): Promise<YouTubeResolution> => {
      const info = await loadInfo(pageUrl, headers)
      const formats = formatsFromYtDlp(Array.isArray(info.formats) ? info.formats : [])
      const choices = [...buildVariants(formats), ...buildAudioVariants(formats)]
      if (choices.length === 0) throw new Error('yt-dlp found no directly downloadable media on this page.')
      return {
        id: info.id?.trim() || pageUrl,
        title: info.title?.trim() || 'Media',
        variants: choices,
        thumbnailUrl: safeHttpsThumbnail(info.thumbnail)
      }
    })(),
    resolveHtmlPageMedia(pageUrl, headers)
  ])

  const extractorResult = extracted.status === 'fulfilled' ? extracted.value : null
  const htmlResult = declared.status === 'fulfilled' ? declared.value : null
  if (!extractorResult && !htmlResult) {
    throw extracted.status === 'rejected'
      ? extracted.reason
      : declared.status === 'rejected' ? declared.reason : new Error('No downloadable media found')
  }
  if (!extractorResult) return htmlResult!
  if (!htmlResult) return extractorResult

  const variants = new Map<string, MediaVariant>()
  for (const variant of [...extractorResult.variants, ...htmlResult.variants]) {
    const identity = `${variant.url}\n${variant.audioUrl ?? ''}`
    if (!variants.has(identity)) variants.set(identity, variant)
  }
  return {
    id: extractorResult.id || htmlResult.id,
    title: extractorResult.title || htmlResult.title,
    variants: [...variants.values()],
    thumbnailUrl: extractorResult.thumbnailUrl || htmlResult.thumbnailUrl
  }
}

function safeYouTubeThumbnail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && /(^|\.)ytimg\.com$/i.test(url.hostname) ? url.href : null
  } catch {
    return null
  }
}

function safeHttpsThumbnail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export async function refreshYouTubeFormat(
  pageUrl: string,
  headers: RequestHeaders | undefined,
  formatId: string,
  force = true,
  wanted?: WantedFormat
): Promise<string> {
  // Reuse the combined account/public lookup unless a download URL expired.
  const info = await loadInfo(pageUrl, headers, force)
  const format = selectDirectYtFormat(info.formats ?? [], formatId, wanted)
  if (!format?.url) {
    // Two very different failures used to share one message, and the one that
    // actually happens is the second: yt-dlp answering with a ladder that has
    // no fetchable media in it at all, which no choice of itag would have
    // survived and which says nothing about the format the user picked.
    const fetchable = directFormats(info.formats ?? []).length
    throw new Error(
      fetchable === 0
        ? 'YouTube returned no downloadable media for this video. It may need a signed-in session, ' +
          'or YouTube is asking for a token yt-dlp could not produce - updating yt-dlp usually fixes it.'
        : `YouTube no longer offers format ${formatId}, and nothing comparable was on offer either`
    )
  }
  /*
   * A substitution is only a substitution while it stays near the rung that was
   * asked for. Below that it is a different download wearing the same filename,
   * and it used to happen in silence - see `describeQualityShortfall`. One rung
   * of slack, because the ladders of two YouTube clients genuinely disagree
   * about which heights exist and refusing on that would break working videos.
   */
  if (wanted?.kind === 'video') {
    const requestedHeight = wanted.height ?? null
    const lost = rungsBelow(requestedHeight, format.height ?? null)
    if (lost > 1) {
      const tier = tierFor(requestedHeight)
      throw new Error(
        describeQualityShortfall({
          wantedLabel: tier === null ? `${requestedHeight}p` : tierLabel(tier, null),
          offeredLabels: offeredTiers(info.formats ?? []),
          cookieBrowser: getSettings().cookiesFromBrowser
        })
      )
    }
  }

  if (format.format_id !== formatId) {
    log.warn(`YouTube format ${formatId} unavailable; substituting ${format.format_id}`)
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
/**
 * How many videos are remembered at once.
 *
 * Eight was sized for a person watching one video at a time. A playlist
 * expansion resolves three concurrently and then starts each of them as its own
 * download - which asks for the same lookup again - so eight entries thrashed
 * and every task paid the six-second cost twice. The entries are small (a
 * format ladder) and the TTL still bounds them.
 */
const INFO_CACHE_MAX = 64

/**
 * Lightweight, synchronously-readable status for whatever `loadInfo` is doing
 * for a given video - kept separate from `infoCache` so a UI can poll "is the
 * link ready yet" without touching the cached promise itself.
 *
 * This exists to answer a question that came up in practice: priming is meant
 * to hide the ~6s yt-dlp cost by starting the moment the video page loads, but
 * whether that actually finishes before the user presses Download was pure
 * guesswork before this. Now both the popup and the log file can see it.
 */
export type YouTubePrimeState =
  | { state: 'idle' }
  | { state: 'pending'; startedAt: number }
  | { state: 'ready'; tookMs: number }
  | { state: 'failed'; tookMs: number; error: string }

const primeStatus = new Map<string, YouTubePrimeState>()
const PRIME_STATUS_MAX = 64

function setPrimeStatus(key: string, value: YouTubePrimeState): void {
  primeStatus.delete(key)
  primeStatus.set(key, value)
  while (primeStatus.size > PRIME_STATUS_MAX) {
    const oldest = primeStatus.keys().next().value as string | undefined
    if (oldest === undefined) break
    primeStatus.delete(oldest)
  }
}

export function getYouTubePrimeStatus(pageUrl: string): YouTubePrimeState {
  return primeStatus.get(extractYouTubeId(pageUrl)) ?? { state: 'idle' }
}

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
  const videoId = extractYouTubeId(pageUrl)
  const browser = getSettings().cookiesFromBrowser
  // A public result must never satisfy a later lookup with captured cookies.
  // Hash the context so credentials cannot appear in cache diagnostics.
  const context = createHash('sha256').update(JSON.stringify(headers ?? {})).digest('hex')
  const key = `${videoId}:${browser}:${context}`
  const now = Date.now()

  if (!force) {
    const hit = infoCache.get(key)
    if (hit && now - hit.at < INFO_TTL_MS) {
      log.info(`reusing YouTube extraction cache for ${key}`)
      return hit.promise
    }
  }

  const startedAt = now
  setPrimeStatus(videoId, { state: 'pending', startedAt })
  log.info(`YouTube extraction started for ${key}${force ? ' (forced)' : ''}`)

  const promise = (async () => {
    const executable = await ensureYtDlp()
    if (!isSupportedYouTubeUrl(pageUrl)) return dumpJson(executable, pageUrl, headers)

    return loadYouTubeSessions(
      () => dumpJson(executable, pageUrl, withoutCookie(headers), 'none'),
      browser !== 'none' || headers?.cookie
        ? () => dumpJson(executable, pageUrl, headers, browser)
        : undefined,
      (error) => log.warn('YouTube browser session failed; keeping public formats: ' + String(error))
    )
  })()

  promise.then(
    () => {
      const tookMs = Date.now() - startedAt
      setPrimeStatus(videoId, { state: 'ready', tookMs })
      log.info(`YouTube extraction finished for ${key} in ${tookMs}ms`)
    },
    (err: unknown) => {
      const tookMs = Date.now() - startedAt
      const error = err instanceof Error ? err.message : String(err)
      setPrimeStatus(videoId, { state: 'failed', tookMs, error })
      log.warn(`YouTube extraction failed for ${key} after ${tookMs}ms: ${error}`)
    }
  )

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

/**
 * Replaces the copy in `%APPDATA%/Draco/bin` whatever is there already.
 *
 * yt-dlp is the part of this app with the shortest shelf life - YouTube changes
 * and a build from three months ago starts answering "no downloadable formats".
 * `ensureYtDlp` deliberately takes any working copy, so updating needs a door
 * that does not.
 */
export async function reinstallYtDlp(): Promise<string> {
  if (ytdlpProvision) return ytdlpProvision
  ytdlpProvision = downloadYtDlp(getPaths().ytDlpExe).finally(() => {
    ytdlpProvision = null
  })
  return ytdlpProvision
}

/** Where yt-dlp would come from right now, and whether Draco owns that copy. */
export async function locateYtDlp(): Promise<{ path: string; managed: boolean } | null> {
  // Same order as `provisionYtDlp`, and it has to be: this is what the tools
  // dialog reports a version for, so reading a different copy than the one that
  // actually runs is how "you are up to date" gets said about the wrong file.
  const target = getPaths().ytDlpExe
  if (await usable(target)) return { path: target, managed: true }
  const bundled = getPaths().bundledYtDlpExe
  if (await usable(bundled)) return { path: bundled, managed: true }
  const onPath = await findOnPath('yt-dlp.exe').catch(() => null)
  if (onPath && (await usable(onPath))) return { path: onPath, managed: false }
  return null
}

/** The build's own version string, e.g. `2025.08.11`. */
export async function ytDlpVersion(path: string): Promise<string | null> {
  const { stdout } = await runCapture(path, ['--version'], 15_000).catch(() => ({ stdout: '' }))
  return parseYtDlpVersion(stdout)
}

/** The version GitHub is currently calling latest, or null if it would not say. */
export async function latestYtDlpVersion(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetchGuarded(YTDLP_RELEASE_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Draco' },
      signal: controller.signal,
      timeoutMs: 20_000,
      requireHttps: true
    })
    if (!res.ok) return null
    const body = JSON.parse(await readResponseText(res, 200_000)) as Record<string, unknown>
    return typeof body.tag_name === 'string' ? parseYtDlpVersion(body.tag_name) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function provisionYtDlp(): Promise<string> {
  /*
   * Draco's own copy first, and PATH only when there is none.
   *
   * This used to be the other way round, which quietly disabled the update
   * button for anyone who already had yt-dlp installed: `reinstallYtDlp` writes
   * to `%APPDATA%/Draco/bin`, and a stale `C:\...\yt-dlp.exe` on PATH went on
   * winning every lookup afterwards. The symptom is the worst kind - updating
   * appears to succeed, and YouTube keeps failing in exactly the same way.
   *
   * A copy on PATH is still used when Draco has none of its own, because that
   * is somebody deliberately supplying one.
   */
  const target = getPaths().ytDlpExe
  if (await usable(target)) return target
  const bundled = getPaths().bundledYtDlpExe
  if (await usable(bundled)) return bundled

  const existing = await findOnPath('yt-dlp.exe').catch(() => null)
  if (existing && await usable(existing)) {
    log.info(`using yt-dlp from PATH: ${existing}`)
    return existing
  }

  return downloadYtDlp(target)
}

async function downloadYtDlp(target: string): Promise<string> {
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${randomUUID()}.download`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), YTDLP_LOOKUP_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetchGuarded(YTDLP_URL, {
        headers: { 'user-agent': 'Draco/0.1' },
        signal: controller.signal,
        timeoutMs: YTDLP_LOOKUP_TIMEOUT_MS,
        requireHttps: true
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

    const body = await readYtDlpBinary(res)
    if (body.length < MIN_YTDLP_BYTES) {
      throw new Error(`yt-dlp download was only ${body.length} bytes`)
    }

    await verifyYtDlpDigest(body, YTDLP_SUMS_URL)

    await writeFile(tmp, body)
    await chmod(tmp, 0o755)
    await replaceVerifiedExecutable(tmp, target, usable)

    log.info(`installed yt-dlp from ${YTDLP_URL}`)
    return target
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

const MAX_YTDLP_BYTES = 100 * 1024 * 1024

async function readYtDlpBinary(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_YTDLP_BYTES) throw new Error('yt-dlp executable is unexpectedly large')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('yt-dlp download has no body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_YTDLP_BYTES) throw new Error('yt-dlp executable is unexpectedly large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
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

/** A channel listing walks pages, so it gets longer than a single lookup. */
const PLAYLIST_LOOKUP_TIMEOUT_MS = 180_000

async function dumpJson(
  executable: string,
  url: string,
  headers?: RequestHeaders,
  cookieBrowser = getSettings().cookiesFromBrowser
): Promise<YtDlpInfo> {
  // Borrowed from the browser when the user has chosen one. This is the only
  // way a members-only or age-gated page resolves at all, and it applies to
  // every extractor because every lookup comes through here.
  const args = [
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--remote-components',
    'ejs:github',
    ...cookieArgs(cookieBrowser),
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
    // A cookie failure reads as an extractor failure unless it is named: the
    // message otherwise says the video is unavailable, when what happened is
    // that Chrome had the cookie database open.
    const cookieProblem = explainCookieFailure(stderr, cookieBrowser)
    if (cookieProblem) throw new Error(cookieProblem)

    const detail = lastUsefulLine(stderr) || lastUsefulLine(stdout) || `yt-dlp exited with ${code}`
    throw new Error(normalizeYtDlpError(detail, url))
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
      killTree(child)
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

    let stderr = ''
    let settled = false
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      stdoutBytes += chunk.length
      // Keep memory bounded, but drop old chunks efficiently
      while (stdoutBytes > 26 * 1024 * 1024 && stdoutChunks.length > 1) {
        const removed = stdoutChunks.shift()!
        stdoutBytes -= removed.length
      }
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
      let stdoutBuf = Buffer.concat(stdoutChunks)
      if (stdoutBuf.length > 25 * 1024 * 1024) stdoutBuf = stdoutBuf.subarray(stdoutBuf.length - 25 * 1024 * 1024)
      resolve({ code: code ?? -1, stdout: stdoutBuf.toString('utf8'), stderr })
    })
  })
}
