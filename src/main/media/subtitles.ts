import { basename, extname, join } from 'node:path'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { DownloadTask, SubtitleTrack } from '../../shared/types.ts'
import { fetchGuarded, headersForResource } from '../fetch-guard.ts'
import type { RateLimiter } from '../engine/limiter.ts'
import { discardReservedPath, sanitizeFilename, uniquePath } from '../engine/naming.ts'
import { buildHeaders } from '../engine/probe.ts'

const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024

export interface SubtitleDownloadResult {
  saved: string[]
  warnings: string[]
}

export interface SubtitleReservation {
  ownedNames?: ReadonlyArray<string | null>
  ownedDigests?: ReadonlyArray<string | null>
  onReserved?(index: number, filename: string, digest: string): Promise<void>
  onVerified?(index: number, digest: string): Promise<void>
}

function digestOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Saves external page captions as sidecars; failure never corrupts the video. */
export async function downloadSubtitles(
  task: DownloadTask,
  limiter: RateLimiter,
  timeoutMs: number,
  signal?: AbortSignal,
  reservation?: SubtitleReservation
): Promise<SubtitleDownloadResult> {
  const saved: string[] = []
  const warnings: string[] = []

  for (const [index, track] of (task.subtitles ?? []).entries()) {
    if (signal?.aborted) break
    try {
      const ownedName = reservation?.ownedNames?.[index]
      const ownedPath = ownedName ? join(task.dir, ownedName) : null
      const ownedStat = ownedPath ? await stat(ownedPath).catch(() => null) : null
      const expectedDigest = reservation?.ownedDigests?.[index]
      let existingDigest: string | null = null
      if (ownedStat?.isFile() && ownedStat.size > 0) {
        if (ownedStat.size > MAX_SUBTITLE_BYTES) throw new Error('saved caption file is larger than 20 MB')
        existingDigest = digestOf(await readFile(ownedPath!))
        if (expectedDigest && /^[a-f0-9]{64}$/i.test(expectedDigest)) {
          if (existingDigest !== expectedDigest.toLowerCase()) {
            throw new Error('saved caption changed on disk; inspect it before retrying')
          }
          saved.push(ownedPath!)
          continue
        }
      }

      const response = await fetchGuarded(track.url, {
        headers: headersForResource(track.url, task.url, buildHeaders(task.headers)),
        signal,
        timeoutMs
      })
      let content: Buffer
      try {
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

        const declared = Number(response.headers.get('content-length') ?? 0)
        if (declared > MAX_SUBTITLE_BYTES) throw new Error('caption file is larger than 20 MB')

        const reader = response.body.getReader()
        const chunks: Buffer[] = []
        let total = 0
        let aborted = false
        let reachedEnd = false
        try {
          for (;;) {
            if (signal?.aborted) {
              aborted = true
              break
            }
            const { done, value } = await reader.read()
            if (done) {
              reachedEnd = true
              break
            }
            const chunk = Buffer.from(value)
            total += chunk.length
            if (total > MAX_SUBTITLE_BYTES) throw new Error('caption file is larger than 20 MB')
            // Passed through, so a low speed limit cannot leave this stuck on
            // "Saving subtitles" with no way to interrupt it.
            await limiter.consume(chunk.length, signal)
            chunks.push(chunk)
          }
        } finally {
          if (!reachedEnd) await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
        // A pause or shutdown mid-caption must not drop a truncated sidecar next
        // to the video; discard whatever arrived and let a resume fetch it again.
        if (aborted || signal?.aborted) break
        if (total === 0) throw new Error('caption file is empty')
        content = Buffer.concat(chunks, total)
      } finally {
        await response.body?.cancel().catch(() => {})
      }
      const digest = digestOf(content)

      if (existingDigest) {
        if (existingDigest !== digest) throw new Error('saved caption differs from the source; inspect it before retrying')
        await reservation?.onVerified?.(index, digest)
        saved.push(ownedPath!)
        continue
      }
      if (ownedStat?.isFile() && ownedStat.size === 0 && expectedDigest &&
        /^[a-f0-9]{64}$/i.test(expectedDigest) && expectedDigest.toLowerCase() !== digest) {
        throw new Error('caption source changed before the reserved sidecar was completed')
      }

      const reusedReservation = Boolean(ownedPath && ownedStat?.isFile() && ownedStat.size === 0)
      const target = reusedReservation
        ? ownedPath!
        : await uniquePath(task.dir, subtitleFilename(task.filename, track))
      const temporary = `${target}.dracodl`
      try {
        await reservation?.onReserved?.(index, basename(target), digest)
        if (signal?.aborted) {
          await discardReservedPath(target)
          break
        }
        await writeFile(temporary, content)
        await rename(temporary, target)
        const written = await stat(target)
        if (written.size !== content.length || digestOf(await readFile(target)) !== digest) {
          throw new Error('saved caption failed its integrity check')
        }
        saved.push(target)
      } catch (err) {
        await rm(temporary, { force: true }).catch(() => {})
        await discardReservedPath(target)
        throw err
      }
    } catch (error) {
      if (signal?.aborted) break
      warnings.push(`${track.label || track.language || 'Subtitle'}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { saved, warnings }
}

export function subtitleFilename(mediaFilename: string, track: SubtitleTrack): string {
  const extension = extname(mediaFilename)
  const base = extension ? mediaFilename.slice(0, -extension.length) : mediaFilename
  const identity = sanitizeFilename(track.language || track.label || 'subtitles')
    .replace(/\.+$/g, '') || 'subtitles'
  // `format` arrives from the page too; it is part of the path, so it is
  // sanitized just like the identity segment rather than trusted as one of
  // the two fixed extensions it is supposed to be.
  const format = sanitizeFilename(track.format || 'vtt').replace(/\.+$/g, '') || 'vtt'
  return `${base}.${identity}.${format}`
}
