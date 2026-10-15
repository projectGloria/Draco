import { isSupportedYouTubeUrl } from './youtube-url.ts'

/** Turns terse extractor diagnostics into accurate, actionable UI text. */
export function normalizeYtDlpError(message: string, url: string): string {
  const youtube = isSupportedYouTubeUrl(url)
  if (/no supported javascript runtime/i.test(message)) {
    if (!youtube) return message
    return (
      'YouTube needs a supported JavaScript runtime for extraction. ' +
      'Install Deno (recommended) and make sure deno.exe is on PATH, then retry.'
    )
  }

  if (/po token|proof of origin|403|forbidden/i.test(message)) {
    if (!youtube) {
      return (
        'The site rejected media extraction (HTTP 403). Start playback in your browser, then use Draco’s ' +
        'video Download button so the active session and stream URL are captured.'
      )
    }
    return (
      'YouTube rejected the extractor request (PO token / HTTP 403). ' +
      'This video or client currently needs a browser token or a newer yt-dlp setup.'
    )
  }

  /*
   * An extractor that threw where it meant to read a field.
   *
   * `KeyError('INNERTUBE_CONTEXT')` is the one seen in practice, and the
   * verbatim text - "please report this issue on GitHub … confirm you are on
   * the latest version" - sends the user somewhere that cannot help them,
   * because it is usually not a yt-dlp bug at all. It is what a YouTube client
   * yt-dlp could not fully initialise looks like from the inside, and the same
   * signed-out session that caps the ladder at 360p is what causes it.
   */
  if (/an extractor error has occurred|keyerror\(/i.test(message)) {
    if (!youtube) return message
    return (
      'YouTube would not give yt-dlp a usable player for this video. ' +
      'This almost always means the request was treated as signed out. ' +
      'Fix: open Options → Cookies, pick the browser you watch YouTube in, and make sure ' +
      'you are signed in to YouTube there. If it keeps happening, update yt-dlp from Options → General.'
    )
  }

  if (/sign in|bot|captcha|confirm you('re| are) not a robot/i.test(message)) {
    if (!youtube) return 'The site requires an authenticated or verified browser session before media can be inspected.'
    return (
      'YouTube requires a browser session or verification for this video. ' +
      'Draco received the page cookies, but YouTube still rejected the extractor.'
    )
  }

  return message
}

/**
 * Why the quality that was picked is not what would be downloaded, and what to
 * do about it.
 *
 * The failure this describes used to be silent. `substituteVideo` never gives
 * up - it walks down the ladder until something fits - so a 2160p request
 * against a ladder holding only itag 18 succeeded, downloaded 360p, and wrote
 * it to a file the user had already been shown as `… 2160p.mp4`. The only
 * trace was one `WARN … substituting 18` line in the log.
 *
 * Pure and Electron-free so the wording can be tested; the caller supplies the
 * cookie setting rather than reading it here.
 */
export function describeQualityShortfall(input: {
  /** The rung the user chose, e.g. "4K" or "1080p". */
  wantedLabel: string
  /** Rungs the extractor actually offered, highest first. */
  offeredLabels: string[]
  /** The browser Draco is borrowing cookies from, or 'none'. */
  cookieBrowser: string
}): string {
  const offered = input.offeredLabels.length > 0
    ? input.offeredLabels.join(', ')
    : 'nothing it could download'

  const fix = input.cookieBrowser === 'none'
    ? 'Open Options → Cookies if this video requires a signed-in account.'
    : `Options → Cookies can compare ${input.cookieBrowser}'s session with the public formats. ` +
      'A limited authenticated client may need a newer yt-dlp or a YouTube PO token.'

  return (
    `YouTube offered only ${offered} for this video, so ${input.wantedLabel} could not be downloaded. ` +
    'Cause: YouTube did not give yt-dlp a higher directly downloadable format. ' +
    'This can happen even when the browser is signed in. ' +
    fix
  )
}
