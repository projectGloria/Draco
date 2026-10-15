import { useEffect, useState } from 'react'
import { extensionOf } from './format'

/**
 * Icons that come from outside the renderer: the shell's file-type association
 * and a site's favicon, both resolved in main and handed over as data URLs.
 *
 * Cached at module scope rather than in the store because they never change
 * while the app runs and every row asks for the same handful: a list of forty
 * archives is one lookup, not forty. `null` is a real answer - the shell had
 * nothing - and is remembered as such so a miss is not retried on every render.
 */

const fileIcons = new Map<string, string | null>()
const fileWork = new Map<string, Promise<string | null>>()

const siteIcons = new Map<string, string | null>()
const siteWork = new Map<string, Promise<string | null>>()

const thumbnails = new Map<string, string | null>()
const thumbnailWork = new Map<string, Promise<string | null>>()

function useRemembered(
  key: string | null,
  cache: Map<string, string | null>,
  work: Map<string, Promise<string | null>>,
  load: (key: string) => Promise<string | null>
): string | null {
  const [icon, setIcon] = useState<string | null>(() => (key ? cache.get(key) ?? null : null))

  useEffect(() => {
    if (!key) {
      setIcon(null)
      return
    }

    const known = cache.get(key)
    if (known !== undefined) {
      setIcon(known)
      return
    }

    let live = true
    let pending = work.get(key)
    if (!pending) {
      pending = load(key)
        .catch(() => null)
        .then((value) => {
          cache.set(key, value)
          work.delete(key)
          return value
        })
      work.set(key, pending)
    }

    void pending.then((value) => {
      if (live) setIcon(value)
    })

    return () => {
      live = false
    }
  }, [key, cache, work, load])

  return icon
}

const loadFileIcon = (extension: string): Promise<string | null> =>
  window.api.fileIcon(extension)

const loadSiteIcon = (origin: string): Promise<string | null> => window.api.siteIcon(origin)

/** The icon Windows shows for this kind of file, or null while unknown. */
export function useFileIcon(filename: string): string | null {
  return useRemembered(extensionOf(filename) || null, fileIcons, fileWork, loadFileIcon)
}

const loadThumbnail = (url: string): Promise<string | null> => window.api.thumbnail(url)

/**
 * A video's poster image, or null while it is still being fetched - and null
 * for good if it could not be. Same data-URL round trip as the icons above, and
 * for the same reason: the CSP does not let a window fetch `i.ytimg.com` itself.
 *
 * The module-scope cache matters more here than for icons. A playlist of four
 * hundred rows scrolls in and out of view repeatedly, and without this every
 * pass would be four hundred fresh IPC calls for images main already holds.
 */
export function useThumbnail(url: string | null | undefined): string | null {
  return useRemembered(url || null, thumbnails, thumbnailWork, loadThumbnail)
}

/** The favicon of the site a download came from, keyed by origin. */
export function useSiteIcon(url: string | null | undefined): string | null {
  let origin: string | null = null
  try {
    if (url) {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin
    }
  } catch {
    origin = null
  }

  return useRemembered(origin, siteIcons, siteWork, loadSiteIcon)
}
