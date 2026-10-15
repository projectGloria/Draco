import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { mkdtemp, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'
import { readJournal } from '../src/main/engine/journal.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { Segmenter } from '../src/main/engine/segmenter.ts'
import { TaskRunner } from '../src/main/engine/task.ts'
import { runSegment } from '../src/main/engine/worker.ts'

test('a large network chunk cannot overwrite a tail handed to another worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-write-safety-'))
  const payload = Buffer.alloc(4096, 'a')
  const server = createServer((_request, response) => {
    response.writeHead(206, {
      'content-range': 'bytes 0-4095/4096', 'content-length': payload.length, etag: '"fixed"'
    }).end(payload)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const path = join(dir, 'part')
  const file = await open(path, 'w+')
  await file.writeFile(Buffer.alloc(4096, 'z'))
  const segmenter = new Segmenter(4096, 1024)
  const segment = segmenter.segments[0]
  let split = false
  const handle = {
    async write(buffer: Uint8Array, offset: number, length: number, position: number) {
      if (!split) {
        split = true
        segmenter.split()
      }
      return file.write(buffer, offset, length, position)
    },
    async writev(buffers: Uint8Array[], position: number) {
      if (!split) {
        split = true
        segmenter.split()
      }
      return file.writev(buffers, position)
    }
  } as FileHandle

  try {
    await runSegment(segment, {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`, headers: {},
      fh: handle, limiter: new RateLimiter(), timeoutMs: 1000, retryLimit: 1,
      exponentialBackoff: false, expectedSize: 4096, expectedEtag: '"fixed"',
      signal: new AbortController().signal, writeBufferBytes: 1024, onBytes() {}
    })
    strictEqual(segment.position, 2048)
    const bytes = await readFile(path)
    deepStrictEqual(bytes.subarray(0, 2048), payload.subarray(0, 2048))
    deepStrictEqual(bytes.subarray(2048), Buffer.alloc(2048, 'z'), 'the tail belongs to the other worker')
  } finally {
    await file.close()
    await closeDispatchers()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoints exclude writes completed during the disk barrier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-checkpoint-snapshot-'))
  const task = createTask({ url: 'https://example.test/file', dir, filename: 'file.bin' })
  task.size = 4096
  task.resumable = true
  task.etag = '"fixed"'
  const runner = new TaskRunner(task, {
    maxConnections: 1, minSplitSize: 1024, timeoutMs: 1000, retryLimit: 1
  }, { limiter: new RateLimiter(), onUpdate() {}, onFinished() {} })
  const state = runner as unknown as {
    segmenter: Segmenter; fh: FileHandle; bytesSinceFlush: number; writeJournalNow(): Promise<void>
  }
  state.segmenter = new Segmenter(4096, 1024)
  state.segmenter.segments[0].position = 1024
  state.bytesSinceFlush = 1024
  state.fh = { async sync() {
    state.segmenter.segments[0].position = 2048
    state.bytesSinceFlush += 1024
  } } as FileHandle
  try {
    await state.writeJournalNow()
    const checkpoint = await readJournal(runner.journalPath)
    strictEqual(checkpoint?.segments[0].position, 1024)
    strictEqual(state.bytesSinceFlush, 1024, 'new writes still need a checkpoint')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
