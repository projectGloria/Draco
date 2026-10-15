import { createHash } from 'node:crypto'
import { fetchGuarded } from './fetch-guard.ts'
import { parseSha256 } from './tools-version.ts'

type SumsFetcher = (url: string, options: { signal: AbortSignal }) => Promise<Response>
const guardedSumsFetch: SumsFetcher = (url, options) =>
  fetchGuarded(url, {
    headers: { 'user-agent': 'Draco' }, signal: options.signal,
    timeoutMs: 20_000, requireHttps: true
  })

/** A downloaded executable may be installed only when the publisher digest matches. */
export async function verifyYtDlpDigest(
  body: Buffer,
  sumsUrl: string,
  fetchSums: SumsFetcher = guardedSumsFetch
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetchSums(sumsUrl, { signal: controller.signal })
    if (!response.ok) throw new Error(`publisher checksum request returned HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > 100_000) throw new Error('publisher checksum file is too large')

    const reader = response.body?.getReader()
    if (!reader) throw new Error('publisher checksum file is empty')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 100_000) throw new Error('publisher checksum file is too large')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const text = Buffer.concat(chunks, size).toString('utf8')
    const line = text.split('\n').find((entry) => /\s\*?yt-dlp\.exe\s*$/i.test(entry.trim()))
    const expected = line ? parseSha256(line) : null
    if (!expected) throw new Error('publisher checksum for yt-dlp.exe is missing or invalid')

    const actual = createHash('sha256').update(body).digest('hex')
    if (actual !== expected) throw new Error('yt-dlp.exe does not match its published SHA-256 digest')
  } finally {
    clearTimeout(timer)
  }
}
