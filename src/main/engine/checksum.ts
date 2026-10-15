import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** Verify the bytes that will become the final file, before publishing them. */
export async function verifyExpectedChecksum(
  path: string,
  expectedChecksum: string | null | undefined,
  signal?: AbortSignal
): Promise<void> {
  if (!expectedChecksum) return
  const expected = expectedChecksum.trim().toLowerCase()
  const algorithm = expected.length === 32 ? 'md5' : expected.length === 40 ? 'sha1' : 'sha256'
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  const actual = hash.digest('hex')
  if (actual !== expected) throw new Error(`Checksum mismatch. Expected ${expected}, got ${actual}`)
}
