import { ellipsize, pad, richGlyphs, RICH_GLYPHS, SAFE_GLYPHS, width, type Glyphs } from './text.ts'

/**
 * One download as the screen shows it - the same shape whether the bytes come
 * from Draco's own engine or from yt-dlp, so both paths draw the same card.
 *
 * Structured on purpose: the old pipeline pre-rendered strings and the UI then
 * regex-patched bars into them. Numbers in, layout decided at draw time, means
 * the bar can stretch to whatever width the terminal has.
 */
export interface Transfer {
  id: string
  title: string
  /** waiting: queued · preparing: before any bytes · downloading · finishing: merge/embed */
  phase: 'waiting' | 'preparing' | 'downloading' | 'finishing'
  /** What is happening right now in plain words: "Video", "Merging video and audio". */
  step: string | null
  /** 1-based part of a multi-part download (video, then audio). */
  part: number | null
  parts: number | null
  received: number | null
  total: number | null
  /** Bytes per second. */
  speed: number | null
  /** Seconds left. */
  eta: number | null
}

export function transfer(id: string, title: string, phase: Transfer['phase'], extra: Partial<Transfer> = {}): Transfer {
  return { id, title, phase, step: null, part: null, parts: null, received: null, total: null, speed: null, eta: null, ...extra }
}

/**
 * Colour hooks (identity functions when colour is off, so layout code never
 * branches on it) plus the symbol set the console's font can draw.
 */
export interface Painter {
  g: Glyphs
  accent: (s: string) => string
  dim: (s: string) => string
  faint: (s: string) => string
  track: (s: string) => string
  strong: (s: string) => string
  good: (s: string) => string
  bad: (s: string) => string
}

export function painter(color: boolean, rich: boolean = richGlyphs()): Painter {
  const paint = (code: string) => (s: string): string => (color && s ? `\x1b[${code}m${s}\x1b[0m` : s)
  return {
    g: rich ? RICH_GLYPHS : SAFE_GLYPHS,
    accent: paint('38;5;214'),
    dim: paint('38;5;245'),
    faint: paint('38;5;240'),
    track: paint('38;5;237'),
    strong: paint('1;97'),
    good: paint('38;5;114'),
    bad: paint('38;5;203')
  }
}

/* ------------------------------------------------------------------ */
/* Human units                                                          */
/* ------------------------------------------------------------------ */

/** "58.8 MB". Binary multiples with the familiar labels, as Explorer shows them. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** "8s", "2m 08s", "1h 04m": reads at a glance, unlike 00:02:08. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

export function fractionOf(t: Transfer): number | null {
  if (t.phase !== 'downloading' || !t.total || t.received === null) return null
  return Math.max(0, Math.min(1, t.received / t.total))
}

/* ------------------------------------------------------------------ */
/* The bar                                                              */
/* ------------------------------------------------------------------ */

// Eighth blocks give the bar sub-cell precision, so it creeps smoothly instead
// of jumping a whole column at a time on a narrow terminal.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/**
 * A bar exactly `size` columns wide. `null` is indeterminate: a short glow
 * sweeping back and forth, driven by the wall clock so every redraw advances
 * it without the caller keeping animation state.
 */
export function progressBar(fraction: number | null, size: number, p: Painter, now = Date.now()): string {
  size = Math.max(1, size)
  if (fraction === null || !Number.isFinite(fraction)) {
    const glow = Math.max(1, Math.min(8, Math.floor(size / 5)))
    // `span` is how far the glow can travel; 0 on a bar no wider than the glow.
    const span = size - glow
    const step = span > 0 ? Math.floor(now / 90) % (span * 2) : 0
    const at = step < span ? step : span * 2 - step
    return p.track('░'.repeat(at)) + p.accent('█'.repeat(glow)) + p.track('░'.repeat(Math.max(0, size - at - glow)))
  }
  const exact = Math.max(0, Math.min(1, fraction)) * size
  const full = Math.floor(exact)
  const partial = full < size && p.g.smooth ? EIGHTHS[Math.floor((exact - full) * 8)] : ''
  const track = size - full - (partial ? 1 : 0)
  return p.accent('█'.repeat(full) + partial) + p.track('░'.repeat(track))
}

function percentLabel(fraction: number): string {
  const value = fraction * 100
  return `${value < 10 && value > 0 ? value.toFixed(1) : Math.floor(value)}%`
}

/**
 * A download as three lines, every one exactly fitted to `columns`:
 *
 *   ↓ The International Archives: Gyro Diffusal          Video · 1 of 2
 *   ██████████████████▌░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  34%
 *   20.1 MB of 58.8 MB · 4.5 MB/s · 8s left
 */
export function transferLines(t: Transfer, columns: number, p: Painter, now = Date.now()): string[] {
  const w = Math.max(8, columns)
  const icon = t.phase === 'finishing' ? p.g.finish : t.phase === 'waiting' ? p.g.wait : p.g.down
  const where = [t.step, t.parts && t.parts > 1 && t.part ? `${t.part} of ${t.parts}` : null].filter(Boolean).join(' · ')
  const tag = where || { waiting: 'Waiting', preparing: 'Preparing', downloading: 'Downloading', finishing: 'Finishing' }[t.phase]
  const tagWidth = width(tag) < w / 3 ? width(tag) : 0
  const titleWidth = Math.max(1, w - 2 - (tagWidth ? tagWidth + 2 : 0))
  const head = p.accent(icon) + ' ' + p.strong(pad(ellipsize(t.title, titleWidth), titleWidth)) +
    (tagWidth ? '  ' + p.dim(tag) : '')

  const fraction = fractionOf(t)
  const label = fraction === null ? '' : percentLabel(fraction)
  const barWidth = Math.max(1, w - 6)
  const bar = progressBar(fraction, barWidth, p, now) + ' ' + p.strong(label.padStart(5))

  let detail: string
  if (t.phase === 'downloading') {
    const amount = t.total ? `${formatBytes(t.received)} of ${formatBytes(t.total)}` : t.received ? `${formatBytes(t.received)} so far` : 'Starting'
    const speed = t.speed ? `${formatBytes(t.speed)}/s` : null
    const left = formatDuration(t.eta)
    detail = [amount, speed, left ? `${left} left` : t.received ? 'estimating time…' : null].filter(Boolean).join(' · ')
  } else if (t.phase === 'finishing') detail = `${t.step ?? 'Finishing your file'}…`
  else if (t.phase === 'waiting') detail = 'Waiting for a free slot…'
  else detail = t.step ? `${t.step}…` : 'Getting ready…'
  return [head, bar, p.dim(ellipsize(detail, w))]
}

/* ------------------------------------------------------------------ */
/* Words people understand                                               */
/* ------------------------------------------------------------------ */

/** yt-dlp postprocessor keys (`pp_key()`) in plain words. */
const STEPS: Record<string, string> = {
  Merger: 'Merging video and audio',
  Metadata: 'Saving title and chapters',
  EmbedThumbnail: 'Adding cover art',
  ThumbnailsConvertor: 'Preparing cover art',
  EmbedSubtitle: 'Adding subtitles',
  SubtitlesConvertor: 'Preparing subtitles',
  ExtractAudio: 'Extracting audio',
  VideoRemuxer: 'Changing the container',
  VideoConvertor: 'Converting video',
  ModifyChapters: 'Updating chapters',
  SponsorBlock: 'Checking SponsorBlock',
  SplitChapters: 'Splitting chapters',
  MoveFiles: 'Moving into place'
}

export function stepName(postprocessor: string): string {
  if (STEPS[postprocessor]) return STEPS[postprocessor]
  if (postprocessor.startsWith('Fixup')) return 'Tidying up the file'
  return 'Finishing your file'
}

/**
 * Turns an error from yt-dlp, the engine, or the OS into a sentence that says
 * what to do. Unknown errors keep their text, minus the bits only a developer
 * reads (`[youtube] dQw4w9WgXcQ:` prefixes, "please report this issue" tails).
 */
export function friendlyError(raw: string): string {
  const text = raw.replace(/^(?:ERROR|error):\s*/, '').replace(/^\[[\w:.-]+\]\s*(?:[\w-]+:\s*)?/, '').trim()
  const rules: Array<[RegExp, string]> = [
    [/confirm your age|age[- ]restricted|inappropriate for some users/i, 'This video is age-restricted. Add --cookies-from-browser firefox to draco.cfg to use your signed-in browser.'],
    [/sign in to confirm|not a bot|login required|requires authentication|use --cookies/i, 'The site wants you signed in. Add --cookies-from-browser firefox (or your browser) to draco.cfg.'],
    [/could not (?:copy|find|decrypt).*cookie|cookies? database|failed to (?:load|decrypt) cookies/i, 'Could not read your browser cookies. Close the browser and try again.'],
    [/private video/i, 'This video is private.'],
    [/members[- ]only|join this channel/i, 'This video is for channel members only.'],
    [/premieres in|live event will begin|this live event/i, 'This video has not started yet.'],
    [/video unavailable|has been removed|no longer available|not available in your country|blocked it in your country/i, 'This video is not available - removed, private, or blocked where you are.'],
    [/unsupported url|no video formats found|unable to extract/i, 'Draco could not find anything to download at this link.'],
    [/requested format (?:is )?not available|format not available/i, 'That quality is not available for this video. Choose another one in F2 Settings.'],
    [/HTTP Error 404|\b404\b/i, 'Nothing was found at this link (404).'],
    [/HTTP Error 403|\b403\b|forbidden/i, 'The site refused the download (403). Try again in a moment.'],
    [/HTTP Error 429|too many requests/i, 'The site is limiting downloads right now. Wait a few minutes and try again.'],
    [/ENOTFOUND|EAI_AGAIN|getaddrinfo|name or service not known|nodename nor servname/i, 'Could not reach the site. Check your internet connection.'],
    [/ETIMEDOUT|timed out|ECONNRESET|ECONNREFUSED|connection (?:reset|refused|aborted)/i, 'The connection dropped. Check your internet connection and try again.'],
    [/ENOSPC|no space left|not enough (?:disk )?space/i, 'Your disk is full. Free up some space and try again.'],
    [/EACCES|EPERM|permission denied|access is denied/i, 'Draco cannot save to this folder. Choose another one in F2 Settings.'],
    [/ffmpeg (?:is )?not (?:found|installed)/i, 'A required component (ffmpeg) is missing. Reinstall Draco.']
  ]
  for (const [pattern, message] of rules) if (pattern.test(text)) return message
  return text.replace(/;?\s*please report this issue.*$/i, '').replace(/\s*\(caused by .*\)$/i, '').trim() || 'Something went wrong.'
}
