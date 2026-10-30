import { deepStrictEqual, equal, ok } from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { describe, it } from 'node:test'
import { openTerminal, qualityChoices, shouldOpenTerminal, splitLinks, type Choose, type InteractiveDependencies } from '../src/cli/interactive.ts'
import { readPreferences, writePreferences, savedFormat } from '../src/cli/preferences.ts'
import { BOX_ROWS, cleanText, ICON_ROWS, renderTerminal, width, type TerminalView } from '../src/cli/terminal-view.ts'
import { transfer } from '../src/cli/progress.ts'
import type { MediaVariant } from '../src/shared/types.ts'
import { CancelledError, createSession, type QueueItem, type Reporter, type Session } from '../src/cli/session.ts'
import { parseArgs } from '../src/cli/args.ts'
import { configurePaths } from '../src/main/bootstrap/paths.ts'
import { setLogConsole } from '../src/main/log.ts'

const variant = (height: number): MediaVariant => ({ url: 'https://cdn.example/video', height,
  label: `${height}p`, bandwidth: 100, codecs: null, estimatedSize: null })

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise(done => setTimeout(done, 10))
  }
  throw new Error('Timed out waiting for terminal state')
}

/**
 * A session that runs `handler` per submitted link, with the real session's
 * contract: errors are reported, a cancelled picker is not a failure, pause
 * holds until resume, and `counts` tells the screen whether it is busy.
 */
function fakeSession(handler: (url: string, io: { reporter: Reporter; choose: Choose; paused: () => Promise<void> }) => Promise<void>) {
  const calls: string[] = []
  let active = 0, paused = false, wake: (() => void) | null = null
  let reporter!: Reporter
  const open = (r: Reporter, choose: Choose): Session => {
    reporter = r
    const pausedPromise = (): Promise<void> => new Promise(done => { wake = done })
    return {
      async submit(url) {
        calls.push(url); active++
        try { await handler(url, { reporter, choose, paused: pausedPromise }) }
        catch (error) {
          if (error instanceof CancelledError) reporter.info('Cancelled.')
          else { reporter.error(`Could not download: ${(error as Error).message}`); throw error }
        } finally { active-- }
      },
      async pause() { paused = true; const w = wake; wake = null; w?.(); return 1 },
      resume() { if (!paused) return false; paused = false; return true },
      get paused() { return paused },
      remove() { return false },
      counts() { return { transferring: active, finishing: 0, waiting: 0, resolving: 0 } },
      async idle() {},
      async close() {},
      failures: 0
    }
  }
  return { open, calls, reporter: () => reporter }
}

function terminal() {
  const input = new PassThrough() as unknown as NodeJS.ReadStream
  input.isRaw = false
  input.setRawMode = (raw: boolean) => { input.isRaw = raw; return input }
  const output = new PassThrough() as unknown as NodeJS.WriteStream
  output.columns = 100; output.rows = 30
  let screen = ''
  output.on('data', chunk => { screen += chunk.toString() })
  const key = (name: string, ctrl = false) => input.emit('keypress', undefined, { name, ctrl })
  const text = (value: string) => input.emit('keypress', value, {})
  return { input, output, key, text, screen: () => screen }
}

describe('terminal preferences and rendering', () => {
  it('only opens for a bare command in an interactive terminal', () => {
    equal(shouldOpenTerminal(['--help'], true, true), false)
    equal(shouldOpenTerminal(['https://example.com'], true, true), false)
    equal(shouldOpenTerminal([], false, true), false)
    equal(shouldOpenTerminal([], true, false), false)
    equal(shouldOpenTerminal([], true, true), process.platform === 'win32' || process.env.TERM !== 'dumb')
    equal(shouldOpenTerminal([], true, true, 'win32', 'dumb'), true)
    equal(shouldOpenTerminal([], true, true, 'linux', 'dumb'), false)
  })

  it('round trips preferences, rejects temporary format identities and tolerates corrupt files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-prefs-'))
    const path = join(dir, 'cli-preferences.json')
    try {
      deepStrictEqual(await readPreferences(path), {})
      await writePreferences(path, { format: { kind: 'height', height: 1080 }, dir: 'D:\\My Videos' })
      deepStrictEqual(await readPreferences(path), { format: { kind: 'height', height: 1080 }, dir: 'D:\\My Videos' })
      equal(savedFormat({ kind: 'index', index: 3 }), undefined)
      equal(savedFormat({ kind: 'height', height: -1 }), undefined)
      await writeFile(path, '{broken')
      deepStrictEqual(await readPreferences(path), {})
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('offers stable quality choices from the actual media', () => {
    deepStrictEqual(qualityChoices([variant(720), variant(1080), variant(720)]), [
      { kind: 'best' }, { kind: 'height', height: 1080 }, { kind: 'height', height: 720 }
    ])
  })

  it('fits wide, narrow and short terminals, including Unicode and malicious titles', () => {
    const state: TerminalView = { version: '0.1.2', input: 'https://example.com/' + 'a'.repeat(180), cursor: 190,
      format: { kind: 'best' }, dir: 'D:\\Videos\\日本語', busy: false, notes: [], activity: null, transfers: [],
      config: 'C:\\Draco\\draco.cfg' }
    const busy: TerminalView = { ...state, busy: true, counts: { transferring: 1, finishing: 1, waiting: 30 }, dirSource: 'here',
      queue: Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, title: `Queued 日本語 video ${i} `.repeat(4) })), queueFocus: 12, lastSaved: 'D:\\Videos\\' + '長い'.repeat(40) + '.mkv',
      transfers: [
        transfer('a', '日本語 title '.repeat(20), 'downloading', { step: 'Video', part: 1, parts: 2, received: 5e6, total: 9e7, speed: 3e6, eta: 400 }),
        transfer('b', 'second', 'finishing', { step: 'Merging video and audio' })
      ],
      notes: [{ text: 'Could not download: ' + 'very long reason '.repeat(30), tone: 'bad' }, { text: 'Saved x.mkv', tone: 'good' }] }
    for (const [columns, rows] of [[180, 42], [120, 30], [100, 30], [80, 30], [80, 24], [60, 24], [42, 12], [22, 8], [12, 4]]) {
      // Idle, busy with everything on screen at once, and the help list - each
      // must stay inside the terminal at every size.
      for (const [variant, color] of [[state, false], [busy, true], [{ ...state, help: true }, true]] as const) {
        const view = renderTerminal(variant, columns, rows, color)
        const lines = view.output.split(/\x1b\[\d+;1H/).slice(1).map(cleanText)
        ok(lines.length <= rows, `${columns}x${rows}: ${lines.length} rows`)
        ok(lines.every(line => width(line) < columns), `${columns}x${rows}: ${JSON.stringify(lines)}`)
        if (view.cursor) { ok(view.cursor.column < columns); ok(view.cursor.row <= rows) }
      }
      ok(!renderTerminal(state, columns, rows, false).output.includes('\x1b[93m'))
      const panel = renderTerminal({ ...state, panel: { title: '\x1b[2JUnsafe\nTitle', items: ['日本語'.repeat(30), '720p'], selected: 1 } }, columns, rows, true)
      ok(!panel.output.includes('\x1b[2J'))
      ok(panel.output.split(/\x1b\[\d+;1H/).slice(1).every(line => width(line) < columns))
    }
    equal(cleanText('\x1b]0;evil\x07title\x1b[2J\r\n'), 'title')
  })

  it('draws the dragon exactly as tall as the shortcut box beside it', () => {
    equal(ICON_ROWS, BOX_ROWS)
    const frame = renderTerminal({ version: '1.0.0', input: '', cursor: 0, format: { kind: 'best' }, dir: 'D:\\V', busy: true,
      notes: [], activity: null, transfers: [], counts: { transferring: 1, finishing: 0, waiting: 3 },
      queue: [{ id: 'a', title: 'Next one' }, { id: 'b', title: 'Then this' }, { id: 'c', title: 'Last' }] }, 115, 30, false).output
    const text = frame.split(/\x1b\[\d+;1H/).slice(1).map(cleanText).join('\n')
    ok(text.includes('Downloading · 3 waiting'), text)
    ok(text.includes('Up next · 3'), text)
    ok(text.includes(' 1. Next one'), text)
  })
})

describe('interactive session lifecycle', () => {
  it('repaints after repeated resizes without losing input, settings, or messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-resize-'))
    const t = terminal()
    const opened = openTerminal({ version: 'test', preferencePath: join(dir, 'prefs.json'), terminal: t,
      defaults: { format: { kind: 'best' }, dir }, openSession: fakeSession(async () => {}).open })
    try {
      await until(() => t.input.isRaw)
      t.text('https://example.com/retained')
      for (const [columns, rows] of [[42, 12], [180, 42], [12, 4], [100, 30]]) {
        t.output.columns = columns; t.output.rows = rows
        t.output.emit('resize')
        await new Promise(done => setTimeout(done, 150))
        const frame = t.screen().slice(t.screen().lastIndexOf('\x1b[H'))
        ok(frame.includes('Paste a link') || frame.includes('DRACO'))
      }
      ok(t.screen().slice(t.screen().lastIndexOf('\x1b[H')).includes('https://example.com/retained'))
      t.key('f2')
      await until(() => t.screen().includes('Settings'))
      t.output.columns = 70; t.output.emit('resize')
      ok(t.screen().slice(t.screen().lastIndexOf('\x1b[H')).includes('Settings'))
      t.key('escape')
    } finally {
      t.key('c', true); await opened
      equal(t.output.listenerCount('resize'), 0)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('selects quality once, remembers it across launches, edits destination and restores terminal state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-terminal-'))
    const path = join(dir, 'preferences.json')
    const signals = process.listenerCount('SIGINT'), exits = process.listenerCount('exit')
    let runs = 0, chosen = 0
    const fake = fakeSession(async (_url, { reporter, choose }) => {
      const format = await choose([variant(1080), variant(720)], 'Test video', { kind: 'best' })
      deepStrictEqual(format, { kind: 'height', height: 1080 })
      chosen++
      reporter.info('[done] test.mp4')
      runs++
    })
    const deps: InteractiveDependencies = { version: 'test', preferencePath: path,
      defaults: { format: { kind: 'best' }, dir }, openSession: fake.open }
    try {
      const t = terminal()
      const opened = openTerminal({ ...deps, terminal: t })
      await until(() => t.input.isRaw)
      // Exercise bracketed multiline paste through the real readline decoder.
      t.input.emit('data', Buffer.from('\x1b[200~https://example.com/video\r\n\x1b[201~'))
      equal(runs, 0)
      t.key('return')
      await until(() => t.screen().includes('Choose a quality for Test video'))
      t.key('down'); t.key('return')
      await until(() => runs === 1)
      t.text('https://example.com/second'); t.key('return')
      await until(() => runs === 2)
      t.key('f2'); t.key('down'); t.key('return')
      await until(() => t.screen().includes('Save destination'))
      t.key('home'); t.key('delete'); t.key('end'); t.key('backspace')
      // Replace destination with a deterministic path via Home/Delete.
      for (let i = 0; i < dir.length + 2; i++) t.key('backspace')
      t.text(dir); t.key('return')
      t.key('c', true)
      await opened
      equal(t.input.isRaw, false)
      equal(t.input.listenerCount('keypress'), 0)
      equal(t.output.listenerCount('resize'), 0)
      ok(t.screen().endsWith('\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l'))
      equal(process.listenerCount('SIGINT'), signals)
      equal(process.listenerCount('exit'), exits)
      // The folder is no longer a saved preference: it follows where Draco was started.
      const prefs = JSON.parse(await readFile(path, 'utf8'))
      deepStrictEqual(prefs, { format: { kind: 'height', height: 1080 } })
      const next = terminal()
      const reopened = openTerminal({ ...deps, terminal: next })
      await until(() => next.input.isRaw)
      next.text('https://example.com/third'); next.key('return')
      await until(() => runs === 3)
      next.key('c', true)
      await reopened
      equal(chosen, 3)
      ok(!next.screen().includes('Choose a quality for Test video'))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('cancels a picker, pauses a download, recovers from errors and cleans up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-cancel-'))
    const t = terminal()
    let runs = 0, paused = false
    const fake = fakeSession(async (_url, io) => {
      runs++
      if (runs === 1) { await io.choose([variant(720)], 'Cancel me', { kind: 'best' }); return }
      if (runs === 2) throw new Error('Resolver unavailable')
      await io.paused(); paused = true
    })
    const opened = openTerminal({ version: 'test', preferencePath: join(dir, 'prefs.json'), terminal: t,
      defaults: { format: { kind: 'best' }, dir }, openSession: fake.open })
    try {
      await until(() => t.input.isRaw)
      t.text('https://example.com/video'); t.key('return')
      await until(() => t.screen().includes('Cancel me'))
      t.key('escape')
      await until(() => t.screen().includes('Cancelled.'))
      // The box was cleared on submit; ↑ brings the link back for another go.
      t.key('up'); t.key('return')
      await until(() => t.screen().includes('Resolver unavailable'))
      t.key('up'); t.key('return')
      await until(() => runs === 3)
      t.key('c', true)
      await until(() => paused)
      await until(() => t.screen().includes('F5 continues'))
      t.key('c', true)
      await opened
      equal(t.input.isRaw, false)
    } finally {
      process.emit('SIGTERM')
      await opened
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** Collects what a session reports, for assertions. */
function recorder() {
  const lines: string[] = []
  const saved: string[] = []
  let queue: QueueItem[] = []
  const reporter: Reporter = {
    set() {}, info: line => { lines.push(line) }, error: line => { lines.push(`ERROR ${line}`) },
    saved: (path, line) => { saved.push(path); lines.push(line) }, progress() {}, queue: items => { queue = items }, clear() {}
  }
  return { reporter, lines, saved, queue: () => queue }
}

it('one engine serves a whole session: queued links, pause holds the queue, resume finishes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-engine-session-'))
  configurePaths({ userData: join(dir, 'profile'), resourceRoot: process.cwd(), isPackaged: false, downloads: dir })
  setLogConsole(false)
  const payload = Buffer.alloc(512 * 1024, 0x5a)
  let pauseAt: (() => void) | undefined
  const order: string[] = []
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Number(range[2]) : payload.length - 1
    res.writeHead(range ? 206 : 200, {
      'content-type': 'application/octet-stream', 'content-length': end - start + 1,
      'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${payload.length}` } : {})
    })
    if (req.method === 'HEAD') { res.end(); return }
    if (!order.includes(req.url!)) order.push(req.url!)
    let offset = start
    const timer = setInterval(() => {
      const next = Math.min(end + 1, offset + 32768)
      res.write(payload.subarray(offset, next)); offset = next
      if (pauseAt && req.url === '/paused.bin' && offset >= 65536) { const p = pauseAt; pauseAt = undefined; p() }
      if (offset > end) { clearInterval(timer); res.end() }
    }, 10)
    res.on('close', () => clearInterval(timer))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const url = (name: string) => `http://127.0.0.1:${port}/${name}`
  const r = recorder()
  const session = createSession({ options: parseArgs(['--ignore-config', url('x'), '-N', '1']), dir, reporter: r.reporter, lanes: 1,
    choose: async () => { throw new Error('Direct files must not open a quality picker') } })
  try {
    // Two links at once with one lane: the second waits its turn instead of
    // starting alongside, and both land.
    await session.submit(url('first.bin'))
    await session.submit(url('second.bin'))
    await session.idle()
    deepStrictEqual(await readFile(join(dir, 'first.bin')), payload)
    deepStrictEqual(await readFile(join(dir, 'second.bin')), payload)
    deepStrictEqual(order.filter(u => u !== '/paused.bin').slice(0, 2), ['/first.bin', '/second.bin'])
    // Pause mid-transfer with another link queued: the queue survives the pause.
    const reached = new Promise<void>(done => { pauseAt = done })
    await session.submit(url('paused.bin'))
    await session.submit(url('after.bin'))
    await reached
    equal(await session.pause(), 1)
    await session.idle()
    ok(r.lines.some(line => line.startsWith('Paused paused.bin')), r.lines.join('\n'))
    equal(r.queue().length, 1)
    equal(session.counts().waiting, 1)
    ok(session.resume())
    await session.idle()
    deepStrictEqual(await readFile(join(dir, 'paused.bin')), payload)
    deepStrictEqual(await readFile(join(dir, 'after.bin')), payload)
    equal(session.failures, 0)
  } finally {
    await session.close()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    await rm(dir, { recursive: true, force: true })
  }
})

it('splits a pasted list of links', () => {
  deepStrictEqual(splitLinks(' https://a.example/1\r\nhttps://b.example/2  https://c.example/3 '), [
    'https://a.example/1', 'https://b.example/2', 'https://c.example/3'
  ])
})

it('F4 reveals the folder, then the saved file; F3 opens it; F5, arrows, F1 and Esc work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-shortcut-'))
  const t = terminal()
  const revealed: Array<{ dir: string; file: string | null }> = []
  const openedFiles: string[] = []
  const urls: string[] = []
  let release!: () => void
  let finished = 0
  const saved = join(dir, 'clip.mkv')
  await writeFile(saved, 'x')
  const opened = openTerminal({ version: 'test', preferencePath: join(dir, 'prefs.json'), terminal: t,
    defaults: { format: { kind: 'best' }, dir },
    shell: { reveal: async target => { revealed.push(target) }, open: async file => { openedFiles.push(file) } },
    openSession: fakeSession(async (url, { reporter }) => {
      urls.push(url)
      reporter.progress([transfer('a', 'Clip', 'downloading', { received: 50, total: 100 })])
      await new Promise<void>(done => { release = done })
      reporter.progress([])
      reporter.saved(saved, 'Saved clip.mkv · 1 B')
      finished++
    }).open })
  try {
    await until(() => t.input.isRaw)
    // Before anything is saved: F4 opens the destination, F3 explains itself.
    t.key('f4')
    t.key('f3')
    await until(() => t.screen().includes('Nothing downloaded yet'))
    t.text('https://example.com/video'); t.key('return')
    await until(() => urls.length === 1)
    await until(() => t.screen().includes('50%'))
    t.key('f4') // still works mid-download
    release()
    await until(() => t.screen().includes('Saved clip.mkv'))
    ok(t.screen().includes('F3 opens it'))
    // After a save: F4 selects the file, F3 opens it.
    t.key('f4'); t.key('f3')
    deepStrictEqual(revealed, [{ dir, file: null }, { dir, file: null }, { dir, file: saved }])
    deepStrictEqual(openedFiles, [saved])
    // F5 reruns the last link; ↑ recalls it into the box; Esc clears it.
    t.key('f5')
    await until(() => urls.length === 2)
    release()
    await until(() => finished === 2)
    await new Promise(done => setTimeout(done, 40))
    t.key('up')
    await until(() => t.screen().slice(t.screen().lastIndexOf('\x1b[H')).includes('https://example.com/video'))
    t.key('escape')
    await new Promise(done => setTimeout(done, 40))
    ok(!t.screen().slice(t.screen().lastIndexOf('\x1b[H')).includes('https://example.com/video'))
    // F1 toggles the shortcut list.
    t.output.columns = 70; t.output.rows = 24; t.output.emit('resize')
    t.key('f1')
    await until(() => t.screen().slice(t.screen().lastIndexOf('\x1b[H')).includes('Retry / resume'))
    t.key('f1')
    deepStrictEqual(urls, ['https://example.com/video', 'https://example.com/video'])
  } finally {
    release?.()
    await new Promise(done => setTimeout(done, 25))
    t.key('c', true); await opened
    await rm(dir, { recursive: true, force: true })
  }
})
