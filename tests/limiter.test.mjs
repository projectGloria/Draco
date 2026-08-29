import test from 'node:test'
import assert from 'node:assert/strict'
import { RateLimiter } from '../src/main/engine/limiter.ts'

test('rate limiter aborts promptly while waiting for a long chunk', async () => {
  const limiter = new RateLimiter(1)
  const controller = new AbortController()
  const pending = limiter.consume(100, controller.signal)
  controller.abort()
  await assert.rejects(pending, /aborted/)
})
