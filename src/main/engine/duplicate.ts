import type { DownloadTask } from '../../shared/types.ts'

/**
 * "Haven't I already got this?"
 *
 * Nothing in Draco used to ask. Pasting a link a second time started a second
 * download beside the first, and the only sign was a file named `thing (1).iso`
 * appearing next to `thing.iso` some minutes later.
 *
 * This never blocks an add: a duplicate is a thing worth *saying*, not a thing
 * worth refusing. Re-downloading is a legitimate request - the file changed, the
 * first copy was deleted, the first attempt was corrupt - and a downloader that
 * argues about it is worse than one that stays quiet.
 */

export type DuplicateReason = 'url' | 'destination'

export interface DuplicateMatch {
  taskId: string
  reason: DuplicateReason
  /** The existing task's state, so the caller can word it properly. */
  status: DownloadTask['status']
  filename: string
  dir: string
  completedAt: number | null
}

/**
 * A comparable form of a URL.
 *
 * The fragment never reaches the server. The host is case-insensitive and the
 * default port is implied. Everything else - including the query - is kept,
 * because for a great many download endpoints the query *is* the identity of
 * the file, and dropping it would report two different downloads as one.
 */
export function comparableUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol === 'magnet:') {
      // A magnet's identity is its info hash; trackers and display names vary
      // between copies of the same link.
      const hash = /xt=urn:btih:([a-z0-9]+)/i.exec(url.href)?.[1]
      return hash ? `magnet:${hash.toLowerCase()}` : url.href.toLowerCase()
    }

    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = ''
    }
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Whether these two URLs stand for the same download.
 *
 * A signed media URL is deliberately *not* compared on its query: the signature
 * and its expiry change on every lookup, so two links to the same YouTube video
 * an hour apart share nothing but the path. Those are matched by the stable
 * page identity instead - see `findDuplicate`.
 */
export function sameResource(left: string, right: string): boolean {
  const a = comparableUrl(left)
  const b = comparableUrl(right)
  return a !== null && a === b
}

/**
 * An existing task this URL would repeat, or null.
 *
 * Three identities are checked, in the order they are worth reporting:
 * the stable page identity of a signed media URL, the URL itself, and the file
 * the download would land on. The last one catches the case the first two
 * cannot - the same file offered from a different address, or an entry the user
 * renamed.
 */
export function findDuplicate(
  tasks: readonly DownloadTask[],
  candidate: { url: string; pageUrl?: string | null; dir?: string; filename?: string },
  ignoreTaskId?: string
): DuplicateMatch | null {
  const comparable = comparableUrl(candidate.url)
  const pageUrl = candidate.pageUrl ? comparableUrl(candidate.pageUrl) : null

  let destinationMatch: DuplicateMatch | null = null

  for (const task of tasks) {
    if (task.id === ignoreTaskId) continue

    // The page a signed URL came from, which outlives the signature.
    if (pageUrl && task.youtube?.pageUrl && comparableUrl(task.youtube.pageUrl) === pageUrl) {
      return describe(task, 'url')
    }

    if (comparable && comparableUrl(task.url) === comparable) {
      return describe(task, 'url')
    }

    // Kept rather than returned at once: a URL match is the more meaningful
    // answer, and there may still be one later in the list.
    if (
      !destinationMatch &&
      candidate.filename &&
      candidate.dir &&
      task.status === 'done' &&
      task.filename === candidate.filename &&
      task.dir.toLowerCase() === candidate.dir.toLowerCase()
    ) {
      destinationMatch = describe(task, 'destination')
    }
  }

  return destinationMatch
}

function describe(task: DownloadTask, reason: DuplicateReason): DuplicateMatch {
  return {
    taskId: task.id,
    reason,
    status: task.status,
    filename: task.filename,
    dir: task.dir,
    completedAt: task.completedAt
  }
}
