import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { emitKeypressEvents } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { validateUrl } from '../main/engine/create.ts'
import type { MediaVariant } from '../shared/types.ts'
import { isAudioVariant, type FormatSpec } from './args.ts'
import { setConfigDir } from './config.ts'
import { formatLabel, readPreferences, writePreferences, type Preferences, type SavedFormat } from './preferences.ts'
import type { Transfer } from './progress.ts'
import type { SaveDirSource } from './save-dir.ts'
import { CancelledError, type QueueItem, type Reporter, type Session } from './session.ts'
import { renderTerminal, type Note, type TerminalView } from './terminal-view.ts'
import { cleanText } from './text.ts'

export type Choose = (variants: MediaVariant[], title: string, configured: FormatSpec) => Promise<FormatSpec>

/** Desktop integration, injectable so tests never launch Explorer. */
export interface Shell {
  /** Shows `file` selected in its folder, or opens `dir` when there is no file yet. */
  reveal: (target: { dir: string; file: string | null }) => Promise<void>
  /** Opens a file with its default app. */
  open: (file: string) => Promise<void>
}

export interface InteractiveDependencies {
  version: string
  preferencePath: string
  defaults: { format: FormatSpec; dir: string; dirSource?: SaveDirSource }
  /** Opens the one download session the screen feeds for its whole lifetime. */
  openSession: (reporter: Reporter, choose: Choose) => Session
  /** The draco.cfg in effect, shown in the header so its options are never a surprise. */
  config?: string | null
  /** Where F2 writes a new default folder; null when draco.cfg is ignored. */
  configTarget?: string | null
  shell?: Shell
  terminal?: { input: NodeJS.ReadStream; output: NodeJS.WriteStream }
  /** Taskbar progress (OSC 9;4). Defaults to on in terminals known to draw it. */
  taskbar?: boolean
}

export function shouldOpenTerminal(argv: string[], stdinTTY: boolean, stdoutTTY: boolean,
  platform: string = process.platform, term = process.env.TERM): boolean {
  // Native Windows consoles support VT regardless of an inherited TERM=dumb.
  return argv.length === 0 && stdinTTY && stdoutTTY && (platform === 'win32' || term !== 'dumb')
}

export function qualityChoices(variants?: MediaVariant[]): SavedFormat[] {
  if (!variants) return [{ kind: 'best' }, ...[2160, 1440, 1080, 720, 480, 360].map(height =>
    ({ kind: 'height', height }) as SavedFormat), { kind: 'bestaudio' }, { kind: 'worst' }]
  const choices: SavedFormat[] = [{ kind: 'best' }]
  const heights = [...new Set(variants.filter(v => !isAudioVariant(v)).map(v => v.height).filter((h): h is number => !!h))]
  heights.sort((a, b) => b - a).forEach(height => choices.push({ kind: 'height', height }))
  if (variants.some(isAudioVariant)) choices.push({ kind: 'bestaudio' })
  return choices
}

/**
 * Starts a desktop helper and resolves once it has launched - not when it
 * exits: explorer.exe returns 1 on success and lingers, so its exit code says
 * nothing useful.
 */
function launch(command: string, args: string[], verbatim = false): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); done() })
  })
}

export const desktopShell: Shell = {
  async reveal({ dir, file }) {
    if (file && existsSync(file)) {
      // `/select,"path"` must reach Explorer exactly like this; Node's own
      // quoting would wrap the whole argument and Explorer would open Documents.
      // Windows paths cannot contain `"`, so the verbatim string is safe.
      if (process.platform === 'win32') return launch('explorer.exe', [`/select,"${file}"`], true)
      if (process.platform === 'darwin') return launch('open', ['-R', file])
      return launch('xdg-open', [dirname(file)])
    }
    await mkdir(dir, { recursive: true })
    return launch(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [dir])
  },
  async open(file) {
    // Explorer given a file opens it with the associated app, with no shell in
    // between - a title containing `&` cannot turn into a second command.
    return launch(process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [file])
  }
}

/** Splits pasted text into candidate links: one per line or per space-separated word. */
export function splitLinks(text: string): string[] {
  return text.split(/\s+/).map(part => part.trim()).filter(Boolean)
}

/** Windows Terminal and ConEmu draw OSC 9;4 as tab and taskbar progress; others may print it. */
function taskbarSupported(): boolean {
  return Boolean(process.env.WT_SESSION || process.env.ConEmuPID)
}

export async function openTerminal(deps: InteractiveDependencies): Promise<number> {
  const input = deps.terminal?.input ?? process.stdin, output = deps.terminal?.output ?? process.stdout
  const shell = deps.shell ?? desktopShell
  const taskbar = deps.taskbar ?? taskbarSupported()
  let preferences: Preferences = {}
  const startup: Note[] = []
  try { preferences = await readPreferences(deps.preferencePath) }
  catch { startup.push({ text: 'Could not read saved preferences. Using the defaults.', tone: 'bad' }) }
  // A folder saved by older versions would override "download where I opened
  // Draco" forever; the default folder lives in draco.cfg now. Dropped on the next save.
  delete preferences.dir
  const state: TerminalView = {
    version: deps.version, input: '', cursor: 0,
    format: preferences.format ?? deps.defaults.format,
    dir: deps.defaults.dir, dirSource: deps.defaults.dirSource, busy: false,
    notes: startup, activity: null, transfers: [], queue: [], lastSaved: null, config: deps.config ?? null
  }
  const colors = !('NO_COLOR' in process.env) && process.env.FORCE_COLOR !== '0'
  let closed = false
  let picker: ((choice: number | null) => void) | null = null
  let saving: Promise<void> = Promise.resolve()
  let pasting = false, pasted = '', savedInput = ''
  // Links submitted this session, newest last; ↑/↓ walk it like a shell history.
  const history: string[] = []
  let historyAt = 0, draft = ''
  let lastUrl: string | null = null
  let redrawTimer: ReturnType<typeof setTimeout> | undefined
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let sizeTimer: ReturnType<typeof setInterval> | undefined
  let dimensions = ''
  // One "round" is from the first link to the queue running dry; at its end the
  // bell rings if it was worth waiting for.
  let round: { started: number; saved: number } | null = null
  let taskbarState = ''
  let finish!: () => void
  const ended = new Promise<void>(done => { finish = done })
  const wasRaw = input.isRaw

  const reporter: Reporter = {
    set(message) { state.activity = message ? cleanText(message) : null; schedule() },
    info(line) { note(line) },
    error(line) { note(line, 'bad') },
    saved(path, message) {
      state.lastSaved = path
      if (round) round.saved++
      // One hint, kept last: a playlist saving 40 files should not print it 40 times.
      const hint = `F3 opens it · F4 shows it in ${process.platform === 'win32' ? 'Explorer' : 'its folder'}`
      state.notes = state.notes.filter(n => n.text !== hint)
      note(message, 'good')
      note(hint)
    },
    progress(transfers: Transfer[]) {
      // The session ticks every 250 ms; an idle tick changes nothing on screen.
      if (!transfers.length && !state.transfers.length) return
      state.transfers = transfers
      schedule()
    },
    queue(items: QueueItem[]) {
      state.queue = items.map(({ id, title }) => ({ id, title: cleanText(title) }))
      if (state.queueFocus !== undefined) {
        if (!state.queue.length) state.queueFocus = undefined
        else state.queueFocus = Math.min(state.queueFocus, state.queue.length - 1)
      }
      schedule()
    },
    clear() { state.transfers = []; state.activity = null; schedule() }
  }
  const session = deps.openSession(reporter, choose)

  /** Busy = anything resolving, moving, merging or waiting. Derived, never stored by hand. */
  function refresh(): void {
    const c = session.counts()
    const busy = c.transferring + c.finishing + c.waiting + c.resolving > 0
    state.counts = { transferring: c.transferring, finishing: c.finishing, waiting: c.waiting }
    state.paused = session.paused
    if (busy && !round) round = { started: Date.now(), saved: 0 }
    if (!busy && round && !session.paused) {
      // The queue ran dry. Ring once if it took a while or saved several files -
      // the case where someone switched to another window to wait.
      if (round.saved >= 2 || (round.saved >= 1 && Date.now() - round.started > 60_000)) output.write('\x07')
      round = null
    }
    state.busy = busy
  }

  function draw(): void {
    if (closed) return
    refresh()
    const view = renderTerminal(state, output.columns || 100, output.rows || 30, colors)
    output.write('\x1b[?25l' + view.output + progressSequence())
    if (view.cursor) output.write(`\x1b[${view.cursor.row};${view.cursor.column}H\x1b[?25h`)
  }
  /** Windows Terminal's tab/taskbar progress, written only when it changes. */
  function progressSequence(): string {
    if (!taskbar) return ''
    const live = state.transfers.filter(t => t.phase === 'downloading' && t.total)
    const received = live.reduce((sum, t) => sum + (t.received ?? 0), 0)
    const total = live.reduce((sum, t) => sum + (t.total ?? 0), 0)
    const next = !state.busy ? '0;0'
      : state.paused ? `4;${total ? Math.floor(received / total * 100) : 0}`
        : total ? `1;${Math.min(100, Math.floor(received / total * 100))}` : '3;0'
    if (next === taskbarState) return ''
    taskbarState = next
    return `\x1b]9;4;${next}\x07`
  }
  // Coalesces bursts (a progress line every 250 ms, a paste of 500 keypresses)
  // into one repaint per frame.
  function schedule(): void {
    if (!redrawTimer) redrawTimer = setTimeout(() => { redrawTimer = undefined; draw() }, 16)
  }
  function resize(): void {
    if (closed) return
    // ConPTY can finish clearing/reflowing after the initial resize event.
    // Repaint immediately and again once the resize has settled.
    output.write('\x1b[0m\x1b[2J')
    draw()
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(draw, 120)
  }
  function checkSize(): void {
    // On Windows, Node may not refresh its cached TTY size until input arrives.
    const tty = output as NodeJS.WriteStream & { _refreshSize?: () => void }
    tty._refreshSize?.()
    const next = `${output.columns}:${output.rows}`
    if (next !== dimensions) { dimensions = next; resize() }
    // The spinner and the indeterminate bar animate off the clock, so a busy
    // screen needs frames even when no new numbers arrive.
    else if (state.busy || round) schedule()
  }
  function note(text: string, tone: Note['tone'] = 'info'): void {
    state.notes = [...state.notes, { text: cleanText(text), tone }].slice(-6)
    schedule()
  }
  function save(): Promise<void> {
    const snapshot = { ...preferences }
    saving = saving.then(() => writePreferences(deps.preferencePath, snapshot))
      .catch(() => { note('Could not save preferences; your choices apply until you close Draco.', 'bad') })
    return saving
  }
  function select(title: string, items: string[], selected = 0): Promise<number | null> {
    // A second panel replaces the first; the first one's caller hears "cancelled".
    if (picker) settle(null)
    state.help = false
    state.queueFocus = undefined
    state.panel = { title: cleanText(title), items, selected: Math.max(0, selected) }
    draw()
    return new Promise(done => { picker = done })
  }
  function settle(choice: number | null): void {
    const done = picker
    picker = null
    state.panel = undefined
    done?.(choice)
    schedule()
  }
  async function choose(variants: MediaVariant[], title: string, configured: FormatSpec): Promise<FormatSpec> {
    if (preferences.format) return preferences.format
    const choices = qualityChoices(variants)
    const initial = choices.findIndex(f => formatLabel(f) === formatLabel(configured))
    const index = await select(`Choose a quality for ${title}`, choices.map(formatLabel), initial)
    if (index === null) throw new CancelledError()
    // A prefetch may have asked the same question while this one was open.
    if (preferences.format) return preferences.format
    preferences.format = choices[index]
    state.format = preferences.format
    note(`Quality set to ${formatLabel(preferences.format)}. Change it any time with F2.`)
    await save()
    return preferences.format
  }
  async function settings(): Promise<void> {
    const index = await select('Settings', [`Quality     ${formatLabel(state.format)}`, `Save to     ${state.dir}`])
    if (index === 0) {
      const choices = qualityChoices()
      const selected = await select('Default quality', choices.map(formatLabel), choices.findIndex(f => formatLabel(f) === formatLabel(state.format)))
      if (selected !== null) {
        preferences.format = choices[selected]
        state.format = preferences.format
        await save()
      }
    } else if (index === 1) {
      savedInput = state.input
      setInput(state.dir)
      state.editingDir = true
    }
    schedule()
  }
  /** After a new folder is typed: this session only, or the default in draco.cfg. */
  async function applyDir(dir: string): Promise<void> {
    const options = ['Just for this session']
    if (deps.configTarget) options.push('Make it the default (saved in draco.cfg)')
    const choice = options.length > 1 ? await select(`Save to ${dir}`, options) : 0
    if (choice === null) return
    state.dir = dir
    if (choice === 0) {
      state.dirSource = 'session'
      note(`Saving to ${dir} until you close Draco.`)
    } else {
      state.dirSource = 'config'
      try {
        await setConfigDir(deps.configTarget!, dir)
        state.config = deps.configTarget!
        note(`Saving to ${dir}. Draco uses it whenever you start it from your home folder.`)
      } catch {
        note(`Could not write ${deps.configTarget}. Saving to ${dir} for this session; add -P "${dir}" to that file to keep it.`, 'bad')
      }
    }
    schedule()
  }
  function setInput(text: string): void {
    state.input = text
    state.cursor = Array.from(text).length
  }
  function insert(text: string): void {
    const chars = Array.from(state.input)
    const added = Array.from(cleanText(text))
    // Bound pasted input, keeping render cost predictable.
    if (chars.length + added.length > 32768) { note('That is too long to be a link.', 'bad'); return }
    chars.splice(state.cursor, 0, ...added)
    state.input = chars.join('')
    state.cursor += added.length
    schedule()
  }
  function recall(step: -1 | 1): void {
    if (!history.length) return
    if (historyAt === history.length) draft = state.input
    historyAt = Math.max(0, Math.min(history.length, historyAt + step))
    setInput(historyAt === history.length ? draft : history[historyAt])
  }
  /**
   * Ctrl+C: closes a picker; otherwise pauses what is downloading (keeping the
   * queue); otherwise quits. So the first press never loses anything.
   */
  function stop(): void {
    if (state.panel) { settle(null); return }
    refresh()
    if (state.busy && !session.paused) {
      void session.pause().then(() => {
        const waiting = session.counts().waiting
        note(`Paused${waiting ? ` · ${waiting} waiting` : ''}. F5 continues · Ctrl+C again quits.`)
      })
      note('Pausing and saving progress…')
      return
    }
    finish()
  }
  function reveal(): void {
    const target = { dir: state.lastSaved ? dirname(state.lastSaved) : state.dir, file: state.lastSaved ?? null }
    shell.reveal(target).catch(() => note('Could not open the folder. Check the destination in F2 Settings.', 'bad'))
  }
  function openLast(): void {
    if (!state.lastSaved) { note('Nothing downloaded yet. F3 opens your last download once it is saved.'); return }
    shell.open(state.lastSaved).catch(() => note('Could not open the file. Press F4 to find it in its folder.', 'bad'))
  }
  function submit(): void {
    if (state.editingDir) {
      if (!state.input.trim()) { note('Type a folder to save into.', 'bad'); return }
      const dir = resolve(state.input.trim())
      state.editingDir = false
      setInput(savedInput)
      void applyDir(dir)
      schedule()
      return
    }
    // Several links pasted at once queue one after another, in paste order.
    const links: string[] = []
    for (const part of splitLinks(state.input)) {
      try { links.push(validateUrl(part)) }
      catch (error) { note(`${part.length > 60 ? part.slice(0, 59) + '…' : part}: ${(error as Error).message}`, 'bad') }
    }
    if (!links.length) return
    setInput('')
    historyAt = history.length
    for (const url of links) start(url)
  }
  function start(url: string): void {
    lastUrl = url
    if (history[history.length - 1] !== url) history.push(url)
    historyAt = history.length
    state.help = false
    // Resuming is implied: a new link while paused would otherwise sit there silently.
    if (session.paused) session.resume()
    if (!state.busy) state.notes = []
    state.busy = true
    // Errors were already reported by the session; the promise only says "queued".
    session.submit(url, state.dir).catch(() => { note('Press F5 to try again.') }).finally(schedule)
    schedule()
  }

  function onKey(text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): void {
    if (closed) return
    if (key.sequence === '\x1b[200~') { pasting = true; pasted = ''; return }
    if (key.sequence === '\x1b[201~') {
      pasting = false
      // Line breaks become spaces, so a pasted list of links stays a list.
      if (!state.panel) insert(pasted.replace(/[\r\n]+/g, ' ').trim())
      pasted = ''; return
    }
    if (pasting) { if (pasted.length < 32768) pasted += text ?? ''; return }
    if (key.ctrl && key.name === 'c') { stop(); return }
    // Available in every state, mid-download included.
    if (key.name === 'f1') { state.help = !state.help && !state.panel; schedule(); return }
    if (key.name === 'f3') { openLast(); return }
    if (key.name === 'f4') { reveal(); return }
    if (state.panel) {
      if (key.name === 'up') state.panel.selected = Math.max(0, state.panel.selected - 1)
      if (key.name === 'down') state.panel.selected = Math.min(state.panel.items.length - 1, state.panel.selected + 1)
      if (key.name === 'return') settle(state.panel.selected)
      if (key.name === 'escape') settle(null)
      schedule(); return
    }
    if (key.name === 'escape' && state.help) { state.help = false; schedule(); return }
    if (state.queueFocus !== undefined) {
      // Editing the "Up next" list: ↑/↓ choose, Del removes, anything else goes back to the link box.
      const focus = state.queueFocus, queue = state.queue ?? []
      if (key.name === 'up') state.queueFocus = focus === 0 ? undefined : focus - 1
      else if (key.name === 'down') state.queueFocus = Math.min(queue.length - 1, focus + 1)
      else if (key.name === 'delete' || key.name === 'backspace') {
        const item = queue[focus]
        if (item && session.remove(item.id)) note(`Removed ${item.title} from the queue.`)
      } else {
        state.queueFocus = undefined
        if (key.name !== 'escape') onKey(text, key)
      }
      schedule(); return
    }
    if (key.name === 'f2' && !state.editingDir) { void settings(); return }
    if (key.name === 'f5' && !state.editingDir) {
      if (session.resume()) note('Continuing…')
      else if (lastUrl) start(lastUrl)
      else note('No link to retry yet.')
      schedule(); return
    }
    if (key.name === 'escape') {
      if (state.editingDir) { state.editingDir = false; setInput(savedInput) }
      else { setInput(''); historyAt = history.length }
    } else if (key.name === 'return') submit()
    else if (key.name === 'up' && !state.editingDir) recall(-1)
    else if (key.name === 'down' && !state.editingDir) {
      // Past the newest link, ↓ steps into the queue - only from an empty box,
      // so it never swallows a link being typed.
      if (historyAt === history.length && !state.input && state.queue?.length) state.queueFocus = 0
      else recall(1)
    }
    else if (key.name === 'left') state.cursor = Math.max(0, state.cursor - 1)
    else if (key.name === 'right') state.cursor = Math.min(Array.from(state.input).length, state.cursor + 1)
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) state.cursor = 0
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) state.cursor = Array.from(state.input).length
    else if (key.ctrl && key.name === 'u') setInput('')
    else if (key.name === 'backspace' || key.name === 'delete') {
      const chars = Array.from(state.input)
      if (key.name === 'delete') chars.splice(state.cursor, 1)
      else if (state.cursor > 0) chars.splice(--state.cursor, 1)
      state.input = chars.join('')
    } else if (text && !key.ctrl && !key.meta && !text.startsWith('\x1b')) insert(text)
    schedule()
  }
  function restore(): void {
    if (closed) return
    closed = true
    if (redrawTimer) clearTimeout(redrawTimer)
    if (resizeTimer) clearTimeout(resizeTimer)
    if (sizeTimer) clearInterval(sizeTimer)
    input.removeListener('keypress', onKey)
    input.removeListener('end', terminate)
    output.removeListener('resize', resize)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', terminate)
    process.removeListener('exit', restore)
    input.setRawMode(wasRaw)
    input.pause()
    output.write((taskbar ? '\x1b]9;4;0;0\x07' : '') + '\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l')
  }
  function terminate(): void { settle(null); finish() }
  try {
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    input.on('keypress', onKey)
    input.on('end', terminate)
    output.on('resize', resize)
    dimensions = `${output.columns}:${output.rows}`
    sizeTimer = setInterval(checkSize, 120)
    process.on('SIGINT', stop)
    process.on('SIGTERM', terminate)
    process.on('exit', restore)
    output.write('\x1b[?1049h\x1b[?2004h\x1b[2J')
    draw()
    await ended
    // Pauses whatever is still running - journals flushed, so the same link
    // resumes next time - and cleans up the engine.
    await session.close()
    await saving
    return 0
  } finally { restore() }
}
