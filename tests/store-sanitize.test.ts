import { ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clamp, sanitizeQueues, sanitizeTasks } from '../src/main/store-sanitize.ts'

/**
 * Everything read back from `%APPDATA%/Draco` passes through here first.
 *
 * The files are plain JSON in a folder the user can edit, so this is the
 * boundary between "something on disk said so" and "the app believes it". The
 * rule throughout is that a bad field is replaced, never thrown on: one corrupt
 * row must not cost the user the other four hundred.
 */

const DEFAULT_DIR = 'C:\\Users\\me\\Downloads'

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    url: 'https://example.test/file.bin',
    filename: 'file.bin',
    dir: DEFAULT_DIR,
    size: 1000,
    received: 400,
    status: 'paused',
    kind: 'file',
    ...overrides
  }
}

describe('clamp', () => {
  it('keeps a value in range and falls back on nonsense', () => {
    strictEqual(clamp(5, 1, 10, 3), 5)
    strictEqual(clamp(50, 1, 10, 3), 10)
    strictEqual(clamp(-1, 1, 10, 3), 1)
    strictEqual(clamp('eight', 1, 10, 3), 3)
    strictEqual(clamp(NaN, 1, 10, 3), 3)
    strictEqual(clamp(undefined, 1, 10, 3), 3)
  })
})

describe('sanitizeTasks', () => {
  it('accepts a plain, valid row', () => {
    const [row] = sanitizeTasks([task()], DEFAULT_DIR)
    strictEqual(row.id, 'task-1')
    strictEqual(row.filename, 'file.bin')
    strictEqual(row.received, 400)
  })

  it('returns nothing for input that is not a list', () => {
    strictEqual(sanitizeTasks(null, DEFAULT_DIR).length, 0)
    strictEqual(sanitizeTasks({ id: 'x' }, DEFAULT_DIR).length, 0)
    strictEqual(sanitizeTasks('[]', DEFAULT_DIR).length, 0)
  })

  it('drops rows with no id or no usable URL, and keeps the rest', () => {
    const rows = sanitizeTasks([
      task({ id: 'good' }),
      task({ id: undefined }),
      task({ id: 'no-url', url: 'not a url' }),
      task({ id: 'ftp', url: 'ftp://example.test/f.bin' })
    ], DEFAULT_DIR)

    strictEqual(rows.length, 1, 'one corrupt row must not cost the others')
    strictEqual(rows[0].id, 'good')
  })

  it('refuses a URL scheme the engine would never fetch', () => {
    // A file:// or javascript: URL in a hand-edited store must not survive to
    // the point where something tries to open it.
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'data:text/html,x']) {
      strictEqual(sanitizeTasks([task({ url })], DEFAULT_DIR).length, 0, url)
    }
    strictEqual(sanitizeTasks([task({ url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) })], DEFAULT_DIR).length, 1)
  })

  it('keeps only the first row of a duplicated id', () => {
    const rows = sanitizeTasks([task({ filename: 'first.bin' }), task({ filename: 'second.bin' })], DEFAULT_DIR)
    strictEqual(rows.length, 1)
    strictEqual(rows[0].filename, 'first.bin')
  })

  it('sanitizes the filename rather than trusting it', () => {
    const [row] = sanitizeTasks([task({ filename: '..\\..\\Windows\\System32\\evil.exe' })], DEFAULT_DIR)
    ok(!row.filename.includes('\\'), 'a stored name can never become a path')
    ok(!row.filename.includes('..\\'))
  })

  it('replaces a destination that is not an absolute path', () => {
    const [row] = sanitizeTasks([task({ dir: '..\\..\\Windows' })], DEFAULT_DIR)
    strictEqual(row.dir, DEFAULT_DIR)
  })

  it('never reports more received than the file holds', () => {
    const [row] = sanitizeTasks([task({ size: 1000, received: 9_999_999 })], DEFAULT_DIR)
    strictEqual(row.received, 1000)
  })

  it('falls back to paused for a status it does not know', () => {
    const [row] = sanitizeTasks([task({ status: 'exploding' })], DEFAULT_DIR)
    strictEqual(row.status, 'paused', 'an unknown state must not be treated as running')
  })

  it('falls back to a plain file for a kind it does not know', () => {
    strictEqual(sanitizeTasks([task({ kind: 'quantum' })], DEFAULT_DIR)[0].kind, 'file')
    strictEqual(sanitizeTasks([task({ kind: 'torrent' })], DEFAULT_DIR)[0].kind, 'torrent')
  })

  it('discards a segment snapshot whose ranges overlap or cannot be true', () => {
    const bad = (segments: unknown): number =>
      sanitizeTasks([task({ segments })], DEFAULT_DIR)[0].segments.length

    strictEqual(bad([
      { start: 0, end: 599, position: 0, active: true },
      { start: 500, end: 999, position: 500, active: true }
    ]), 0, 'overlapping ranges would put two writers on the same bytes')
    strictEqual(bad([{ start: 0, end: 999, position: 1500, active: true }]), 0, 'written past its own end')
    strictEqual(bad([{ start: 0, end: 5000, position: 0, active: true }]), 0, 'reaches past a 1000-byte file')
    strictEqual(bad('not a list'), 0)
  })

  it('nothing here is what resume trusts - a gap survives sanitizing', () => {
    // These segments are display state. The authority for restarting a
    // transfer is the journal beside the partial, which `journalSegmentsValid`
    // holds to the stricter tiling rule; see tests/journal.test.ts. Asserting
    // strictness here would be asserting a guarantee this layer never made.
    const [row] = sanitizeTasks([task({
      segments: [
        { start: 0, end: 399, position: 400, active: true },
        { start: 500, end: 999, position: 500, active: true }
      ]
    })], DEFAULT_DIR)

    strictEqual(row.segments.length, 2)
    strictEqual(row.segments.every((seg) => seg.active === false), true, 'nothing is running after a restart')
  })

  it('sorts the snapshot, so a shuffled file still reads in order', () => {
    const [row] = sanitizeTasks([task({
      segments: [
        { start: 500, end: 999, position: 500, active: false },
        { start: 0, end: 499, position: 200, active: false }
      ]
    })], DEFAULT_DIR)

    strictEqual(row.segments[0].start, 0)
    strictEqual(row.segments[1].start, 500)
  })

  it('names a file for a row that never had one', () => {
    const [row] = sanitizeTasks([task({ filename: undefined, url: 'https://example.test/a/clip.mp4' })], DEFAULT_DIR)
    strictEqual(row.filename, 'clip.mp4')
  })
})

describe('sanitizeQueues', () => {
  it('clamps and defaults a hand-edited queue', () => {
    const [queue] = sanitizeQueues([{
      id: 'q1',
      name: 'Nightly',
      taskIds: ['a', 'b', 'a'],
      mode: 'periodic',
      startTime: '23:00',
      stopTime: '06:00',
      days: [0, 1, 9, -3],
      maxConcurrent: 999,
      onComplete: 'launch-missiles'
    }])

    strictEqual(queue.mode, 'periodic')
    strictEqual(queue.startTime, '23:00')
    ok(queue.maxConcurrent <= 32, 'an absurd concurrency is capped, not honoured')
    ok(queue.days.every((day) => day >= 0 && day <= 6), 'only real weekdays survive')
    strictEqual(queue.onComplete, 'none', 'an unknown completion action does nothing')
  })

  it('gives an id to a queue that lost one, rather than losing the queue', () => {
    const [queue] = sanitizeQueues([{ name: 'no id' }])
    ok(queue.id.length > 0)
    strictEqual(queue.name, 'no id')
  })

  it('re-ids a duplicate so two queues can never share one', () => {
    const queues = sanitizeQueues([{ id: 'same', name: 'A' }, { id: 'same', name: 'B' }])
    strictEqual(queues.length, 2)
    ok(queues[0].id !== queues[1].id)
  })

  it('never restores a queue as already running', () => {
    strictEqual(sanitizeQueues([{ id: 'q', running: true }])[0].running, false)
  })

  it('rejects a non-list', () => {
    strictEqual(sanitizeQueues('nope').length, 0)
    strictEqual(sanitizeQueues(null).length, 0)
  })
})
