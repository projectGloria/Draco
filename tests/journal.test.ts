import { ok, strictEqual } from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  JOURNAL_VERSION,
  journalMatches,
  journalSegmentsValid,
  readJournal,
  removeJournal,
  segmentsForJournal,
  writeJournal,
  type JournalData
} from '../src/main/engine/journal.ts'
import type { ProbeResult, Segment } from '../src/shared/types.ts'

/**
 * The resume contract. A wrong answer here does not fail loudly - it splices
 * two different files together and reports success - so the bias throughout is
 * that anything short of a solid match must start over.
 */

let dir = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'draco-journal-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

function journal(overrides: Partial<JournalData> = {}): JournalData {
  return {
    version: JOURNAL_VERSION,
    url: 'https://example.test/file.bin',
    finalUrl: 'https://cdn.example.test/file.bin',
    filename: 'file.bin',
    size: 1000,
    etag: '"abc"',
    lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
    segments: [{ start: 0, end: 999, position: 400, active: false }],
    updatedAt: 1,
    ...overrides
  }
}

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    finalUrl: 'https://cdn.example.test/file.bin',
    filename: 'file.bin',
    size: 1000,
    resumable: true,
    etag: '"abc"',
    lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
    mimeType: 'application/octet-stream',
    statusCode: 200,
    ...overrides
  }
}

describe('journal storage', () => {
  it('round-trips through a temp file and a rename', async () => {
    const path = join(dir, 'round-trip.dracodl.json')
    await writeJournal(path, journal())

    const read = await readJournal(path)
    strictEqual(read?.size, 1000)
    strictEqual(read?.segments[0].position, 400)

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
    strictEqual(leftovers.length, 0, 'a successful write leaves no temp file behind')
  })

  it('reads a missing, unparseable or foreign-version journal as no journal', async () => {
    strictEqual(await readJournal(join(dir, 'nope.json')), null)

    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{ this is not json', 'utf8')
    strictEqual(await readJournal(corrupt), null, 'a half-written file must not throw')

    const future = join(dir, 'future.json')
    await writeJournal(future, journal({ version: JOURNAL_VERSION + 1 }))
    strictEqual(await readJournal(future), null, 'a journal from another build is not ours to trust')
  })

  it('sweeps temp files a crash left under names nobody knows', async () => {
    const path = join(dir, 'swept.dracodl.json')
    await writeJournal(path, journal())
    await writeFile(`${path}.11111111-2222-3333-4444-555555555555.tmp`, '{}', 'utf8')
    const bystander = join(dir, 'someone-else.tmp')
    await writeFile(bystander, '{}', 'utf8')

    await removeJournal(path)

    const left = await readdir(dir)
    ok(!left.some((name) => name.startsWith('swept.dracodl.json')), 'journal and its temps are gone')
    ok(left.includes('someone-else.tmp'), 'an unrelated temp file is not ours to delete')
  })

  it('clears active flags on the way out - nothing is running after a restart', () => {
    const segments: Segment[] = [{ start: 0, end: 9, position: 5, active: true }]
    strictEqual(segmentsForJournal(segments)[0].active, false)
    strictEqual(segments[0].active, true, 'the live segments are left alone')
  })
})

describe('journalMatches', () => {
  it('accepts a strong ETag match', () => {
    strictEqual(journalMatches(journal(), probe()), true)
  })

  it('rejects a changed size outright', () => {
    strictEqual(journalMatches(journal(), probe({ size: 2000 })), false)
  })

  it('rejects a changed strong ETag even when everything else agrees', () => {
    strictEqual(journalMatches(journal(), probe({ etag: '"def"' })), false)
  })

  it('refuses weak validators - equivalent is not byte-identical', () => {
    strictEqual(journalMatches(journal({ etag: 'W/"abc"' }), probe({ etag: 'W/"abc"' })), false)
  })

  it('refuses a moved redirect target when no strong ETag settles it', () => {
    const without = journal({ etag: null })
    strictEqual(journalMatches(without, probe({ etag: null, finalUrl: 'https://other.test/f.bin' })), false)
    strictEqual(
      journalMatches(without, probe({ etag: null, finalUrl: 'https://other.test/f.bin' }), { allowFinalUrlChange: true }),
      true,
      'YouTube signs a fresh CDN URL every time; its identity is held elsewhere'
    )
  })

  it('falls back to Last-Modified, then to size alone', () => {
    strictEqual(journalMatches(journal({ etag: null }), probe({ etag: null })), true)
    strictEqual(
      journalMatches(journal({ etag: null }), probe({ etag: null, lastModified: 'Thu, 22 Oct 2015 07:28:00 GMT' })),
      false
    )
    strictEqual(
      journalMatches(journal({ etag: null, lastModified: null }), probe({ etag: null, lastModified: null })),
      true,
      'size alone is weak, but refusing it would make resume useless on much of the web'
    )
    strictEqual(
      journalMatches(
        journal({ etag: null, lastModified: null, size: null }),
        probe({ etag: null, lastModified: null, size: null })
      ),
      false,
      'no validator and no length is nothing to match on'
    )
  })
})

describe('journalSegmentsValid', () => {
  const valid = (segments: Segment[], size: number | null = 1000): boolean =>
    journalSegmentsValid(segments, size)

  it('accepts a snapshot that tiles the file', () => {
    strictEqual(valid([
      { start: 0, end: 499, position: 500, active: false },
      { start: 500, end: 999, position: 700, active: false }
    ]), true)
  })

  it('rejects a hole between segments', () => {
    // `complete` only asks whether each segment passed its own end, so a gap
    // here would let a file with a missing middle be renamed into place.
    strictEqual(valid([
      { start: 0, end: 399, position: 400, active: false },
      { start: 500, end: 999, position: 500, active: false }
    ]), false)
  })

  it('rejects overlap, a late start, and a short tail', () => {
    strictEqual(valid([
      { start: 0, end: 599, position: 0, active: false },
      { start: 500, end: 999, position: 500, active: false }
    ]), false, 'overlapping ranges would put two writers on the same bytes')

    strictEqual(valid([{ start: 100, end: 999, position: 100, active: false }]), false, 'must start at byte zero')
    strictEqual(valid([{ start: 0, end: 800, position: 0, active: false }]), false, 'must reach the last byte')
  })

  it('rejects positions and totals that cannot be true', () => {
    strictEqual(valid([{ start: 0, end: 999, position: 1500, active: false }]), false, 'written past its own end')
    strictEqual(valid([{ start: 0, end: 999, position: -1, active: false }]), false)
    strictEqual(valid([{ start: 0, end: 1500, position: 0, active: false }]), false, 'reaches past the file')
    strictEqual(valid([{ start: 0, end: 1.5, position: 0, active: false }]), false, 'a byte offset is an integer')
    strictEqual(valid([]), false)
  })

  it('accepts an open-ended range only when the length is unknown', () => {
    strictEqual(valid([{ start: 0, end: -1, position: 10, active: false }], null), true)
    strictEqual(valid([{ start: 0, end: -1, position: 10, active: false }]), false, 'a known length needs a real tail')
  })
})
