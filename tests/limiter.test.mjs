import test from 'node:test'
import assert from 'node:assert/strict'
import { QuotaExceededError, RateLimiter } from '../src/main/engine/limiter.ts'

test('rate limiter aborts promptly while waiting for a long chunk', async () => {
  const limiter = new RateLimiter(1)
  const controller = new AbortController()
  const pending = limiter.consume(100, controller.signal)
  controller.abort()
  await assert.rejects(pending, /aborted/)
})

test('an exhausted quota is reported, not waited out', async () => {
  // Holding the connection open until the window turns is what undici's
  // bodyTimeout kills, so the budget running out has to be an answer.
  const limiter = new RateLimiter(null)
  limiter.setQuota(10, 30)
  const startedAt = Date.now()
  await limiter.consume(10)

  const refused = await limiter.consume(1).then(() => null, (err) => err)
  assert.ok(refused instanceof QuotaExceededError)
  assert.ok(refused.resumesAt >= startedAt && refused.resumesAt <= startedAt + 60)

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(limiter.quotaRemaining, 10)
  await limiter.consume(1)
  assert.equal(limiter.quotaRemaining, 9)
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
