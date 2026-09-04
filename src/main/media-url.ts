/** Media pages that Draco deliberately sends through yt-dlp instead of probing as files. */
export function isSupportedMediaPageUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false

    if (/(^|\.)soundcloud\.com$/i.test(url.hostname)) {
      const parts = url.pathname.split('/').filter(Boolean)
      return parts.length >= 2 && !['discover', 'search', 'you', 'stream'].includes(parts[0].toLowerCase())
    }

    if (/(^|\.)(suno\.com|suno\.ai)$/i.test(url.hostname)) {
      return /^\/(song|s)\/[^/?#]+/i.test(url.pathname)
    }

    return false
  } catch {
    return false
  }
}

export function isSunoUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && /(^|\.)(suno\.com|suno\.ai)$/i.test(url.hostname) &&
      /^\/(song|s)\/[^/?#]+/i.test(url.pathname)
  } catch {
    return false
  }
}
