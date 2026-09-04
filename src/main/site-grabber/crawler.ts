import { createHash } from 'node:crypto'
import { posix, join } from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { getDispatcher } from '../engine/http.ts'

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
export async function crawlSite(raw: SiteGrabOptions): Promise<{ resources: SiteResource[], paths: Map<string, string>, tmpDir: string }> {
  const start = secureHttpUrl(raw.startUrl)
  const options = {
    maxDepth: clamp(raw.maxDepth, 0, 5),
    maxPages: clamp(raw.maxPages, 1, 1000),
    includeAssets: raw.includeAssets !== false,
    stayOnHost: raw.stayOnHost !== false,
    respectRobots: raw.respectRobots !== false
  }
  const robots = options.respectRobots ? await loadRobots(start.origin) : []
  const queue: Array<{ url: URL; depth: number }> = [{ url: start, depth: 0 }]
  const visited = new Set<string>()
  const resources = new Map<string, SiteResource>()
  const maxResources = Math.min(10_000, options.maxPages * 50)
  const tmpDir = await mkdtemp(join(tmpdir(), 'draco-crawler-'))

  while (queue.length > 0 && visited.size < options.maxPages) {
    const current = queue.shift()!
    const canonical = withoutHash(current.url)
    if (visited.has(canonical) || blockedByRobots(current.url, robots)) continue
    if (options.stayOnHost && current.url.host !== start.host) continue
    visited.add(canonical)

    const response = await fetch(canonical, {
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'DracoSiteGrabber/0.1' },
      redirect: 'follow',
      dispatcher: getDispatcher(30_000)
    } as RequestInit).catch(() => null)
    if (!response?.ok) continue
    const final = new URL(response.url || canonical)
    if (options.stayOnHost && final.host !== start.host) continue
    const type = response.headers.get('content-type') ?? ''
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      resources.set(withoutHash(final), resourceFor(final, 'asset'))
      continue
    }

    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > PAGE_BYTES_LIMIT) continue
    const html = await response.text()
    if (html.length > PAGE_BYTES_LIMIT) continue
    
    const tmpFile = join(tmpDir, createHash('sha1').update(final.toString()).digest('hex') + '.html')
    await writeFile(tmpFile, html, 'utf8')
    resources.set(withoutHash(final), { ...resourceFor(final, 'page'), tmpFile })

    const links = extractLinks(html, final)
    for (const link of links) {
      if (resources.size >= maxResources && link.kind === 'asset') continue
      if (options.stayOnHost && link.url.host !== start.host) continue
      if (link.kind === 'page' && current.depth < options.maxDepth) {
        queue.push({ url: link.url, depth: current.depth + 1 })
      } else if (link.kind === 'asset' && options.includeAssets) {
        resources.set(withoutHash(link.url), resourceFor(link.url, 'asset'))
      }
    }
  }

  const paths = new Map([...resources.values()].map((resource) => [resource.url, resource.relativePath]))
  return { resources: [...resources.values()], paths, tmpDir }
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

async function loadRobots(origin: string): Promise<string[]> {
  try {
    const response = await fetch(new URL('/robots.txt', origin), {
      headers: { 'user-agent': 'DracoSiteGrabber/0.1' }, dispatcher: getDispatcher(10_000)
    } as RequestInit)
    if (!response.ok) return []
    const text = (await response.text()).slice(0, 1_000_000)
    let applies = false
    const disallow: string[] = []
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim()
      const separator = line.indexOf(':')
      if (separator < 0) continue
      const key = line.slice(0, separator).trim().toLowerCase()
      const value = line.slice(separator + 1).trim()
      if (key === 'user-agent') applies = value === '*' || value.toLowerCase().includes('dracositegrabber')
      else if (key === 'disallow' && applies && value.startsWith('/')) disallow.push(value)
    }
    return disallow
  } catch {
    return []
  }
}

function blockedByRobots(url: URL, disallow: string[]): boolean {
  return disallow.some((path) => path !== '/' ? url.pathname.startsWith(path) : true)
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
