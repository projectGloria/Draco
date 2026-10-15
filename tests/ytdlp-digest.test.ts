import { createHash } from 'node:crypto'
import { rejects, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { verifyYtDlpDigest } from '../src/main/ytdlp-digest.ts'

test('yt-dlp installation requires a matching published checksum', async () => {
  const binary = Buffer.from('test executable')
  const digest = createHash('sha256').update(binary).digest('hex')
  const sumsUrl = 'https://example.test/SHA2-256SUMS'
  const fetchSums = async () => new Response(`${digest}  yt-dlp.exe\n`)
  await verifyYtDlpDigest(binary, sumsUrl, fetchSums)

  await rejects(
    verifyYtDlpDigest(binary, sumsUrl, async () => new Response('offline', { status: 503 })),
    /checksum request returned HTTP 503/
  )
  await rejects(
    verifyYtDlpDigest(binary, sumsUrl, async () => new Response('no yt-dlp checksum here')),
    /checksum for yt-dlp\.exe is missing or invalid/
  )
  await rejects(
    verifyYtDlpDigest(binary, sumsUrl, async () => new Response(`${'0'.repeat(64)}  yt-dlp.exe`)),
    /does not match/
  )
  await rejects(
    verifyYtDlpDigest(binary, sumsUrl, async () => new Response('x'.repeat(100_001))),
    /too large/
  )
  strictEqual(binary.toString(), 'test executable')
})
