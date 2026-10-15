import { match, strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { unsupportedMpdPolicy } from '../src/main/dash/transfer-policy.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'

it('rejects MPD when global or queue limits would otherwise be bypassed', () => {
  const app = new RateLimiter()
  const queue = new RateLimiter(null, app)
  strictEqual(unsupportedMpdPolicy(queue), null)

  app.setQuota(1024, 60_000)
  match(unsupportedMpdPolicy(queue) ?? '', /transfer quota/)
  app.setQuota(null, 60_000)
  strictEqual(unsupportedMpdPolicy(queue), null)

  queue.setLimit(512)
  match(unsupportedMpdPolicy(queue) ?? '', /speed limit/)
  queue.setLimit(null)
  app.setLimit(512)
  match(unsupportedMpdPolicy(queue) ?? '', /speed limit/)
})
