import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rejects } from 'node:assert/strict'
import { it } from 'node:test'
import { verifyArchiveDigest } from '../src/main/hls/archive-digest.ts'

it('requires a matching publisher digest before an executable archive can be installed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-digest-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const archive = join(dir, 'build.zip')
  const bytes = Buffer.from('test archive')
  await writeFile(archive, bytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const checksumUrl = 'https://example.test/build.zip.sha256'

  await verifyArchiveDigest(archive, checksumUrl, async () => new Response(`${digest}  build.zip`))
  await rejects(
    verifyArchiveDigest(archive, checksumUrl, async () => new Response('Not found', { status: 404 })),
    /Could not verify ffmpeg archive/
  )
  await rejects(
    verifyArchiveDigest(archive, checksumUrl, async () => new Response('invalid checksum')),
    /publisher digest is missing or invalid/
  )
  await rejects(
    verifyArchiveDigest(archive, checksumUrl, async () => new Response('0'.repeat(64))),
    /does not match/
  )
})
