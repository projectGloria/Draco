/**
 * khinsider album pages: one link that means a whole soundtrack.
 *
 * The generic HTML pass in `page-media.ts` sees the album page's track anchors
 * - `/game-soundtracks/album/<album>/<track>.mp3` - and takes them for audio
 * files because of the suffix. They are not: each one is another HTML page, and
 * downloading them yields thirty copies of a web page named like a song. The
 * real files live on a CDN under a per-album random directory that only the
 * track page knows, and every track is published in each format the album was
 * uploaded in - commonly FLAC as well as MP3 - alongside the album artwork.
 *
 * So this reads the album the way the site models it: the album page for the
 * track list and the cover images, then one fetch per track page for the actual
 * download links and their sizes.
 */

import type { MediaVariant, RequestHeaders, YouTubeResolution } from '../shared/types.ts'
import { mapConcurrent } from './engine/concurrency.ts'
import { getDispatcher } from './engine/http.ts'
import { DEFAULT_USER_AGENT } from './engine/probe.ts'
import { logger } from './log.ts'

const log = logger('khinsider')

const MAX_HTML_BYTES = 5 * 1024 * 1024
/** Albums this long are rare; the cap bounds the fetch fan-out, not the album. */
const MAX_TRACKS = 300
const TRACK_CONCURRENCY = 8

/**
 * Best first. The order decides which format a track is downloaded in when the
 * user just accepts the selection, so it is quality order, not popularity.
 */
const AUDIO_FORMATS = ['flac', 'wav', 'aiff', 'ape', 'm4a', 'ogg', 'opus', 'aac', 'mp3']
const IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']

/** Any khinsider album page, or one track page inside an album. */
export function isKhinsiderUrl(value: unknown): boolean {
  const url = parseUrl(value)
  return url !== null && /^\/game-soundtracks\/album\/[^/]+/i.test(url.pathname)
}

export async function resolveKhinsider(
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<YouTubeResolution> {
  const root = await fetchPage(pageUrl, headers, headers?.referer)

  if (isTrackPath(new URL(root.url).pathname)) {
    const track = parseTrackPage(root.html, root.url)
    const variants = trackVariants(track)
    if (variants.length === 0) throw new Error('khinsider offered no downloadable file for this track')
    return { id: root.url, title: track.title, variants, thumbnailUrl: null }
  }

  const album = parseAlbumPage(root.html, root.url)
  if (album.trackUrls.length === 0 && album.images.length === 0) {
    throw new Error('That khinsider page listed no tracks or artwork')
  }

  const tracks = await mapConcurrent(album.trackUrls, TRACK_CONCURRENCY, async (trackUrl) => {
    try {
      const page = await fetchPage(trackUrl, headers, root.url)
      return parseTrackPage(page.html, page.url)
    } catch {
      // One unreachable track page must not cost the user the other thirty.
      return null
    }
  })

  const variants: MediaVariant[] = []
  for (const track of tracks) {
    if (track) variants.push(...trackVariants(track))
  }
  for (const image of album.images) variants.push(imageVariant(image))

  if (variants.length === 0) throw new Error('khinsider offered no downloadable files for this album')
  const failed = tracks.filter((track) => track === null).length
  log.info(
    `album ${album.title}: ${tracks.length - failed}/${album.trackUrls.length} tracks, ` +
    `${album.images.length} image(s), ${variants.length} files`
  )

  return {
    id: root.url,
    title: album.title,
    variants,
    thumbnailUrl: album.images[0]?.thumbnailUrl ?? album.images[0]?.url ?? null
  }
}

export interface KhinsiderTrack {
  title: string
  /** One entry per published format, best quality first. */
  files: Array<{ url: string; format: string; size: number | null }>
}

export interface KhinsiderAlbum {
  title: string
  trackUrls: string[]
  images: Array<{ url: string; thumbnailUrl: string | null }>
}

/** Pure parse of an album page, kept exported so it can be tested offline. */
export function parseAlbumPage(html: string, pageUrl: string): KhinsiderAlbum {
  const base = new URL(pageUrl)
  const albumPrefix = base.pathname.replace(/\/+$/, '') + '/'

  const trackUrls: string[] = []
  const seen = new Set<string>()
  for (const anchor of anchors(html)) {
    const url = absolute(anchor.href, base)
    if (!url || url.host !== base.host) continue
    if (!url.pathname.toLowerCase().startsWith(albumPrefix.toLowerCase())) continue
    if (!isTrackPath(url.pathname)) continue
    url.hash = ''
    const key = url.toString()
    if (seen.has(key)) continue
    seen.add(key)
    trackUrls.push(key)
    if (trackUrls.length >= MAX_TRACKS) break
  }

  return { title: albumTitle(html), trackUrls, images: albumImages(html, base) }
}

/** Pure parse of a single track page. */
export function parseTrackPage(html: string, pageUrl: string): KhinsiderTrack {
  const base = new URL(pageUrl)
  const files = new Map<string, { url: string; format: string; size: number | null }>()

  for (const anchor of anchors(html)) {
    const url = absolute(anchor.href, base)
    if (!url) continue
    const format = extensionOf(url)
    if (!format || !AUDIO_FORMATS.includes(format)) continue
    // The files sit on a separate CDN host; a same-host ".mp3" here is another
    // track page, exactly the confusion this module exists to avoid.
    if (url.host === base.host) continue
    const key = url.toString()
    const size = sizeFrom(anchor.tail)
    const existing = files.get(key)
    if (!existing) files.set(key, { url: key, format, size })
    else if (existing.size === null && size !== null) existing.size = size
  }

  const ordered = [...files.values()].sort(
    (a, b) => AUDIO_FORMATS.indexOf(a.format) - AUDIO_FORMATS.indexOf(b.format)
  )
  return { title: trackTitle(html, ordered[0]?.url ?? pageUrl), files: ordered }
}

/**
 * One row per published format.
 *
 * Only the best format is selected by default: an album offered as FLAC and MP3
 * would otherwise queue every track twice, which is never what somebody meant
 * by "download this album". The other rows stay visible and one click away.
 */
function trackVariants(track: KhinsiderTrack): MediaVariant[] {
  return track.files.map((file, index) => ({
    url: file.url,
    audioUrl: null,
    label: `${file.format.toUpperCase()} · ${track.title}`,
    height: null,
    bandwidth: null,
    codecs: file.format,
    estimatedSize: file.size,
    container: file.format,
    defaultSelected: index === 0
  }))
}

function imageVariant(image: { url: string; thumbnailUrl: string | null }): MediaVariant {
  const format = extensionOf(new URL(image.url)) ?? 'jpg'
  return {
    url: image.url,
    audioUrl: null,
    label: `Artwork · ${nameFromUrl(image.url)}`,
    height: null,
    bandwidth: null,
    codecs: null,
    estimatedSize: null,
    container: format,
    defaultSelected: true
  }
}

/**
 * The full-size covers, which the page links behind the thumbnails it shows.
 * Scoped to the artwork blocks so the sidebar of other albums' thumbnails does
 * not turn into "artwork" of this one.
 */
function albumImages(html: string, base: URL): Array<{ url: string; thumbnailUrl: string | null }> {
  const images = new Map<string, { url: string; thumbnailUrl: string | null }>()
  for (const block of html.matchAll(/<div\b[^>]*\bclass\s*=\s*(["'])[^"']*\balbumImage\b[^"']*\1[^>]*>([\s\S]*?)<\/div>/gi)) {
    const inner = block[2]
    const thumbnail = absolute(
      /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/i.exec(inner)?.[2] ?? '',
      base
    )?.toString() ?? null

    let linked = false
    for (const anchor of anchors(inner)) {
      const url = absolute(anchor.href, base)
      const format = url && extensionOf(url)
      if (!url || !format || !IMAGE_FORMATS.includes(format)) continue
      linked = true
      if (!images.has(url.toString())) images.set(url.toString(), { url: url.toString(), thumbnailUrl: thumbnail })
    }
    // Some albums show the cover without linking a larger copy.
    if (!linked && thumbnail && !images.has(thumbnail)) images.set(thumbnail, { url: thumbnail, thumbnailUrl: thumbnail })
  }
  return [...images.values()]
}

function albumTitle(html: string): string {
  const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1]
  const text = heading ? plainText(heading) : ''
  if (text) return text
  const title = plainText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
  return title.replace(/\s*-\s*Download.*$/i, '').trim() || 'khinsider album'
}

function trackTitle(html: string, fallbackUrl: string): string {
  const named = /Song\s*name:\s*<b>([\s\S]*?)<\/b>/i.exec(html)?.[1]
  const text = named ? plainText(named) : ''
  if (text) return text
  const name = nameFromUrl(fallbackUrl)
  return name.replace(/\.[a-z0-9]{2,5}$/i, '') || 'Track'
}

interface Anchor {
  href: string
  /** Markup that follows the link, where khinsider prints "(7.55 MB)". */
  tail: string
}

function anchors(html: string): Anchor[] {
  const out: Anchor[] = []
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(match[1])?.[2] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(match[1])?.[1]
    if (!href) continue
    const end = (match.index ?? 0) + match[0].length
    out.push({ href: decodeHtml(href), tail: html.slice(end, end + 160) })
    if (out.length >= 5_000) break
  }
  return out
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }

function sizeFrom(text: string): number | null {
  const match = /\(\s*(\d+(?:\.\d+)?)\s*(bytes|[kmg]?b)\s*\)/i.exec(text)
  if (!match) return null
  const unit = match[2].toLowerCase() === 'bytes' ? 'b' : match[2].toLowerCase()
  const bytes = Math.round(Number(match[1]) * (SIZE_UNITS[unit] ?? 0))
  return bytes > 0 ? bytes : null
}

/**
 * `/game-soundtracks/album/<album>/<track>.<ext>` - one segment below the
 * album, named after the file it is about. The extension is what separates a
 * track page from the album's other sub-pages, such as `/change_log`.
 */
function isTrackPath(pathname: string): boolean {
  const last = /^\/game-soundtracks\/album\/[^/]+\/([^/]+)\/?$/i.exec(decodePath(pathname))?.[1]
  const extension = last ? /\.([a-z0-9]{2,5})$/i.exec(last)?.[1]?.toLowerCase() : null
  return extension !== null && extension !== undefined && AUDIO_FORMATS.includes(extension)
}

async function fetchPage(
  url: string,
  headers: RequestHeaders | undefined,
  referer: string | undefined
): Promise<{ html: string; url: string }> {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': headers?.userAgent || DEFAULT_USER_AGENT,
      ...(referer ? { referer } : {}),
      ...(headers?.cookie ? { cookie: headers.cookie } : {})
    },
    redirect: 'follow',
    dispatcher: getDispatcher(30_000)
  } as RequestInit)
  if (!response.ok) throw new Error(`khinsider returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_HTML_BYTES) throw new Error('That khinsider page is too large to read')
  const html = await response.text()
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error('That khinsider page is too large to read')
  }
  return { html, url: response.url || url }
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return /(^|\.)khinsider\.com$/i.test(url.hostname) ? url : null
  } catch {
    return null
  }
}

function absolute(raw: string, base: URL): URL | null {
  if (!raw || raw.startsWith('#') || /^(?:data|javascript|mailto|tel):/i.test(raw)) return null
  try {
    const url = new URL(raw, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function extensionOf(url: URL): string | null {
  return /\.([a-z0-9]{2,5})$/i.exec(decodePath(url.pathname))?.[1]?.toLowerCase() ?? null
}

function nameFromUrl(value: string): string {
  try {
    return decodePath(new URL(value).pathname).split('/').filter(Boolean).pop() || 'download'
  } catch {
    return 'download'
  }
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

function plainText(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_whole, code: string) => String.fromCodePoint(parseInt(code, 16)))
}
