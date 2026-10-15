import type { MediaVariant, RequestHeaders, YouTubeResolution } from '../shared/types.ts'
import { fetchGuarded } from './fetch-guard.ts'
import { isPrivateHost } from './engine/create.ts'
import { DEFAULT_USER_AGENT } from './engine/probe.ts'
import { readResponseText } from './response-limit.ts'

const MAX_HTML_BYTES = 5 * 1024 * 1024
const MAX_EMBEDDED_PAGES = 8
const MAX_EMBED_DEPTH = 2

/**
 * Headers for fetching a URL the *page* declared - an embedded player frame or
 * a media asset. Unlike the root page, which the user chose, these addresses
 * are attacker-influenced, so they never receive the session's cookies and are
 * held to the same private-network boundary as extension-supplied URLs.
 */
function pageControlledHeaders(
  headers: RequestHeaders | undefined,
  referer: string | undefined
): Record<string, string> {
  return {
    'user-agent': headers?.userAgent || DEFAULT_USER_AGENT,
    ...(referer ? { referer } : {})
  }
}

interface Candidate {
  kind: 'video' | 'audio' | 'image'
  url: string
  score: number
  container: string | null
}

/** Fetches a normal web page and resolves media that is declared in its HTML. */
export async function resolveHtmlPageMedia(
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<YouTubeResolution> {
  const root = await fetchHtmlPage(pageUrl, headers, headers?.referer)
  // Whether private-network media may be probed follows the root page: an
  // intranet page declaring intranet media is legitimate, a public page
  // declaring `http://169.254.169.254/...` is request forgery.
  const rootIsPrivate = isPrivateHost(new URL(root.url).hostname)
  const pages: Array<{ html: string; url: string }> = [root]
  const visited = new Set([root.url])
  let frontier = [{ ...root, depth: 0 }]

  while (frontier.length > 0 && pages.length < MAX_EMBEDDED_PAGES + 1) {
    const targets = frontier.flatMap((page) =>
      page.depth >= MAX_EMBED_DEPTH
        ? []
        : extractEmbeddedPageUrls(page.html, page.url).map((url) => ({
            url,
            referer: page.url,
            depth: page.depth + 1
          }))
    ).filter((target) => {
      if (visited.has(target.url)) return false
      visited.add(target.url)
      // Embedded frames are chosen by the page, never by the user.
      if (!rootIsPrivate && isPrivateHost(new URL(target.url).hostname)) return false
      return true
    }).slice(0, MAX_EMBEDDED_PAGES + 1 - pages.length)

    const fetched = await mapConcurrent(targets, 4, async (target) => {
      try {
        // Embedded frames are page-chosen, so the session's cookies stay home.
        return {
          ...(await fetchHtmlPage(target.url, headers, target.referer, false)),
          depth: target.depth
        }
      } catch {
        return null
      }
    })
    frontier = fetched.filter((page): page is { html: string; url: string; depth: number } => page !== null)
    pages.push(...frontier.map(({ html, url }) => ({ html, url })))
  }

  const resolutions: YouTubeResolution[] = []
  for (const page of pages) {
    try {
      resolutions.push(extractPageMedia(page.html, page.url))
    } catch {}
  }
  const unique = new Map<string, MediaVariant>()
  for (const resolution of resolutions) {
    for (const variant of resolution.variants) {
      if (!unique.has(variant.url)) unique.set(variant.url, variant)
    }
  }
  const ordered = [...unique.values()].sort((a, b) => mediaVariantOrder(a) - mediaVariantOrder(b))
  // Media URLs are read straight out of the page's HTML, so they are held to
  // the page's own network boundary before anything is fetched from them.
  const variants = await mapConcurrent(
    ordered.filter((variant) => rootIsPrivate || !isPrivateHost(new URL(variant.url).hostname)).slice(0, 50),
    8,
    (variant) => inspectAsset(variant, pageUrl, headers)
  )
  const reachable = variants.filter((variant): variant is MediaVariant => variant !== null)
  if (reachable.length === 0) {
    throw new Error('No reachable video, audio, or image was found on this page or its embedded players')
  }
  const rootResolution = resolutions.find((resolution) => resolution.id === root.url)
  return {
    id: pageUrl,
    title: rootResolution?.title || pageTitle(root.html) || resolutions[0]?.title || 'Page media',
    variants: reachable,
    thumbnailUrl: rootResolution?.thumbnailUrl || resolutions.find((item) => item.thumbnailUrl)?.thumbnailUrl || null
  }
}

async function fetchHtmlPage(
  url: string,
  headers: RequestHeaders | undefined,
  referer: string | undefined,
  withCredentials = true
): Promise<{ html: string; url: string }> {
  const response = await fetchGuarded(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': headers?.userAgent || DEFAULT_USER_AGENT,
      ...(referer ? { referer } : {}),
      ...(withCredentials && headers?.cookie ? { cookie: headers.cookie } : {})
    },
    timeoutMs: 30_000
  })
  if (!response.ok) throw new Error(`Page inspection failed with HTTP ${response.status}`)
  const type = response.headers.get('content-type') ?? ''
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
    throw new Error('The address is not an HTML media page')
  }
  const html = await readResponseText(response, MAX_HTML_BYTES)
  return { html, url: response.url || url }
}

/** Returns likely player-frame pages without turning inspection into a crawler. */
export function extractEmbeddedPageUrls(html: string, pageUrl: string): string[] {
  const base = new URL(pageUrl)
  const candidates: Array<{ url: string; score: number }> = []
  for (const match of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const raw = attrs.src || attrs['data-src']
    if (!raw || /^(?:data|blob|javascript):/i.test(raw)) continue
    try {
      const url = new URL(raw, base)
      if (!/^https?:$/.test(url.protocol) || url.href === pageUrl) continue
      const text = `${url.hostname}${url.pathname}`
      if (/(?:^|[.-])ads?(?:[.-]|$)|doubleclick|smartpop|popunder|mavrtracktor|adtng|magsrv/i.test(text)) continue
      const dimensions = numeric(attrs.width) * numeric(attrs.height)
      const playerHint = /(?:embed|player|video|stream|watch)/i.test(text) ? 1_000_000 : 0
      candidates.push({ url: url.href, score: playerHint + dimensions })
    } catch {}
  }
  return [...new Map(candidates.sort((a, b) => b.score - a.score).map((item) => [item.url, item])).values()]
    .slice(0, 6)
    .map((item) => item.url)
}

/** Pure HTML extraction kept exported for ranking and regression tests. */
export function extractPageMedia(html: string, pageUrl: string): YouTubeResolution {
  const base = new URL(pageUrl)
  const candidates: Candidate[] = []
  let imagePreview: string | null = null

  const add = (kind: Candidate['kind'], raw: string | undefined, score = 0, mime?: string): void => {
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return
    try {
      const url = new URL(decodeHtml(raw), base)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      const container = containerFrom(url, mime)
      candidates.push({ kind, url: url.href, score, container })
      if (kind === 'image' && !imagePreview) imagePreview = url.href
    } catch {}
  }

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    const property = (attrs.property || attrs.name || '').toLowerCase()
    if (/^og:video(?::url)?$/.test(property)) add('video', attrs.content, 10_000, attrs.type)
    else if (/^og:audio(?::url)?$/.test(property)) add('audio', attrs.content, 10_000, attrs.type)
    else if (/^(?:og:image(?::url)?|twitter:image(?::src)?)$/.test(property)) {
      add('image', attrs.content, 1, attrs.type)
    }
  }

  for (const match of html.matchAll(/<(video|audio|source|img)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase()
    const attrs = attributes(match[0])
    const inferred = tag === 'video' ? 'video' : tag === 'audio' ? 'audio' : kindFrom(attrs.type, attrs.src)
    if (tag === 'img') {
      const original = attrs['data-img-zoom-url'] || attrs['data-original'] || attrs['data-src']
      const responsive = parseSrcset(attrs.srcset || '').sort((a, b) => b.score - a.score)[0]
      if (original) add('image', original, 20_000, attrs.type)
      else if (responsive) add('image', responsive.url, responsive.score, attrs.type)
      else add('image', attrs.src, numeric(attrs.width), attrs.type)
    } else if (inferred) {
      add(inferred, attrs.src, numeric(attrs.width) * numeric(attrs.height), attrs.type)
    }
  }

  /*
   * Tilda and similar builders keep playable/background resources in custom
   * data attributes instead of actual <video>/<img> sources.
   *
   * This used to walk every tag in the document - `matchAll(/<[a-z][^>]*>/gi)`
   * - and run the attribute parser, itself a `matchAll`, on each one. On a 5 MB
   * page that is a nested scan of the whole document, synchronously, on the
   * same event loop that drains every download's sockets; and `resolveMediaPage`
   * does it for up to nine pages. Only about a dozen attribute names were ever
   * being looked for, so they are searched for directly instead: one pass per
   * name rather than one parse per tag.
   */
  for (const [name, kind, score, mime] of DATA_ATTRIBUTE_SOURCES) {
    for (const value of attributeValues(html, name)) {
      if (kind === null) {
        const inferred = kindFrom(undefined, value)
        if (inferred) add(inferred, value, score)
      } else {
        add(kind, value, score, mime)
      }
    }
  }

  // Players such as Fluid Player are often initialized from inline JSON:
  // `{ sources: [{ src: "https:\/\/cdn.example/movie.mp4" }] }`. There is no
  // usable <source> node in the server HTML, but the media URL is still plainly
  // declared. Decode only common string escapes, then accept URL-shaped values
  // with known media extensions; arbitrary script expressions never execute.
  for (const raw of embeddedMediaUrls(html)) {
    const kind = kindFrom(undefined, raw)
    if (kind) add(kind, raw, 15_000)
  }

  const order = { video: 0, audio: 1, image: 2 } as const
  const unique = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const previous = unique.get(candidate.url)
    if (!previous || candidate.score > previous.score) unique.set(candidate.url, candidate)
  }
  const selected = [...unique.values()]
    .sort((a, b) => order[a.kind] - order[b.kind] || b.score - a.score)
    .slice(0, 50)
  if (selected.length === 0) {
    throw new Error('No downloadable video, audio, or image was declared by this page')
  }

  const variants: MediaVariant[] = selected.map((candidate) => ({
    url: candidate.url,
    audioUrl: null,
    label: `${candidate.kind === 'audio' ? 'Music' : titleCase(candidate.kind)} · ${nameFromUrl(candidate.url)}`,
    height: null,
    bandwidth: null,
    codecs: null,
    estimatedSize: null,
    container: candidate.container
  }))
  const title = pageTitle(html)

  return {
    id: pageUrl,
    title: title || 'Page media',
    variants,
    thumbnailUrl: imagePreview
  }
}

export function embeddedMediaUrls(html: string): string[] {
  const decoded = decodeHtml(html)
    .replace(/\\u002f/gi, '/')
    .replace(/\\x2f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
  const extensions = '(?:mp4|webm|mkv|mov|m4v|m3u8|mpd|mp3|m4a|aac|opus|ogg|oga|flac|wav)'
  const values = new Set<string>()
  const add = (value: string): void => {
    const cleaned = value.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&')
    if (cleaned.length <= 20_000) values.add(cleaned)
  }

  const absolute = new RegExp(`(?:https?:)?//[^\\s"'<>\\\\]+?\\.${extensions}(?:\\?[^\\s"'<>\\\\]*)?`, 'gi')
  for (const match of decoded.matchAll(absolute)) add(match[0])

  const relative = new RegExp(`(["'])((?:\\.{0,2}/)[^"'<>]+?\\.${extensions}(?:\\?[^"'<>]*)?)\\1`, 'gi')
  for (const match of decoded.matchAll(relative)) add(match[2])
  return [...values]
}

function nameFromUrl(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean).pop() || 'download')
  } catch {
    return 'download'
  }
}

function mediaVariantOrder(variant: MediaVariant): number {
  if (/^Video\b/i.test(variant.label)) return 0
  if (/^Music\b/i.test(variant.label)) return 1
  return 2
}

function pageTitle(html: string): string {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0])
    if ((attrs.property || attrs.name || '').toLowerCase() === 'og:title' && attrs.content?.trim()) {
      return decodeHtml(attrs.content).replace(/\s+/g, ' ').trim()
    }
  }
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
  if (heading) {
    const text = decodeHtml(heading.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return decodeHtml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleCase(value: 'video' | 'image'): string {
  return value[0].toUpperCase() + value.slice(1)
}

/**
 * The custom attributes page builders hide media in, and what each one means.
 *
 * A `null` kind means "work it out from the value", which is what the old
 * catch-all loop over `data-src`/`data-url`/... did. Everything else names its
 * kind outright, because the attribute name is more reliable than the URL.
 */
const DATA_ATTRIBUTE_SOURCES: ReadonlyArray<
  [name: string, kind: Candidate['kind'] | null, score: number, mime?: string]
> = [
  ['data-content-video-url-mp4', 'video', 30_000, 'video/mp4'],
  ['data-content-video-url-webm', 'video', 30_000, 'video/webm'],
  ['data-video-url', 'video', 20_000],
  ['data-img-zoom-url', 'image', 20_000],
  ['data-original', 'image', 20_000],
  ['data-content-cover-bg', 'image', 10_000],
  ['data-src', null, 15_000],
  ['data-source', null, 15_000],
  ['data-file', null, 15_000],
  ['data-url', null, 15_000],
  ['data-video', null, 15_000],
  ['data-media', null, 15_000],
  ['src', null, 15_000]
]

/** Every value one attribute name carries anywhere in the document. */
function attributeValues(html: string, name: string): string[] {
  const pattern = new RegExp(
    `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:(["'])(.*?)\\1|([^\\s>]+))`,
    'gi'
  )
  const out: string[] = []
  for (const match of html.matchAll(pattern)) {
    const value = decodeHtml(match[2] ?? match[3] ?? '')
    if (value) out.push(value)
  }
  return out
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of tag.matchAll(/\b([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:(["'])(.*?)\2|([^\s>]+))/gi)) {
    out[match[1].toLowerCase()] = decodeHtml(match[3] ?? match[4] ?? '')
  }
  return out
}

function parseSrcset(value: string): Array<{ url: string; score: number }> {
  return value.split(',').map((part) => {
    const [url, descriptor = ''] = part.trim().split(/\s+/, 2)
    const width = /^(\d+(?:\.\d+)?)w$/i.exec(descriptor)
    const density = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor)
    return { url, score: width ? Number(width[1]) : density ? Number(density[1]) * 1000 : 0 }
  }).filter((entry) => entry.url)
}

function kindFrom(mime: string | undefined, rawUrl: string | undefined): 'video' | 'audio' | null {
  if (/^video\//i.test(mime ?? '')) return 'video'
  if (/^audio\//i.test(mime ?? '')) return 'audio'
  const path = rawUrl ?? ''
  if (/\.(mp4|webm|mkv|mov|m4v|m3u8|mpd)(?:[?#]|$)/i.test(path)) return 'video'
  if (/\.(mp3|m4a|aac|opus|ogg|oga|flac|wav)(?:[?#]|$)/i.test(path)) return 'audio'
  return null
}

function containerFrom(url: URL, mime?: string): string | null {
  const mimeExt = /^(?:video|audio|image)\/([a-z0-9.+-]+)/i.exec(mime ?? '')?.[1]
  if (mimeExt) return mimeExt === 'jpeg' ? 'jpg' : mimeExt.replace('x-', '').split('+')[0]
  const ext = /\.([a-z0-9]{2,8})$/i.exec(url.pathname)?.[1]?.toLowerCase()
  return ext === 'jpeg' ? 'jpg' : ext ?? null
}

function numeric(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_whole, code: string) => String.fromCodePoint(parseInt(code, 16)))
}

async function inspectAsset(
  variant: MediaVariant,
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<MediaVariant | null> {
  try {
    return await requestAssetInfo(variant, variant.url, pageUrl, headers)
  } catch (error) {
    // Some old sites still advertise HTTPS on a media host whose certificate
    // has expired while the exact same resource remains available over HTTP.
    // Downgrade only for a TLS validation failure, never for 4xx/5xx or a
    // missing file, and make the transport visible in the row label.
    if (!variant.url.startsWith('https:') || !isTlsFailure(error)) return null
    try {
      const fallback = 'http:' + variant.url.slice('https:'.length)
      const inspected = await requestAssetInfo(variant, fallback, pageUrl, headers)
      return { ...inspected, label: `${inspected.label} · HTTP fallback` }
    } catch {
      return null
    }
  }
}

async function requestAssetInfo(
  variant: MediaVariant,
  url: string,
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<MediaVariant> {
  // The asset address was declared by the page, so it is probed without the
  // session's cookies - the probe exists to learn a size and a container, and
  // must not be usable to relay credentials to an attacker-chosen host.
  const requestHeaders = pageControlledHeaders(headers, headers?.referer || pageUrl)
  let response = await fetchGuarded(url, {
    method: 'HEAD',
    headers: requestHeaders,
    timeoutMs: 20_000
  })

  if (!response.ok || !positiveLength(response.headers.get('content-length'))) {
    response = await fetchGuarded(url, {
      headers: { ...requestHeaders, range: 'bytes=0-0' },
      timeoutMs: 20_000
    })
    if (!response.ok) throw new Error(`Asset returned HTTP ${response.status}`)
    await response.body?.cancel()
  }

  const rangeTotal = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]
  const size = rangeTotal ? Number(rangeTotal) : positiveLength(response.headers.get('content-length'))
  const finalUrl = response.url || url
  return {
    ...variant,
    // Keep the URL declared by the player. CDN redirect destinations are
    // frequently short-lived; the task probe must reopen this stable address
    // to obtain a fresh shard immediately before downloading.
    url,
    estimatedSize: size || null,
    container: containerFrom(new URL(finalUrl), response.headers.get('content-type') ?? undefined) || variant.container
  }
}

function positiveLength(value: string | null): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function isTlsFailure(error: unknown): boolean {
  const record = error as { message?: unknown; cause?: { code?: unknown; message?: unknown } }
  const detail = `${String(record?.message ?? '')} ${String(record?.cause?.code ?? '')} ${String(record?.cause?.message ?? '')}`
  return /certificate|cert_|tls|ssl|unable_to_verify|self.signed/i.test(detail)
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= values.length) return
      results[index] = await worker(values[index])
    }
  }))
  return results
}
