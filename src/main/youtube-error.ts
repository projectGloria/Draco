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

  if (/sign in|bot|captcha|confirm you('re| are) not a robot/i.test(message)) {
    if (!youtube) return 'The site requires an authenticated or verified browser session before media can be inspected.'
    return (
      'YouTube requires a browser session or verification for this video. ' +
      'Draco received the page cookies, but YouTube still rejected the extractor.'
    )
  }

  return message
}
