import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPaths } from './bootstrap/paths.ts'
import { validateUrl } from './engine/create.ts'
import { fetchGuarded } from './fetch-guard.ts'
import { readResponseBytes } from './response-limit.ts'
import { DEFAULT_USER_AGENT } from './engine/probe.ts'
import { logger } from './log.ts'
import { ThumbnailCache } from './thumbnail-cache.ts'
import { FinalizationPool } from './engine/finalization-pool.ts'

const log = logger('thumbnails')

/**
 * Poster images for the rows that have one - a YouTube video, a media page.
 *
 * These are fetched here and handed to the renderer as data URLs for the same
 * reason `icons.ts` does it: every window ships with `img-src 'self' data:`, and
 * a preview that loads straight from `i.ytimg.com` is both a hole in that and a
 * request the renderer makes on its own behalf. Widening the CSP would have been
 * one line and would have let any resolver-supplied host be contacted by a
 * window; this keeps the fetch in main, where the proxy and the URL guard
 * already live, and the window only ever sees bytes it cannot navigate to.
 *
 * The URL originates in web content - it is whatever yt-dlp or a page's own
 * markup claimed - so it goes through `validateUrl` with private addresses
 * refused, exactly like a download URL arriving from the extension.
 */

/** Data URL per source URL, `null` when the fetch produced nothing usable. */
const thumbnails = new ThumbnailCache(600, 32 * 1024 * 1024)
const thumbnailWork = new Map<string, Promise<string | null>>()
const thumbnailSlots = new FinalizationPool(4)

const THUMBNAIL_TIMEOUT_MS = 8_000
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024
/** Files kept on disk, so reopening the same playlist costs no requests. */
const THUMBNAIL_DISK_MAX = 1200

export async function thumbnailFor(rawUrl: string): Promise<string | null> {
  let url: string
  try {
    // Not just a parse: this is the guard that stops a resolver-supplied
    // "thumbnail" aiming main at the router or at localhost.
    url = validateUrl(rawUrl, { allowPrivate: false })
  } catch {
    return null
  }
  if (!/^https:/i.test(url)) return null

  const cached = thumbnails.get(url)
  if (cached !== undefined) return cached

  const existing = thumbnailWork.get(url)
  if (existing) return existing

  const work = (async () => {
    // A playlist can request hundreds together. Bound disk reads, network
    // buffers and base64 conversion as well as the retained cache.
    const release = await thumbnailSlots.acquire(new AbortController().signal)
    try {
      const saved = await readCached(url)
      if (saved) return saved

      const fetched = await fetchThumbnail(url)
      if (fetched) await writeCached(url, fetched)
      return fetched
    } finally {
      release?.()
    }
  })().catch((err: unknown) => {
    log.warn(`no thumbnail for ${url}: ${String(err)}`)
    return null
  })

  thumbnailWork.set(url, work)
  const result = await work
  thumbnailWork.delete(url)

  thumbnails.set(url, result)

  return result
}

function cachePath(url: string): string {
  const key = createHash('sha256').update(url).digest('hex')
  return join(getPaths().iconCache, 'thumbnails', `${key}.json`)
}

async function readCached(url: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(url), 'utf8')) as {
      url?: unknown
      dataUrl?: unknown
    }
    if (parsed.url !== url || typeof parsed.dataUrl !== 'string') return null
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(parsed.dataUrl)) return null
    if (parsed.dataUrl.length > THUMBNAIL_MAX_BYTES * 2) return null
    return parsed.dataUrl
  } catch {
    return null
  }
}

async function writeCached(url: string, dataUrl: string): Promise<void> {
  const dir = join(getPaths().iconCache, 'thumbnails')
  await mkdir(dir, { recursive: true })
  await writeFile(cachePath(url), JSON.stringify({ url, dataUrl }), 'utf8')
  await trimCache(dir)
}

async function trimCache(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
    if (names.length <= THUMBNAIL_DISK_MAX) return

    const dated = await Promise.all(
      names.map(async (name) => ({
        name,
        at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0
      }))
    )
    dated.sort((a, b) => a.at - b.at)
    for (const entry of dated.slice(0, dated.length - THUMBNAIL_DISK_MAX)) {
      await rm(join(dir, entry.name), { force: true }).catch(() => {})
    }
  } catch {
    // A cache that could not be trimmed is not a reason to fail a lookup.
  }
}

async function fetchThumbnail(url: string): Promise<string | null> {
  const response = await fetchGuarded(url, {
    signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS),
    headers: { accept: 'image/*', 'user-agent': DEFAULT_USER_AGENT },
    timeoutMs: THUMBNAIL_TIMEOUT_MS
  })
  try {
    if (!response.ok) return null

    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    // YouTube answers a missing `maxresdefault.jpg` with an HTML 404 page rather
    // than a 404 status, and a document is not an image.
    if (!type.startsWith('image/')) return null

    const bytes = await readResponseBytes(response, THUMBNAIL_MAX_BYTES)
    if (bytes.length === 0) return null

    return `data:${type};base64,${bytes.toString('base64')}`
  } finally {
    await response.body?.cancel().catch(() => {})
  }
}
