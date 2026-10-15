import { strictEqual } from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { probeUrl } from '../src/main/engine/probe.ts'
import { TaskRunner } from '../src/main/engine/task.ts'

for (const fallback of [false, true]) {
  it(`downloads the complete chunked GET when HEAD describes another representation (plain fallback: ${fallback})`, async () => {
    const payload = Buffer.from('complete payload after HEAD changed')
    const server = createServer((request, response) => {
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'content-length': '4', etag: '"old"' }).end()
      } else if (fallback && request.headers.range) {
        response.writeHead(403).end()
      } else {
        response.writeHead(200, { 'transfer-encoding': 'chunked' })
        response.end(payload)
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing server address')
    const url = `http://127.0.0.1:${address.port}/file`
    const dir = await mkdtemp(join(tmpdir(), 'draco-probe-authority-'))
    try {
      const probe = await probeUrl(url, { fresh: true })
      strictEqual(probe.size, null, 'GET must not inherit the HEAD length')
      strictEqual(probe.etag, null, 'GET must not inherit the HEAD validator')
      const task = createTask({ url, dir, filename: 'output.bin' })
      const runner = new TaskRunner(task, { maxConnections: 1, minSplitSize: 1024, retryLimit: 1, timeoutMs: 2000 }, {
        limiter: new RateLimiter(), onUpdate() {}, onFinished() {}
      })
      await runner.start()
      strictEqual(task.status, 'done')
      strictEqual(task.received, payload.length)
      strictEqual((await readFile(join(dir, task.filename))).equals(payload), true)
    } finally {
      await closeDispatchers()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  })
}
