import { app } from 'electron'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { getPaths } from './bootstrap/paths.ts'
import { logger } from './log.ts'

const log = logger('icons')

/**
 * Icons that come from outside the app: the shell's association for a file
 * type, and a site's own favicon.
 *
 * A download manager shows two kinds of thing, and neither of them is really
 * Draco's. A .rar row should carry whatever the user's machine puts on a .rar -
 * WinRAR's icon if that is what opens them - because that is the icon they
 * already recognise; and a video taken from YouTube should be marked with
 * YouTube's own mark rather than a generic arrow. Both are looked up here,
 * cached for the life of the process, and handed to the renderer as data URLs
 * so the `img-src 'self' data:` CSP stays as tight as it is.
 */

/** Data URL per lowercase extension, `null` when the shell had nothing. */
const fileIcons = new Map<string, string | null>()
const fileIconWork = new Map<string, Promise<string | null>>()

/** Data URL per origin, `null` when the site served no usable favicon. */
const siteIcons = new Map<string, string | null>()
const siteIconWork = new Map<string, Promise<string | null>>()

/** Nothing longer or stranger than this is a file extension. */
const EXTENSION = /^[a-z0-9]{1,10}$/

const FAVICON_TIMEOUT_MS = 6_000
const FAVICON_MAX_BYTES = 512 * 1024

/**
 * The icon Windows shows for a file of this type.
 *
 * `app.getFileIcon` asks the shell about a *path*, so there has to be a file
 * there to ask about. An empty stand-in named `probe.rar` gets the same answer
 * a real archive would - the association is on the extension, not the contents -
 * and keeping it around means each type is only ever looked up once per install.
 */
export async function iconForExtension(rawExtension: string): Promise<string | null> {
  const extension = rawExtension.trim().toLowerCase().replace(/^\./, '')
  if (!EXTENSION.test(extension)) return null

  const cached = fileIcons.get(extension)
  if (cached !== undefined) return cached

  const existing = fileIconWork.get(extension)
  if (existing) return existing

  const work = (async () => {
    try {
      const dir = getPaths().iconCache
      await mkdir(dir, { recursive: true })

      const probe = join(dir, `probe.${extension}`)
      // Opened with 'a' rather than written: an existing stand-in must not be
      // truncated or replaced, and the file only ever needs to exist.
      await (await open(probe, 'a')).close()

      const image = await app.getFileIcon(probe, { size: 'normal' })
      if (image.isEmpty()) return null
      return image.toDataURL()
    } catch (err) {
      log.warn(`no shell icon for .${extension}: ${String(err)}`)
      return null
    }
  })()

  fileIconWork.set(extension, work)
  const result = await work
  fileIconWork.delete(extension)
  fileIcons.set(extension, result)
  return result
}

/**
 * The favicon of the site a download came from.
 *
 * Only ever the site the user was already on, and only `/favicon.ico`: this is
 * one request to a host the browser had open a moment ago, not a lookup against
 * some third-party icon service that would announce every page they download
 * from to a stranger.
 */
export async function iconForSite(url: string): Promise<string | null> {
  let origin: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    origin = parsed.origin
  } catch {
    return null
  }

  const cached = siteIcons.get(origin)
  if (cached !== undefined) return cached

  const existing = siteIconWork.get(origin)
  if (existing) return existing

  const work = fetchFavicon(origin).catch((err: unknown) => {
    log.warn(`no favicon for ${origin}: ${String(err)}`)
    return null
  })

  siteIconWork.set(origin, work)
  const result = await work
  siteIconWork.delete(origin)
  siteIcons.set(origin, result)
  return result
}

async function fetchFavicon(origin: string): Promise<string | null> {
  const response = await fetch(`${origin}/favicon.ico`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
    headers: { accept: 'image/*' }
  })
  if (!response.ok) return null

  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  // A site with no favicon usually answers with its own 404 page rather than a
  // 404 status, and an HTML document is not an icon.
  if (!type.startsWith('image/')) return null

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > FAVICON_MAX_BYTES) return null

  return `data:${type};base64,${bytes.toString('base64')}`
}
