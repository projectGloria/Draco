/**
 * Reading yt-dlp's running commentary while it tries a browser's cookies.
 *
 * The Options panel that drives this exists because "borrow cookies from" was a
 * dropdown that never said anything back. Picking Firefox either fixed YouTube
 * or did not, minutes later, in a different window, as a download failure whose
 * message was about PO tokens. Everything here turns that into something with a
 * progress bar and a verdict.
 *
 * Pure, Electron-free and reached by relative specifier so it can be tested
 * without a browser profile or a network: the caller supplies the lines.
 */

import type { CookieCheckProgress, CookieCheckResult } from '../shared/types.ts'
import { tierFor, tierLabel } from './youtube-ladder.ts'

export type { CookieCheckProgress, CookieCheckResult }

/**
 * The stage one line of yt-dlp output represents, or null for a line that is
 * not about progress.
 *
 * Matching on prose is not something to do lightly, and it is only acceptable
 * here because nothing depends on it: a line that stops matching costs the bar
 * one step, never the result. The verdict is read from the JSON.
 */
export function progressFor(line: string, browser: string): CookieCheckProgress | null {
  const text = line.trim()
  if (!text) return null

  const extracted = /^Extracted (\d+) cookies?/i.exec(text)
  if (extracted) {
    return {
      stage: 'cookies',
      percent: 35,
      message: `Read ${extracted[1]} cookies from ${browser}`
    }
  }
  if (/^Extracting cookies from/i.test(text)) {
    return { stage: 'cookies', percent: 15, message: `Opening ${browser}'s cookie database` }
  }
  if (/Extracting URL:/i.test(text)) {
    return { stage: 'contacting', percent: 45, message: 'Asking YouTube about a test video' }
  }
  if (/Downloading webpage/i.test(text)) {
    return { stage: 'contacting', percent: 55, message: 'Loading the watch page' }
  }
  if (/Downloading player /i.test(text)) {
    return { stage: 'player', percent: 70, message: "Fetching YouTube's player" }
  }
  if (/Solving JS challenges/i.test(text)) {
    return { stage: 'player', percent: 80, message: "Solving YouTube's player challenge" }
  }
  if (/player API JSON/i.test(text)) {
    return { stage: 'formats', percent: 88, message: 'Reading the list of available qualities' }
  }
  return null
}

/** yt-dlp may use a downgraded client even with a valid signed-in session. */
export function looksDowngraded(lines: readonly string[]): boolean {
  return lines.some((line) => /downgraded player/i.test(line))
}

/** The cookie count yt-dlp reported, or null when no line carried one. */
export function cookiesReadFrom(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = /^Extracted (\d+) cookies?/i.exec(line.trim())
    if (match) return Number(match[1])
  }
  return null
}

/**
 * The verdict, from what the run produced.
 *
 * A 360p ladder says what yt-dlp can fetch with this client and session. It
 * does not prove the browser is signed out; valid cookies can also trigger a
 * YouTube client that exposes only itag 18.
 */
const THRESHOLD = 360

export function verdictFor(input: {
  browser: string
  cookiesRead: number | null
  downgraded: boolean
  /** Heights of every fetchable video format the test produced. */
  heights: readonly number[]
  anonymousHeights?: readonly number[]
  /** The error the run failed with, when it failed outright. */
  error?: string | null
}): CookieCheckResult {
  const tiers = [...new Set(
    input.heights
      .map((height) => tierFor(height))
      .filter((tier): tier is number => tier !== null)
  )].sort((a, b) => b - a)

  const publicTiers = [...new Set(
    (input.anonymousHeights ?? [])
      .map((height) => tierFor(height))
      .filter((tier): tier is number => tier !== null)
  )].sort((a, b) => b - a)
  const usedPublicFallback = (publicTiers[0] ?? 0) > (tiers[0] ?? 0)
  const selectedTiers = usedPublicFallback ? publicTiers : tiers
  const offered = selectedTiers.map((tier) => tierLabel(tier, null))
  const best = selectedTiers[0] ?? null
  const ok = best !== null && best > THRESHOLD

  const base: Omit<CookieCheckResult, 'cause' | 'fix'> = {
    browser: input.browser,
    ok,
    usedPublicFallback,
    cookiesRead: input.cookiesRead,
    downgraded: input.downgraded,
    bestQuality: best === null ? null : tierLabel(best, null),
    offered
  }

  if (input.error) {
    return { ...base, ok: false, ...causeForError(input.error, input.browser) }
  }

  if (usedPublicFallback && ok) {
    return {
      ...base,
      cause: `${input.browser}'s cookies were read, but this YouTube client exposed fewer downloadable formats with them.`,
      fix: 'Draco will use the public formats for public videos and keep the browser session for videos that require it.'
    }
  }

  if (ok) return { ...base, cause: null, fix: null }

  if (input.cookiesRead === 0 || input.cookiesRead === null) {
    return {
      ...base,
      cause: `No cookies were read from ${input.browser}.`,
      fix: `Sign in to YouTube in ${input.browser} at least once, then run this check again.`
    }
  }

  if (best === null) {
    return {
      ...base,
      cause: 'YouTube returned no downloadable formats at all for the test video.',
      fix: `Make sure you are signed in to YouTube in ${input.browser}, then update yt-dlp from Options → General.`
    }
  }

  return {
    ...base,
    cause:
      `${input.browser}'s cookies were read, but this yt-dlp lookup exposed only ${best}` +
      `${input.downgraded ? ' through a downgraded YouTube client' : ''}. This does not mean the browser is signed out.`,
    fix:
      'Draco will check public formats as well. Account-only videos may still need a working authenticated YouTube extractor.'
  }
}

function causeForError(error: string, browser: string): { cause: string; fix: string } {
  if (/could not copy|permission denied|database is locked/i.test(error)) {
    return {
      cause: `${browser} is holding its cookie database open.`,
      fix: `Close ${browser} completely - including any background instance in the tray - and run this check again.`
    }
  }
  if (/failed to decrypt|unable to get key|dpapi/i.test(error)) {
    return {
      cause: `${browser} stores its cookies in a form yt-dlp cannot decrypt on this machine.`,
      fix: 'Pick a different browser here, or use Firefox, whose cookie store needs no decryption key.'
    }
  }
  if (/could not find.*cookies|no such file/i.test(error)) {
    return {
      cause: `No ${browser} profile with cookies was found.`,
      fix: `Check that ${browser} is installed and has been used at least once, or pick a different browser.`
    }
  }
  if (/sign in|not a bot|captcha/i.test(error)) {
    return {
      cause: 'YouTube asked the request to prove it was not a bot.',
      fix: `Sign in to YouTube in ${browser}, play a video once, then close ${browser} and run this check again.`
    }
  }
  return {
    cause: error.slice(0, 400),
    fix: 'Try a different browser here, or update yt-dlp from Options → General.'
  }
}

/**
 * Keeps a progress bar from going backwards.
 *
 * yt-dlp's lines are not strictly ordered - the cookie lines come from a
 * different subsystem than the extractor's, and a retry re-prints earlier
 * stages - so a bar driven straight off `progressFor` visibly jumps back.
 */
export function advance(
  current: CookieCheckProgress,
  next: CookieCheckProgress
): CookieCheckProgress {
  return next.percent >= current.percent ? next : current
}
