import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { parseSha256 } from '../tools-version.ts'
import { fetchGuarded } from '../fetch-guard.ts'
import { readResponseText } from '../response-limit.ts'

type DigestFetcher = (url: string, options: { signal: AbortSignal }) => Promise<Response>
const guardedDigestFetch: DigestFetcher = (url, options) =>
  fetchGuarded(url, { signal: options.signal, timeoutMs: 30_000, requireHttps: true })

/** Refuse executable archives whose publisher digest cannot be checked. */
export async function verifyArchiveDigest(
  archivePath: string,
  sha256Url: string,
  fetchDigest: DigestFetcher = guardedDigestFetch
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let published: string | null = null
  try {
    const response = await fetchDigest(sha256Url, {
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const size = Number(response.headers.get('content-length'))
    if (Number.isFinite(size) && size > 4096) throw new Error('Digest file is too large')
    published = parseSha256(await readResponseText(response, 4096))
  } catch (error) {
    throw new Error(`Could not verify ffmpeg archive: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }

  if (!published) throw new Error('Could not verify ffmpeg archive: publisher digest is missing or invalid')
  const hash = createHash('sha256')
  await pipeline(createReadStream(archivePath), hash)
  const actual = hash.digest('hex')
  if (actual !== published) throw new Error('Ffmpeg archive does not match its published SHA-256 digest')
}
