/**
 * Letting yt-dlp borrow a browser's cookies.
 *
 * Draco already carries the browser's cookies for an ordinary download - the
 * extension captures them at the moment of the click. A page Draco resolves by
 * itself has no such moment: a members-only video, an age-gated one, anything
 * behind a login is simply "unavailable" to an anonymous extractor, however
 * plainly it plays in the browser next door.
 *
 * yt-dlp can read those cookies from the browser's own profile. The name of the
 * browser is the whole input, and it is checked against this list rather than
 * passed through, because it becomes an argument to a program: an unchecked
 * string here is a way to hand yt-dlp flags nobody asked for.
 */

export const COOKIE_BROWSERS = [
  'chrome',
  'edge',
  'brave',
  'firefox',
  'chromium',
  'opera',
  'vivaldi'
] as const

export type CookieBrowser = (typeof COOKIE_BROWSERS)[number]

/** 'none' is the default and the only way to send no cookies at all. */
export type CookieSource = CookieBrowser | 'none'

export function isCookieBrowser(value: unknown): value is CookieBrowser {
  return typeof value === 'string' && (COOKIE_BROWSERS as readonly string[]).includes(value)
}

/**
 * The arguments that make yt-dlp read a browser profile, or none.
 *
 * Nothing is guessed: an unknown name yields no arguments rather than a best
 * effort, so a setting written by hand into settings.json cannot turn into a
 * command-line flag.
 */
export function cookieArgs(source: unknown): string[] {
  return isCookieBrowser(source) ? ['--cookies-from-browser', source] : []
}

/**
 * Why a cookie read failed, in words that name the fix.
 *
 * Two of these are common enough to be worth recognising: Chromium locks its
 * cookie database while it is running on Windows, and its newer profiles seal
 * the key so that only the browser itself can decrypt them.
 */
export function explainCookieFailure(stderr: string, browser: CookieSource): string | null {
  if (browser === 'none') return null
  const text = stderr.toLowerCase()

  if (text.includes('could not copy') || text.includes('permission denied') || text.includes('database is locked')) {
    return `Draco could not read ${browser}'s cookies while it is running. Close ${browser} and try again.`
  }
  if (text.includes('failed to decrypt') || text.includes('unable to get key') || text.includes('dpapi')) {
    return `${browser} is storing its cookies in a form yt-dlp cannot decrypt on this machine. Try another browser in Options.`
  }
  if (text.includes('could not find') && text.includes('cookies')) {
    return `No ${browser} profile with cookies was found. Check the browser chosen in Options.`
  }
  return null
}
