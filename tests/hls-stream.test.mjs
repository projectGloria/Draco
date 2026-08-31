import test from 'node:test'
import assert from 'node:assert/strict'
import { streamResponseBody } from '../src/main/hls/stream.ts'

test('HLS response streaming writes and throttles each network chunk', async () => {
  const source = [Buffer.alloc(1024, 1), Buffer.alloc(2048, 2), Buffer.alloc(4096, 3)]
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of source) controller.enqueue(chunk)
      controller.close()
    }
  })
  const written = []
  const limited = []
  const progress = []

  const total = await streamResponseBody(
    body,
    (chunk) => { written.push(chunk) },
    (bytes) => { limited.push(bytes) },
    new AbortController().signal,
    (received) => { progress.push(received) }
  )

  assert.equal(total, 7168)
  assert.deepEqual(Buffer.concat(written), Buffer.concat(source))
  assert.deepEqual(limited, source.map((chunk) => chunk.length))
  assert.deepEqual(progress, [1024, 3072, 7168])
})
