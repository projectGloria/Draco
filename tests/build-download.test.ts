import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { rejects, strictEqual, deepStrictEqual } from 'node:assert/strict'
import { it } from 'node:test'

const { download } = createRequire(import.meta.url)('../tools/build-support.mjs')

it('verifies compressed build downloads, reuses verified files and preserves them on a bad update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'draco-build-download-'))
  const data = Buffer.from('standalone runtime fixture'.repeat(100))
  const compressed = gzipSync(data)
  const digest = createHash('sha256').update(data).digest('hex')
  let requests = 0
  const server = createServer((_req, res) => {
    requests++
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length }).end(compressed)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture server address')
    const url = `http://127.0.0.1:${address.port}/tool.exe`
    const target = join(root, 'tool.exe')
    await download(url, target, digest)
    deepStrictEqual(await readFile(target), data)
    await download(url, target, digest)
    strictEqual(requests, 1, 'a verified cached executable requires no request')
    await rejects(download(url, target, '0'.repeat(64)), /SHA-256 mismatch/)
    deepStrictEqual(await readFile(target), data, 'a failed update preserves the previous executable')
    deepStrictEqual(await readdir(root), ['tool.exe'], 'failed partial download is removed')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
