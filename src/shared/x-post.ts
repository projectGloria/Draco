const X_HOST_PATTERN = /^(?:www\.|mobile\.)?(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com)$/i
const X_PATH_PATTERN = /^\/(?:([A-Za-z0-9_]{1,15}|i)(?:\/web)?)\/status\/(\d+)(?:\/|$)/i

/** Only a single X/Twitter status can be resolved as one post. */
export function xPostUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!X_HOST_PATTERN.test(url.hostname)) return null
    const match = X_PATH_PATTERN.exec(url.pathname)
    if (!match) return null
    return `https://x.com/${match[1]}/status/${match[2]}`
  } catch {
    return null
  }
}

export function xStatusId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!X_HOST_PATTERN.test(url.hostname)) return null
    const match = X_PATH_PATTERN.exec(url.pathname)
    return match ? match[2] : null
  } catch {
    return null
  }
}

export function isXPage(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    return X_HOST_PATTERN.test(new URL(value).hostname)
  } catch {
    return false
  }
}

