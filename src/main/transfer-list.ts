import type { DownloadTask, NewDownload } from '@shared/types'

/**
 * Taking a download list somewhere else.
 *
 * Everything Draco knows lives under `%APPDATA%/Draco`, which is a fine answer
 * for one machine and no answer at all for two. Moving to a new PC, or keeping
 * a list of things to fetch later, previously meant copying URLs out of the
 * window by hand.
 *
 * Two formats, because they answer different questions. A `.txt` of URLs is
 * what every other tool in the world reads and writes, and is what a list
 * *from* somewhere else looks like. Draco's own `.json` additionally carries
 * the name, folder, category, queue and description - the decisions that were
 * made about each download, which are the part worth not making twice.
 */

export const TRANSFER_VERSION = 1

export interface TransferFile {
  format: 'draco-downloads'
  version: number
  exportedAt: number
  items: TransferItem[]
}

export interface TransferItem {
  url: string
  filename?: string
  dir?: string
  categoryId?: string | null
  queueId?: string | null
  description?: string
  /** Recorded so an import can say what was already finished elsewhere. */
  status?: DownloadTask['status']
  sourceUrl?: string
}

/** Downloads as Draco's own format: every decision made about them, kept. */
export function buildTransferFile(tasks: readonly DownloadTask[]): TransferFile {
  return {
    format: 'draco-downloads',
    version: TRANSFER_VERSION,
    exportedAt: Date.now(),
    items: tasks.map((task) => ({
      // A YouTube CDN URL carries a short-lived signature. Export the stable
      // watch page instead of writing that token into a portable plain file.
      url: task.youtube?.pageUrl ?? task.url,
      filename: task.filename,
      dir: task.dir,
      categoryId: task.categoryId,
      queueId: task.queueId,
      description: task.description || undefined,
      status: task.status,
      // A YouTube task's `url` is a signed CDN address that expires within
      // hours; the page it came from is what can still be resolved tomorrow.
      sourceUrl: task.youtube?.pageUrl ?? task.sourceUrl
    }))
  }
}

/** One URL per line, which is what everything else reads. */
export function buildUrlList(tasks: readonly DownloadTask[]): string {
  const lines = tasks.map((task) => task.youtube?.pageUrl ?? task.url)
  return [...new Set(lines)].join('\r\n') + '\r\n'
}

/**
 * Reads either format.
 *
 * A file that is not Draco's JSON is read as a URL list, because that is what
 * an unrecognised text file full of links almost always is. Comment lines and
 * anything that is not an address are skipped rather than failing the import -
 * a list pasted together by hand is exactly the input this exists for.
 */
export function parseTransferFile(text: string): NewDownload[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as TransferFile
      if (parsed?.format === 'draco-downloads' && Array.isArray(parsed.items)) {
        return parsed.items.flatMap(itemToDownload)
      }
    } catch {
      // Not our JSON after all. Fall through and read it as a list of links -
      // refusing the whole file over a stray brace would be unhelpful.
    }
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    // `#` and `;` are how every hand-written list marks a comment.
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'))
    .flatMap((line) => {
      const url = firstUrlOf(line)
      return url ? [{ url }] : []
    })
}

function itemToDownload(raw: unknown): NewDownload[] {
  const item = raw as TransferItem | null
  if (!item || typeof item !== 'object') return []

  // Prefer the exported download URL; sourceUrl may be an ordinary article.
  const url = pickUrl(item)
  if (!url) return []

  return [{
    url,
    filename: typeof item.filename === 'string' ? item.filename.slice(0, 300) : undefined,
    dir: typeof item.dir === 'string' ? item.dir : undefined,
    categoryId: typeof item.categoryId === 'string' ? item.categoryId : null,
    queueId: typeof item.queueId === 'string' ? item.queueId : null,
    description: typeof item.description === 'string' ? item.description.slice(0, 500) : undefined,
    // Imported rows are not started: an import is a list of intentions, and
    // fifty downloads beginning at once is not what dropping a file in means.
    autoStart: false,
    suppressProgressWindow: true
  }]
}

function pickUrl(item: TransferItem): string | null {
  const candidates = [item.url, item.sourceUrl]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isTransferableUrl(candidate)) return candidate
  }
  return null
}

/** The line may be `url` or `url  some trailing note`. */
function firstUrlOf(line: string): string | null {
  const token = line.split(/\s+/)[0]
  return token && isTransferableUrl(token) ? token : null
}

function isTransferableUrl(value: string): boolean {
  if (value.length > 4000) return false
  if (/^magnet:\?/i.test(value)) return true
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
