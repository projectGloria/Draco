/** Pure clipboard text validation, kept separate from Electron for unit tests. */
export function looksDownloadable(text: string): boolean {
  if (!text || text.length > 2048 || /\s/.test(text)) return false

  try {
    const url = new URL(text)
    if (url.protocol === 'magnet:') return true
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (isYouTubeVideo(url)) return true
    if (isSupportedMediaPageUrl(url.href)) return true

    // A normal page can hide the real media URL behind its player. Every web
    // URL enters the inbox; preparation probes files directly and asks the
    // media extractor to inspect HTML pages in the background.
    return true
  } catch {
    return /^[0-9a-fA-F]{40}$/.test(text)
  }
}

function isYouTubeVideo(url: URL): boolean {
  if (url.protocol !== 'https:') return false
  if (/(^|\.)youtu\.be$/i.test(url.hostname)) return url.pathname.split('/').filter(Boolean).length > 0
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return false
  if (url.pathname === '/watch') return Boolean(url.searchParams.get('v'))
  return /^\/(shorts|embed|live)\/[^/?#]+/i.test(url.pathname)
}
import { isSupportedMediaPageUrl } from './media-url.ts'
