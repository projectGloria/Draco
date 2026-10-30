import { formatLabel } from './preferences.ts'
import type { FormatSpec } from './args.ts'
import { painter, transferLines, type Painter, type Transfer } from './progress.ts'
import { saveDirLabel, type SaveDirSource } from './save-dir.ts'
import { iconPalette, iconPixels } from './terminal-icon.ts'
import { cleanText, clip, ellipsize, pad, width, wrap } from './text.ts'

// Re-exported: tests and older callers import the text helpers from here.
export { cleanText, cellWidth, clip, width } from './text.ts'

export interface Note { text: string; tone: 'info' | 'good' | 'bad' }

export interface TerminalView {
  version: string
  input: string
  cursor: number
  format: FormatSpec
  dir: string
  /** Why `dir` is the folder: shown beside it. */
  dirSource?: SaveDirSource
  /** Anything resolving, downloading, merging or waiting. */
  busy: boolean
  /** Finished events, newest last: saved files, errors, pauses. */
  notes: Note[]
  /** "Getting download details…" while nothing is transferring yet. */
  activity: string | null
  transfers: Transfer[]
  /** Waiting their turn, in order. */
  queue?: Array<{ id: string; title: string }>
  /** Selected row while editing the queue (↓ from an empty link box). */
  queueFocus?: number
  counts?: { transferring: number; finishing: number; waiting: number }
  paused?: boolean
  /** Last file saved this session, for F3/F4. */
  lastSaved?: string | null
  /** The draco.cfg in effect, if any. */
  config?: string | null
  panel?: { title: string; items: string[]; selected: number }
  editingDir?: boolean
  help?: boolean
}

const REVEAL = process.platform === 'win32' ? 'Show in Explorer' : 'Show in folder'

export const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['Enter', 'Download'],
  ['F1', 'Help'],
  ['F2', 'Settings'],
  ['F3', 'Open last file'],
  ['F4', REVEAL],
  ['F5', 'Retry / resume'],
  ['↑ ↓', 'Previous links'],
  ['Esc', 'Clear'],
  ['Ctrl+C', 'Pause / Quit']
]

/* ------------------------------------------------------------------ */
/* Brand                                                               */
/* ------------------------------------------------------------------ */

const ICON_RGB = iconPalette.map(hex => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';'))
export const ICON_COLUMNS = iconPixels[0].length
export const ICON_ROWS = iconPixels.length / 2
/** The shortcut box's height: one row per shortcut plus its two borders. The art is generated to match it. */
export const BOX_ROWS = SHORTCUTS.length + 2

/**
 * The icon in half-blocks: each cell is two vertically stacked pixels, the top
 * one as the foreground of "▀" and the bottom one as its background. That
 * gives square pixels at twice the vertical resolution of one-glyph-per-pixel
 * art, which is what makes a 30x30 dragon legible. Truecolor, because the fire
 * ramp collapses into three oranges in the 256-colour cube.
 */
export function iconRows(color: boolean): string[] {
  const rows: string[] = []
  for (let y = 0; y < iconPixels.length; y += 2) {
    let line = ''
    for (let x = 0; x < ICON_COLUMNS; x++) {
      const top = iconPixels[y][x], bottom = iconPixels[y + 1][x]
      const t = top === '.' ? null : ICON_RGB[Number(top)]
      const b = bottom === '.' ? null : ICON_RGB[Number(bottom)]
      if (!color) line += t && b ? '█' : t ? '▀' : b ? '▄' : ' '
      else if (t && b) line += `\x1b[38;2;${t}m\x1b[48;2;${b}m▀\x1b[0m`
      else if (t) line += `\x1b[38;2;${t}m▀\x1b[0m`
      else if (b) line += `\x1b[38;2;${b}m▄\x1b[0m`
      else line += ' '
    }
    rows.push(line)
  }
  return rows
}

// Two-row block lettering. Each letter is three columns; the flame gradient
// runs red to gold across the word.
const WORDMARK = [['█▀▄', '█▀█', '▄▀█', '█▀▀', '█▀█'], ['█▄▀', '█▀▄', '█▀█', '█▄▄', '█▄█']]
const FLAME = ['38;5;196', '38;5;202', '38;5;208', '38;5;214', '38;5;220']
export const WORDMARK_WIDTH = 19

function wordmark(color: boolean): string[] {
  return WORDMARK.map(row => row.map((letter, i) => (color ? `\x1b[${FLAME[i]}m${letter}\x1b[0m` : letter)).join(' '))
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

const spinner = (p: Painter, now: number): string => p.g.spinner[Math.floor(now / 80) % p.g.spinner.length]

function infoLines(state: TerminalView, size: number, p: Painter, color: boolean, now: number): string[] {
  const label = (name: string): string => p.accent(pad(name, 10))
  const value = (text: string): string => clip(text, Math.max(0, size - 10))
  const [mark1, mark2] = wordmark(color)
  const status = state.busy
    ? (state.paused ? p.accent('‖') : p.accent(spinner(p, now))) + ' ' + clip(busyText(state), Math.max(0, size - 2))
    : state.lastSaved ? p.good(p.g.ok) + ' ' + p.dim(ellipsize(`Last saved: ${lastName(state.lastSaved)}`, size - 2))
      : p.good('●') + ' ' + p.dim('Ready')
  const lines = [
    mark1,
    mark2 + (size >= WORDMARK_WIDTH + 3 ? p.dim(clip(`  v${state.version}`, size - WORDMARK_WIDTH)) : ''),
    p.dim(clip('Paste a link. Make it yours.', size)),
    '',
    label('QUALITY') + value(formatLabel(state.format)),
    label('SAVE TO') + saveTo(state, Math.max(0, size - 10), p),
    ...(state.config ? [label('SETTINGS') + p.dim(value(lastName(state.config)))] : []),
    '',
    status
  ]
  return lines.map(line => (width(line) > size ? clip(line, size) : line))
}

/** "Downloading 1 · merging 1 · 11 waiting": what the queue is doing, in one line. */
function busyText(state: TerminalView): string {
  const c = state.counts ?? { transferring: state.transfers.length, finishing: 0, waiting: state.queue?.length ?? 0 }
  const waiting = c.waiting ? `${c.waiting} waiting` : ''
  if (state.paused) return ['Paused', waiting].filter(Boolean).join(' · ')
  const parts = [
    c.transferring ? `Downloading${c.transferring > 1 ? ` ${c.transferring}` : ''}` : c.finishing ? 'Merging' : 'Working',
    c.transferring && c.finishing ? `merging ${c.finishing}` : '',
    waiting
  ]
  return parts.filter(Boolean).join(' · ')
}

/** The folder, then why it is the folder - dimmed, and the first thing to go when space is short. */
function saveTo(state: TerminalView, size: number, p: Painter): string {
  const why = saveDirLabel(state.dirSource)
  const dir = clip(state.dir, size)
  return why && width(state.dir) + why.length + 3 <= size ? dir + p.faint(` (${why})`) : dir
}

function lastName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function shortcutBox(p: Painter, size: number): string[] {
  const inner = size - 2
  const title = ' Shortcuts '
  const top = p.faint('╭─') + p.dim(title) + p.faint('─'.repeat(Math.max(0, inner - 1 - title.length)) + '╮')
  const rows = SHORTCUTS.map(([key, label]) =>
    p.faint('│') + ' ' + p.accent(pad(key, 7)) + pad(label, inner - 9) + ' ' + p.faint('│'))
  return [top, ...rows, p.faint('╰' + '─'.repeat(inner) + '╯')]
}

/** Puts `block` in the middle of `rows` rows, padding with empty lines. */
function centre(block: string[], rows: number): string[] {
  const top = Math.max(0, Math.floor((rows - block.length) / 2))
  return Array.from({ length: rows }, (_, i) => block[i - top] ?? '')
}

/**
 * The full screen as one string of absolute-positioned rows.
 *
 * Every row is fitted to `columns - 1` (writing the last column makes some
 * consoles wrap) and the frame is pinned top to bottom: header, link box,
 * activity, then the key hints on the last row. Three header sizes - art,
 * wordmark only, one line - so the box and progress always fit first.
 */
export function renderTerminal(state: TerminalView, columns: number, rows: number, color: boolean, now = Date.now()): {
  output: string; cursor: { row: number; column: number } | null
} {
  const w = Math.max(1, columns - 1), h = Math.max(1, rows)
  const p = painter(color)
  const lines: string[] = []
  const add = (s: string): void => { lines.push(s) }
  let cursor: { row: number; column: number } | null = null

  if (w < 24 || h < 8) {
    // Too small for a frame: one status line and the prompt.
    add(p.accent(clip('DRACO', w)))
    const live = state.transfers[0]
    add(clip(state.busy ? live ? `${live.title}` : state.activity ?? 'Working…' : `❯ ${state.input}`, w))
    return finish(lines, h, null)
  }

  // ---- Header -------------------------------------------------------------
  const boxWidth = 28
  // Art header (blank + icon + blank) plus the link box, a spacer, ~5 activity rows and the footer.
  const artMode = h >= ICON_ROWS + 13 && w >= 2 + ICON_COLUMNS + 3 + 34
  const withBox = artMode && w >= 2 + ICON_COLUMNS + 3 + 30 + 2 + boxWidth
  if (artMode) {
    const art = iconRows(color)
    const infoWidth = w - 2 - ICON_COLUMNS - 3 - (withBox ? boxWidth + 2 : 0)
    const info = centre(infoLines(state, infoWidth, p, color, now), ICON_ROWS)
    const box = withBox ? centre(shortcutBox(p, boxWidth), ICON_ROWS) : []
    add('')
    for (let i = 0; i < ICON_ROWS; i++) {
      const left = '  ' + art[i] + '   ' + info[i]
      add(withBox ? left + ' '.repeat(Math.max(0, infoWidth - width(info[i])) + 2) + (box[i] || '') : left)
    }
    add('')
  } else if (h >= 16) {
    add('')
    const info = infoLines(state, w - 2, p, color, now)
    // Wordmark, version, tagline, quality, destination; status goes to the footer area.
    for (const line of [info[0], info[1], '', ...info.slice(4, state.config ? 7 : 6)]) add(line ? '  ' + line : '')
    add('')
  } else {
    add(p.accent(clip('DRACO', w)) + p.dim(clip(`  ${formatLabel(state.format)} · ${state.dir}`, Math.max(0, w - 5))))
  }

  // ---- Link box -----------------------------------------------------------
  // The box stays live while downloading: Enter queues the next link.
  const busyLook = Boolean(state.panel) || state.queueFocus !== undefined
  const edge = (s: string): string => (busyLook ? p.faint(s) : p.dim(s))
  const label = state.editingDir ? ' Save destination ' : ' Paste a link '
  add(edge('╭─') + (busyLook ? p.dim(label) : p.accent(label)) + edge('─'.repeat(Math.max(0, w - width(label) - 3)) + '╮'))
  const action = w >= 42 && !state.editingDir && !busyLook ? state.busy ? '  Queue   ' : ' Download ' : ''
  const capacity = Math.max(1, w - 6 - action.length)
  const chars = Array.from(cleanText(state.input))
  let start = 0
  while (start < state.cursor && width(chars.slice(start, state.cursor).join('')) >= capacity) start++
  const text = clip(chars.slice(start).join(''), capacity)
  const placeholder = state.editingDir ? 'C:\\Videos' : 'https://youtu.be/…  ·  any video, audio or file link'
  const content = text ? pad(text, capacity) : p.faint(pad(placeholder, capacity))
  cursor = busyLook ? null : { row: lines.length + 1, column: 5 + width(chars.slice(start, state.cursor).join('')) }
  add(edge('│') + ' ' + (busyLook ? p.faint(p.g.prompt) : p.accent(p.g.prompt)) + ' ' + content + ' ' +
    (action ? (color ? `\x1b[30;48;5;214m${action}\x1b[0m` : action) : '') + edge('│'))
  add(edge('╰' + '─'.repeat(Math.max(0, w - 2)) + '╯'))

  // ---- Activity -----------------------------------------------------------
  // Rows left for the activity list: everything but one spacer and the footer.
  const room = Math.max(0, h - lines.length - 2)
  const body: string[] = []
  if (state.panel) {
    body.push(p.accent(clip(state.panel.title, w - 2)))
    const fits = Math.max(1, room - 1) // under the panel title
    const first = Math.max(0, state.panel.selected - fits + 1)
    state.panel.items.slice(first, first + fits).forEach((item, i) => {
      const selected = first + i === state.panel!.selected
      body.push(selected ? p.accent(clip(`❯ ${item}`, w - 2)) : p.dim(clip(`  ${item}`, w - 2)))
    })
  } else if (state.help) {
    body.push(p.accent('Shortcuts') + p.dim('  ·  F1 or Esc to close'))
    // Two columns when there is room, so the whole list fits short windows.
    const columns = w >= 64 ? 2 : 1
    const cell = Math.floor((w - 2) / columns)
    const perColumn = Math.ceil(SHORTCUTS.length / columns)
    for (let r = 0; r < perColumn; r++) {
      body.push(Array.from({ length: columns }, (_, c) => SHORTCUTS[c * perColumn + r])
        .filter(Boolean).map(([key, name]) => p.accent(pad(key, 8)) + pad(name, cell - 8)).join(''))
    }
  } else {
    for (const t of state.transfers) {
      if (body.length) body.push('')
      body.push(...transferLines(t, w - 2, p, now))
    }
    if (!state.transfers.length && state.activity) body.push(p.accent(spinner(p, now)) + ' ' + clip(state.activity, w - 4))
    // The queue gets what the cards leave, minus a few rows so the newest note still shows.
    const queued = queueLines(state, w - 2, Math.max(2, room - body.length - 3), p)
    body.push(...(body.length ? queued : queued.slice(1)))
    // Errors wrap rather than truncate: the advice is usually at the end.
    const notes = state.notes.flatMap(note => {
      const mark = note.tone === 'good' ? p.good(p.g.ok) : note.tone === 'bad' ? p.bad(p.g.fail) : p.dim(p.g.info)
      return wrap(note.text, w - 4, note.tone === 'bad' ? 3 : 1).map((line, i) =>
        (i ? '  ' : mark + ' ') + (note.tone === 'info' ? p.dim(line) : line))
    })
    // Keep the newest notes that still fit under the progress cards.
    const free = room - body.length - (body.length ? 1 : 0)
    if (free > 0 && notes.length) {
      if (body.length) body.push('')
      body.push(...notes.slice(-free))
    }
    if (!body.length && !state.busy) body.push(p.faint(clip('Tip: paste a link from YouTube, X, SoundCloud, or any file URL, then press Enter.', w - 2)))
  }
  if (room > 0) add('')
  for (const line of body.slice(0, room)) add(' ' + line)

  // ---- Footer -------------------------------------------------------------
  const hints = state.panel ? '↑ ↓ choose · Enter confirm · Esc back'
    : state.queueFocus !== undefined ? '↑ ↓ choose · Del remove from queue · Esc back'
      : state.editingDir ? 'Enter save · Esc cancel'
        : state.paused ? `F5 continue · Enter add a link · F4 ${hint(REVEAL)} · Ctrl+C quit`
          : state.busy ? `Enter queue a link · Ctrl+C pause · F4 ${hint(REVEAL)} · F1 help`
            : `Enter download · F1 help · F2 settings · F4 ${hint(REVEAL)} · Ctrl+C quit`
  while (lines.length < h - 1) add('')
  lines.length = Math.min(lines.length, h - 1)
  add(p.faint(clip(hints, w)))
  return finish(lines, h, cursor)
}

/**
 * "Up next · 11": the waiting items, as many as fit in `rows` (header and an
 * "…and N more" line included). While the queue has focus the list scrolls to
 * keep the selection visible.
 */
function queueLines(state: TerminalView, size: number, rows: number, p: Painter): string[] {
  const queue = state.queue ?? []
  if (!queue.length || rows < 2) return []
  const focus = state.queueFocus
  const lines = ['', p.accent('Up next') + p.dim(` · ${queue.length}`) + (focus === undefined && size >= 40 ? p.faint('  ↓ to edit') : '')]
  const fits = Math.max(1, rows - 2 - (queue.length > rows - 2 ? 1 : 0))
  const first = focus === undefined ? 0 : Math.max(0, Math.min(focus - fits + 1, queue.length - fits))
  queue.slice(first, first + fits).forEach((item, i) => {
    const index = first + i
    const text = clip(`${String(index + 1).padStart(2)}. ${item.title}`, size - 2)
    lines.push(index === focus ? p.accent(`${p.g.prompt} `) + text : '  ' + p.dim(text))
  })
  const rest = queue.length - first - fits
  if (rest > 0) lines.push(p.faint(`  …and ${rest} more`))
  return lines
}

/** "Show in Explorer" -> "show in Explorer": lower-case the verb, keep the proper noun. */
function hint(label: string): string { return label[0].toLowerCase() + label.slice(1) }

function finish(lines: string[], h: number, cursor: { row: number; column: number } | null): {
  output: string; cursor: { row: number; column: number } | null
} {
  const visible = lines.slice(0, h)
  return {
    output: '\x1b[H' + visible.map((l, i) => `\x1b[${i + 1};1H` + l + '\x1b[0m\x1b[K').join('') + '\x1b[J',
    cursor: cursor && cursor.row <= h ? cursor : null
  }
}
