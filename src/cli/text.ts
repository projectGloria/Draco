/**
 * Terminal text measuring, shared by the full-screen UI and the line-mode
 * progress output. Everything that reaches the screen from outside (titles,
 * paths, yt-dlp output) goes through `cleanText` first, so a title carrying
 * escape sequences can neither move the cursor nor clear the screen.
 */

export function cleanText(value: string): string {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
}

/** Columns one code point occupies: 0 for combining marks, 2 for wide CJK/emoji. */
export function cellWidth(ch: string): number {
  const n = ch.codePointAt(0) ?? 0
  if (/\p{Mark}/u.test(ch)) return 0
  return (n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a ||
    (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) ||
    (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe10 && n <= 0xfe6f) ||
    (n >= 0xff00 && n <= 0xff60) || n >= 0x1f000)) ? 2 : 1
}

export function width(text: string): number { return Array.from(cleanText(text)).reduce((n, c) => n + cellWidth(c), 0) }

/** The longest prefix that fits in `limit` columns. */
export function clip(text: string, limit: number): string {
  let result = '', size = 0
  for (const ch of cleanText(text)) {
    size += cellWidth(ch)
    if (size > limit) break
    result += ch
  }
  return result
}

/** Like `clip`, but marks the cut with an ellipsis so a truncated title reads as one. */
export function ellipsize(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (width(text) <= limit) return cleanText(text)
  return clip(text, limit - 1) + '…'
}

/** `text` padded with spaces to exactly `size` columns (clipped first if longer). */
export function pad(text: string, size: number): string {
  const fitted = clip(text, size)
  return fitted + ' '.repeat(Math.max(0, size - width(fitted)))
}

/**
 * Word-wraps to `size` columns, at most `limit` lines (the last one ellipsized
 * if text remains). Words longer than a line - URLs, paths - are hard-split.
 */
export function wrap(text: string, size: number, limit = Infinity): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of cleanText(text).split(/ +/)) {
    let rest = word
    while (rest) {
      const joined = line ? `${line} ${rest}` : rest
      if (width(joined) <= size) { line = joined; rest = ''; continue }
      if (line) { lines.push(line); line = ''; continue }
      const head = clip(rest, size) || Array.from(rest)[0]
      lines.push(head)
      rest = rest.slice(head.length)
    }
  }
  if (line) lines.push(line)
  if (lines.length <= limit) return lines
  const kept = lines.slice(0, limit)
  kept[limit - 1] = ellipsize(kept[limit - 1] + ' ' + lines[limit], size)
  return kept
}

/**
 * Symbols that the console's font can actually draw. Windows Terminal ships
 * Cascadia, which has the nice ones; classic conhost uses Consolas, which has
 * no ✓, ❯, braille spinner or eighth blocks, and conhost has no font fallback,
 * so those would show as boxes there.
 */
export interface Glyphs {
  ok: string; fail: string; info: string; prompt: string; down: string; finish: string; wait: string
  spinner: string; smooth: boolean
}

export const RICH_GLYPHS: Glyphs = { ok: '✓', fail: '×', info: '•', prompt: '❯', down: '↓', finish: '◆', wait: '…', spinner: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', smooth: true }
export const SAFE_GLYPHS: Glyphs = { ok: '●', fail: '×', info: '•', prompt: '»', down: '↓', finish: '•', wait: '…', spinner: '-\\|/', smooth: false }

export function richGlyphs(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  return platform !== 'win32' || Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuPID || env.ALACRITTY_WINDOW_ID || env.WEZTERM_PANE)
}
