import { ok, rejects, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { QuotaExceededError, RateLimiter } from '../src/main/engine/limiter.ts'

/**
 * The shared token bucket. Workers call `consume` after reading a chunk and
 * await it before pulling the next, so this is also the app's only backpressure
 * mechanism - a limiter that resolved too eagerly would let the socket run free.
 */

const KB = 1024

describe('RateLimiter rate', () => {
  it('is unlimited until given a limit', async () => {
    const limiter = new RateLimiter()
    strictEqual(limiter.limit, null)

    const started = Date.now()
    await limiter.consume(500 * 1024 * 1024)
    ok(Date.now() - started < 100, 'no limit means no waiting')
  })

  it('treats zero, null and negatives as no limit', () => {
    strictEqual(new RateLimiter(0).limit, null)
    strictEqual(new RateLimiter(-5).limit, null)
    strictEqual(new RateLimiter(null).limit, null)
    strictEqual(new RateLimiter(1000).limit, 1000)
  })

  it('makes an over-budget read wait for the bucket to refill', async () => {
    // The bucket starts full at one second's worth, so spending two seconds'
    // worth has to wait out roughly the second it went short by.
    const limiter = new RateLimiter(100 * KB)
    await limiter.consume(100 * KB)

    const started = Date.now()
    await limiter.consume(50 * KB)
    const waited = Date.now() - started

    ok(waited >= 300, `expected a real wait, waited ${waited}ms`)
    ok(waited < 3000, `expected the wait to end, waited ${waited}ms`)
  })

  it('ignores an empty read', async () => {
    const limiter = new RateLimiter(1)
    await limiter.consume(0)
    await limiter.consume(-10)
  })

  it('abandons a wait the moment the task is stopped', async () => {
    const limiter = new RateLimiter(10)
    await limiter.consume(10)

    const controller = new AbortController()
    const pending = limiter.consume(10_000, controller.signal)
    controller.abort()

    await rejects(pending, /aborted/, 'pause must not have to wait out the bucket')
    await rejects(limiter.consume(1, controller.signal), /aborted/, 'an already-aborted signal fails at once')
  })
})

describe('RateLimiter quota', () => {
  it('reports nothing to spend when no quota is set', () => {
    strictEqual(new RateLimiter().quotaRemaining, null)
  })

  it('counts down and then refuses', async () => {
    const limiter = new RateLimiter()
    limiter.setQuota(1000, 60_000)

    await limiter.consume(600)
    strictEqual(limiter.quotaRemaining, 400)

    // Thrown rather than waited out: holding an open socket until the window
    // rolls over just loses the download to a body timeout instead.
    await rejects(() => limiter.consume(600), QuotaExceededError)
    strictEqual(limiter.quotaRemaining, 0)
  })

  it('names the moment the budget comes back', async () => {
    const limiter = new RateLimiter()
    limiter.setQuota(100, 60_000)

    const error = await limiter.consume(200).then(() => null, (err) => err)
    ok(error instanceof QuotaExceededError)
    ok(error.resumesAt > Date.now(), 'the manager parks the task until then')
    ok(error.resumesAt <= Date.now() + 60_000)
  })

  it('rolls the window over rather than sliding it', async () => {
    const limiter = new RateLimiter()
    limiter.setQuota(1000, 50)
    await limiter.consume(900)

    await new Promise((resolve) => setTimeout(resolve, 80))

    strictEqual(limiter.quotaRemaining, 1000, 'a new window starts whole')
    await limiter.consume(900)
  })

  it('charges a child limiter against the app-wide budget', async () => {
    // Cat mode runs at a trickle of its own, but the transfer allowance belongs
    // to the app: a private limiter must not spend it uncounted.
    const app = new RateLimiter()
    app.setQuota(1000, 60_000)
    const cat = new RateLimiter(1 * KB, app)

    await cat.consume(400)

    strictEqual(app.quotaRemaining, 600)
    strictEqual(cat.quotaRemaining, null, 'the child keeps no budget of its own')
  })

  it('cannot spend past the parent rate, however wide its own is', async () => {
    // The hole this closes: three queues each capped at 200 KB/s used to move
    // 600 between them, because only the parent's *quota* was being charged.
    const app = new RateLimiter(100 * KB)
    await app.consume(100 * KB)

    const queue = new RateLimiter(10 * 1024 * KB, app)
    const started = Date.now()
    await queue.consume(50 * KB)
    const waited = Date.now() - started

    ok(waited >= 300, `a child must wait for the app's bucket too, waited ${waited}ms`)
  })

  it('charges the parent quota exactly once', async () => {
    const app = new RateLimiter()
    app.setQuota(1000, 60_000)
    const child = new RateLimiter(null, app)

    await child.consume(400)

    strictEqual(app.quotaRemaining, 600, 'not 200 - the parent is charged one time')
  })

  it('does not charge itself for bytes the parent refused', async () => {
    const app = new RateLimiter()
    app.setQuota(100, 60_000)
    const child = new RateLimiter(null, app)
    child.setQuota(10_000, 60_000)

    await rejects(() => child.consume(500), QuotaExceededError)
    strictEqual(child.quotaRemaining, 10_000, 'nothing moved, so nothing was spent here')
  })

  it('restores a saved window, and refuses one that cannot be true', () => {
    const limiter = new RateLimiter()
    limiter.setQuota(1000, 60_000)
    limiter.restoreQuota({ used: 250, startedAt: Date.now() - 1000 })
    strictEqual(limiter.quotaRemaining, 750, 'a restart does not hand back a spent allowance')

    limiter.restoreQuota({ used: -5, startedAt: Date.now() })
    strictEqual(limiter.quotaRemaining, 750, 'a negative spend is ignored')

    limiter.restoreQuota({ used: 10, startedAt: Date.now() + 60_000 })
    strictEqual(limiter.quotaRemaining, 750, 'a window starting in the future is ignored')

    limiter.restoreQuota(null)
    strictEqual(limiter.quotaRemaining, 750)
  })

  it('starts a fresh window when the quota is changed', async () => {
    const limiter = new RateLimiter()
    limiter.setQuota(1000, 60_000)
    await limiter.consume(900)

    limiter.setQuota(2000, 60_000)
    strictEqual(limiter.quotaRemaining, 2000)
  })
})
