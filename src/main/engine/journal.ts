import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(data), 'utf8')
  await rename(tmp, path)
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
  await rm(path + '.tmp', { force: true })
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
export function journalMatches(journal: JournalData, probe: ProbeResult): boolean {
  if (journal.size !== probe.size) return false

  // A strong validator settles it outright. Weak ETags (W/"...") only promise
  // semantic equivalence, not byte equality, so they are not good enough here.
  if (journal.etag && probe.etag) {
    const weak = journal.etag.startsWith('W/') || probe.etag.startsWith('W/')
    return !weak && journal.etag === probe.etag
  }

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
