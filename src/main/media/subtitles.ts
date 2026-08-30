import { extname } from 'node:path'
import { rename, rm, writeFile } from 'node:fs/promises'
import type { DownloadTask, SubtitleTrack } from '../../shared/types.ts'
import { getDispatcher } from '../engine/http.ts'
import type { RateLimiter } from '../engine/limiter.ts'
import { sanitizeFilename, uniquePath } from '../engine/naming.ts'
import { buildHeaders } from '../engine/probe.ts'

const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024

export interface SubtitleDownloadResult {
  saved: string[]
  warnings: string[]
}

/** Saves external page captions as sidecars; failure never corrupts the video. */
export async function downloadSubtitles(
  task: DownloadTask,
  limiter: RateLimiter,
  timeoutMs: number
): Promise<SubtitleDownloadResult> {
  const saved: string[] = []
  const warnings: string[] = []

  for (const track of task.subtitles ?? []) {
    try {
      const response = await fetch(track.url, {
        headers: buildHeaders(task.headers),
        redirect: 'follow',
        dispatcher: getDispatcher(timeoutMs)
      } as RequestInit)
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_SUBTITLE_BYTES) throw new Error('caption file is larger than 20 MB')

      const chunks: Buffer[] = []
      let total = 0
      for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.from(raw)
        total += chunk.length
        if (total > MAX_SUBTITLE_BYTES) throw new Error('caption file is larger than 20 MB')
        await limiter.consume(chunk.length)
        chunks.push(chunk)
      }

      const target = await uniquePath(task.dir, subtitleFilename(task.filename, track))
      const temporary = `${target}.dracodl`
      await writeFile(temporary, Buffer.concat(chunks))
      await rename(temporary, target).catch(async (error) => {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      })
      saved.push(target)
    } catch (error) {
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
  return `${base}.${identity}.${track.format}`
}
