import { clipboard } from 'electron'
import { looksDownloadable } from './clipboard-url.ts'

export { looksDownloadable } from './clipboard-url.ts'

/**
 * Clipboard inbox monitor: copied links are handed to the background preparer
 * without interrupting the user.
 *
 * There is no clipboard-change event on Windows that Electron exposes, so this
 * polls. A second is well under the time it takes anyone to switch windows and
 * costs nothing measurable.
 */

const POLL_MS = 1000

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
