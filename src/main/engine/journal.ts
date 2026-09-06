import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ProbeResult, Segment } from '../../shared/types.ts'

/**
 * The resume contract. Next to `<name>.dracodl` sits `<name>.dracodl.json`
 * holding where every segment had got to.
 *
 * Without this a killed process loses the whole file; with it a 40 GB download
 * survives a power cut. Correctness here matters more than speed, which is why
 * writes go through a temp file and a rename - a crash mid-write can then only
 * ever cost the last flush, never leave an unparseable journal that strands the
 * partial data beside it.
 */

export const JOURNAL_VERSION = 1

export interface JournalData {
  version: number
  url: string
  finalUrl: string
  filename: string
  size: number | null
  etag: string | null
  lastModified: string | null
  /** `active` is not persisted meaningfully - nothing is active after a restart. */
  segments: Segment[]
  updatedAt: number
}

export async function writeJournal(path: string, data: JournalData): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // A unique temp name, for the reason `store.ts` uses one: two writers can
  // legitimately be flushing the same journal - the 250 ms ticker racing a
  // pause or a shutdown that forces one - and a shared `<file>.tmp` lets one
  // rename or remove the other's file, turning a valid save into ENOENT and
  // costing exactly the resume information the journal exists to hold.
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data), 'utf8')
    await rename(tmp, path)
  } catch (err) {
    // On success the rename consumed the temp file; only clean up after a
    // failure that left one behind.
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export async function readJournal(path: string): Promise<JournalData | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as JournalData
    if (parsed?.version !== JOURNAL_VERSION || !Array.isArray(parsed.segments)) return null
    return parsed
  } catch {
    return null
  }
}

export async function removeJournal(path: string): Promise<void> {
  await rm(path, { force: true })
  // Temp names are unique now, so a crash mid-write can leave one behind under
  // a name nobody knows. Sweep the whole family rather than a single guess.
  const prefix = basename(path) + '.'
  const entries = await readdir(dirname(path)).catch(() => [] as string[])
  for (const name of entries) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) {
      await rm(join(dirname(path), name), { force: true }).catch(() => {})
    }
  }
}

/**
 * Decides whether a journal may still be trusted against a fresh probe.
 *
 * A file that changed on the server while we were away is the dangerous case:
 * resuming into it would splice two different files together and produce a
 * corrupt result that still looks complete. Re-downloading is the cheap mistake;
 * silent corruption is the expensive one, so anything short of a solid match
 * starts over.
 */
export function journalMatches(
  journal: JournalData,
  probe: ProbeResult,
  options: { allowFinalUrlChange?: boolean } = {}
): boolean {
  if (journal.size !== probe.size) return false

  // A strong validator settles it outright. Weak ETags (W/"...") only promise
  // semantic equivalence, not byte equality, so they are not good enough here.
  if (journal.etag && probe.etag) {
    const weak = journal.etag.startsWith('W/') || probe.etag.startsWith('W/')
    return !weak && journal.etag === probe.etag
  }

  // Without a strong ETag match, a changed redirect target is not safe to resume
  // from: the same-size URL can now point at completely different bytes.
  // YouTube is the explicit exception because its stable page/format identity is
  // stored separately and its signed CDN URL is expected to change.
  if (!options.allowFinalUrlChange && journal.finalUrl !== probe.finalUrl) return false

  if (journal.lastModified && probe.lastModified) {
    return journal.lastModified === probe.lastModified
  }

  // No validator on either side. Size alone is a weak signal, but refusing to
  // resume every such server would make resume useless on a large slice of the
  // web - and the size check above has already ruled out the common case.
  return journal.size !== null
}

export function segmentsForJournal(segments: Segment[]): Segment[] {
  return segments.map((seg) => ({ ...seg, active: false }))
}

/** Validates a persisted segment snapshot before Segmenter.restore consumes it. */
export function journalSegmentsValid(segments: Segment[], size: number | null): boolean {
  if (!Array.isArray(segments) || segments.length === 0) return false

  // Segments must tile the file from byte zero with no hole between them.
  // `complete` only asks whether every segment reached its own end, so a gap
  // would let a file with a missing middle be renamed into place as finished.
  let expectedStart = 0
  let lastEnd = -1
  let total = 0
  for (const seg of segments) {
    if (!Number.isSafeInteger(seg.start) || !Number.isSafeInteger(seg.position)) return false
    if (!Number.isSafeInteger(seg.end) || seg.start < 0 || seg.position < seg.start) return false
    if (seg.end >= 0 && seg.end < seg.start) return false
    if (seg.end >= 0 && seg.position > seg.end + 1) return false
    if (seg.start <= lastEnd) return false
    if (seg.start !== expectedStart) return false
    if (seg.end >= 0) {
      if (size !== null && seg.end >= size) return false
      lastEnd = seg.end
      expectedStart = seg.end + 1
    }
    total += seg.position - seg.start
    if (!Number.isSafeInteger(total)) return false
  }

  if (size === null) return true
  if (total > size) return false
  // The last segment has to reach the end of the file, or the tail is missing.
  return lastEnd === size - 1
}
