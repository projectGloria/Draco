import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readResponseBytes, readResponsePrefix, readResponseText } from '../src/main/response-limit.ts'

test('bounded response reading cancels an oversized body before buffering it all', async () => {
  let cancelled = false
  let next = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(next++ === 0 ? [1, 2, 3] : [4, 5, 6]))
    },
    cancel() { cancelled = true }
  })
  await assert.rejects(readResponseBytes(new Response(body), 5), /exceeds 5 bytes/)
  assert.equal(cancelled, true)

  const declared = new Response('short', { headers: { 'content-length': '1000' } })
  await assert.rejects(readResponseBytes(declared, 5), /exceeds 5 bytes/)
})

test('media inspection keeps only the requested prefix when a server ignores Range', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('abcdef')) },
    cancel() { cancelled = true }
  })
  assert.equal((await readResponsePrefix(new Response(body), 3)).toString(), 'abc')
  assert.equal(cancelled, true)
  assert.equal(await readResponseText(new Response('playlist'), 16), 'playlist')
})
