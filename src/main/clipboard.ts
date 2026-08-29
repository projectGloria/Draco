import { clipboard } from 'electron'

/**
 * IDM's clipboard monitor: copy a download link anywhere on the machine and the
 * Save As dialog comes up already filled in.
 *
 * There is no clipboard-change event on Windows that Electron exposes, so this
 * polls. A second is well under the time it takes anyone to switch windows and
 * costs nothing measurable.
 */

const POLL_MS = 1000

/**
 * Extensions that mean "a page", not "a file". Offering to download every link
 * the user copies would make the feature unusable, so a URL has to look like it
 * points at a file before Draco says anything.
 */
const PAGE_EXTENSIONS = new Set([
  'htm',
  'html',
  'php',
  'asp',
  'aspx',
  'jsp',
  'jspx',
  'cgi',
  'json',
  'xml'
])

export interface ClipboardWatcherDeps {
  /** Re-read every tick: the user can turn this off while it is running. */
  enabled(): boolean
  onUrl(url: string): void
}

export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null
  private lastSeen = ''
  private deps: ClipboardWatcherDeps

  constructor(deps: ClipboardWatcherDeps) {
    this.deps = deps
    // Seeded so whatever is already on the clipboard at launch does not read as
    // something the user just copied.
    this.lastSeen = safeRead()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    const text = safeRead()
    if (text === this.lastSeen) return
    this.lastSeen = text

    if (!this.deps.enabled()) return
    if (looksDownloadable(text)) this.deps.onUrl(text)
  }
}

function safeRead(): string {
  try {
    return clipboard.readText().trim()
  } catch {
    return ''
  }
}

export function looksDownloadable(text: string): boolean {
  // Anything with whitespace is a copied sentence, not an address.
  if (!text || text.length > 2048 || /\s/.test(text)) return false

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const match = /\.([a-z0-9]{1,5})$/i.exec(url.pathname)
  if (!match) return false

  return !PAGE_EXTENSIONS.has(match[1].toLowerCase())
}
