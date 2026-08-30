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

test('quota limiter waits for the next transfer window', async () => {
  const limiter = new RateLimiter(null)
  limiter.setQuota(10, 30)
  await limiter.consume(10)

  const started = Date.now()
  await limiter.consume(1)
  assert.ok(Date.now() - started >= 20)
  assert.equal(limiter.quotaRemaining, 10)
})

test('quota usage survives recreation of the limiter', async () => {
  const first = new RateLimiter(null)
  first.setQuota(100, 60_000)
  await first.consume(35)

  const restored = new RateLimiter(null)
  restored.setQuota(100, 60_000)
  restored.restoreQuota(first.quotaState)
  assert.equal(restored.quotaRemaining, 65)
})
