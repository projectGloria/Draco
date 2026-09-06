import { createHash } from 'node:crypto'
import { posix, join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { getDispatcher } from '../engine/http.ts'
import { mapConcurrent } from '../engine/concurrency.ts'

export interface SiteGrabOptions {
  startUrl: string
  maxDepth: number
  maxPages: number
  includeAssets: boolean
  stayOnHost: boolean
  respectRobots: boolean
}

export interface SiteResource {
  url: string
  relativePath: string
  kind: 'page' | 'asset'
  /** Points to a temporary file containing the raw downloaded HTML. */
  tmpFile?: string
}

const PAGE_BYTES_LIMIT = 5 * 1024 * 1024

/** Bounded breadth-first crawler for offline site-grabber projects. */
/**
 * How many pages are fetched at once.
 *
 * The crawl used to be strictly sequential, so a thousand-page project meant a
 * thousand round trips end to end - minutes of an unresponsive dialog spent
 * almost entirely waiting on the network. Modest on purpose: this is somebody
 * else's server, and the point is to stop wasting the latency rather than to
 * hammer it.
 */
const PAGE_CONCURRENCY = 6

export async function crawlSite(
  raw: SiteGrabOptions,
  signal?: AbortSignal
): Promise<{ resources: SiteResource[], paths: Map<string, string>, tmpDir: string }> {
  const start = secureHttpUrl(raw.startUrl)
  const options = {
    maxDepth: clamp(raw.maxDepth, 0, 5),
    maxPages: clamp(raw.maxPages, 1, 1000),
    includeAssets: raw.includeAssets !== false,
    stayOnHost: raw.stayOnHost !== false,
    respectRobots: raw.respectRobots !== false
  }
  const robots = options.respectRobots ? await loadRobots(start.origin, signal) : []
  const resources = new Map<string, SiteResource>()
  const maxResources = Math.min(10_000, options.maxPages * 50)
  const tmpDir = await mkdtemp(join(tmpdir(), 'draco-crawler-'))

  // Breadth-first, one depth at a time. Keeping the frontier as a level rather
  // than a single queue is what makes the fetches inside it safe to run
  // together: every page in a level has the same depth, so none of them can
  // change whether another belongs in it.
  const visited = new Set<string>()
  let frontier: URL[] = blockedByRobots(start, robots) ? [] : [start]
  visited.add(withoutHash(start))

  try {
    for (let depth = 0; depth <= options.maxDepth && frontier.length > 0; depth++) {
      if (signal?.aborted) throw new Error('The site crawl was cancelled')

      const next = new Map<string, URL>()

      await mapConcurrent(frontier, PAGE_CONCURRENCY, async (url) => {
        if (signal?.aborted) return
        const canonical = withoutHash(url)

        const response = await fetch(canonical, {
          headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'DracoSiteGrabber/0.1' },
          redirect: 'follow',
          signal,
          dispatcher: getDispatcher(30_000)
        } as RequestInit).catch(() => null)
        if (!response?.ok) return
        const final = new URL(response.url || canonical)
        if (options.stayOnHost && final.host !== start.host) return
        const type = response.headers.get('content-type') ?? ''
        if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
          resources.set(withoutHash(final), resourceFor(final, 'asset'))
          return
        }

        const declared = Number(response.headers.get('content-length') ?? 0)
        if (declared > PAGE_BYTES_LIMIT) return
        const html = await response.text()
        if (html.length > PAGE_BYTES_LIMIT) return

        const tmpFile = join(tmpDir, createHash('sha1').update(final.toString()).digest('hex') + '.html')
        await writeFile(tmpFile, html, 'utf8')
        resources.set(withoutHash(final), { ...resourceFor(final, 'page'), tmpFile })

        for (const link of extractLinks(html, final)) {
          if (options.stayOnHost && link.url.host !== start.host) continue
          if (link.kind === 'page') {
            if (depth >= options.maxDepth) continue
            const key = withoutHash(link.url)
            if (visited.has(key) || next.has(key)) continue
            if (blockedByRobots(link.url, robots)) continue
            next.set(key, link.url)
          } else if (link.kind === 'asset' && options.includeAssets) {
            if (resources.size >= maxResources) continue
            resources.set(withoutHash(link.url), resourceFor(link.url, 'asset'))
          }
        }
      })

      // The page budget is spent across the whole crawl, not per level.
      frontier = []
      for (const [key, url] of next) {
        if (visited.size >= options.maxPages) break
        visited.add(key)
        frontier.push(url)
      }
    }

    const paths = new Map([...resources.values()].map((resource) => [resource.url, resource.relativePath]))
    return { resources: [...resources.values()], paths, tmpDir }
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export function extractLinks(html: string, base: URL): Array<{ url: URL; kind: 'page' | 'asset' }> {
  const out = new Map<string, { url: URL; kind: 'page' | 'asset' }>()
  const add = (raw: string, kind: 'page' | 'asset'): void => {
    if (out.size >= 10_000) return
    if (!raw || raw.startsWith('#') || /^(?:data|javascript|mailto|tel):/i.test(raw)) return
    try {
      const url = new URL(decodeHtml(raw), base)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return
      url.hash = ''
      const key = url.toString()
      const existing = out.get(key)
      if (!existing || kind === 'page') out.set(key, { url, kind })
    } catch {}
  }

  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gi)) add(match[2], 'page')
  for (const match of html.matchAll(/<(?:img|script|source|video|audio|track|embed)\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi)) add(match[2], 'asset')
  for (const match of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1/gi)) add(match[2], 'asset')
  for (const match of html.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) add(match[2], 'asset')
  return [...out.values()]
}

export function resourceFor(url: URL, kind: 'page' | 'asset'): SiteResource {
  let pathname = safePathname(url.pathname)
  if (kind === 'page' && (pathname.endsWith('/') || !posix.extname(pathname))) pathname += pathname.endsWith('/') ? 'index.html' : '.html'
  if (!pathname || pathname === '/') pathname = '/index.html'
  if (url.search) {
    const extension = posix.extname(pathname)
    const hash = createHash('sha256').update(url.search).digest('hex').slice(0, 8)
    pathname = extension ? `${pathname.slice(0, -extension.length)}-${hash}${extension}` : `${pathname}-${hash}`
  }
  return { url: withoutHash(url), relativePath: pathname.replace(/^\/+/, ''), kind }
}

export function rewriteForOffline(
  html: string,
  pageUrl: URL,
  pagePath: string,
  paths: Map<string, string>
): string {
  const local = (raw: string): string => {
    try {
      const url = new URL(decodeHtml(raw), pageUrl)
      url.hash = ''
      const target = paths.get(url.toString())
      if (!target) return raw
      const relative = posix.relative(posix.dirname(pagePath), target)
      return relative.startsWith('.') ? relative : './' + relative
    } catch {
      return raw
    }
  }

  return html
    .replace(/\b(href|src)\s*=\s*(["'])(.*?)\2/gi, (_whole, name: string, quote: string, value: string) => `${name}=${quote}${local(value)}${quote}`)
    .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_whole, quote: string, value: string) => `url(${quote}${local(value)}${quote})`)
}

function safePathname(pathname: string): string {
  const trailingSlash = pathname.endsWith('/')
  const safe = '/' + pathname.split('/').filter(Boolean).map((part) => {
    let decoded = part
    try { decoded = decodeURIComponent(part) } catch {}
    const safe = decoded.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '')
    return safe && safe !== '.' && safe !== '..' ? safe.slice(0, 180) : '_'
  }).join('/')
  return trailingSlash && safe !== '/' ? safe + '/' : safe
}

async function loadRobots(origin: string, signal?: AbortSignal): Promise<RobotsRule[]> {
  try {
    const response = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': 'DracoSiteGrabber/0.1' }, signal, dispatcher: getDispatcher(10_000)
    } as RequestInit)
    if (!response.ok) return []
    const text = (await response.text()).slice(0, 1_000_000)
    let applies = false
    const rules: RobotsRule[] = []
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim()
      const separator = line.indexOf(':')
      if (separator < 0) continue
      const key = line.slice(0, separator).trim().toLowerCase()
      const value = line.slice(separator + 1).trim()
      if (key === 'user-agent') {
        applies = value === '*' || value.toLowerCase().includes('dracositegrabber')
      } else if (applies && (key === 'disallow' || key === 'allow') && value.startsWith('/')) {
        // Allow was ignored entirely, so the common "Disallow: /" plus
        // "Allow: /docs/" shape blocked the whole site - including the part the
        // publisher had explicitly opened up.
        rules.push({ path: value, allow: key === 'allow' })
      }
    }
    return rules
  } catch {
    return []
  }
}

export interface RobotsRule {
  path: string
  allow: boolean
}

/**
 * The standard longest-match rule: the most specific matching path wins, and a
 * tie goes to Allow.
 */
function blockedByRobots(url: URL, rules: RobotsRule[]): boolean {
  let best: RobotsRule | null = null
  for (const rule of rules) {
    if (!url.pathname.startsWith(rule.path)) continue
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
      best = rule
    }
  }
  return best ? !best.allow : false
}

function secureHttpUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Site address must use HTTP or HTTPS')
  url.hash = ''
  return url
}

function withoutHash(url: URL): string {
  const copy = new URL(url)
  copy.hash = ''
  return copy.toString()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number(value)) || min))
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
}
