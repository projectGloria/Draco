import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { verifyExpectedChecksum } from '../src/main/engine/checksum.ts'

test('verifies the complete final file with each accepted checksum algorithm', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-checksum-'))
  try {
    const path = join(dir, 'muxed.mp4')
    const output = Buffer.from('finished mux output, including audio')
    await writeFile(path, output)
    for (const algorithm of ['md5', 'sha1', 'sha256']) {
      const expected = createHash(algorithm).update(output).digest('hex')
      await verifyExpectedChecksum(path, expected.toUpperCase())
      await assert.rejects(
        verifyExpectedChecksum(path, '0'.repeat(expected.length)),
        /Checksum mismatch/
      )
    }
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(verifyExpectedChecksum(path, createHash('sha256').update(output).digest('hex'), cancelled.signal))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
