/**
 * A token bucket shared by every connection in the app, so the speed cap is a
 * global budget rather than a per-socket one.
 *
 * Workers call `consume()` *after* reading a chunk. Because they await it before
 * pulling the next chunk from the stream, backpressure propagates down to the
 * socket on its own - there is no separate throttling machinery.
 */
export interface QuotaState {
  used: number
  startedAt: number
}

/**
 * The rolling transfer budget is spent.
 *
 * Thrown rather than waited out. Sitting on the budget until the window rolls
 * over can mean an hour of holding an open socket that reads nothing, and
 * undici's `bodyTimeout` kills that long before the quota returns - so the user
 * lost the download to a timeout that had nothing to do with what happened.
 * Failing fast lets the manager park the task and start it again itself.
 */
export class QuotaExceededError extends Error {
  /** When the current window rolls over and the budget is whole again. */
  readonly resumesAt: number

  constructor(resumesAt: number) {
    super('Transfer quota reached')
    this.name = 'QuotaExceededError'
    this.resumesAt = resumesAt
  }
}

export class RateLimiter {
  private bytesPerSecond = Infinity
  private tokens = Infinity
  private lastRefill = Date.now()
  private quotaBytes = Infinity
  private quotaWindowMs = 60 * 60_000
  private quotaUsed = 0
  private quotaStartedAt = Date.now()
  /**
   * The limiter this one spends *through*.
   *
   * A child exists to be slower than the app in some particular way - cat
   * mode's background trickle, a queue the user capped - and everything it
   * spends is also spent by the app. So the parent's rate and the parent's
   * transfer budget both apply on top of this one's, and neither can be
   * escaped by having a private limiter.
   *
   * It used to charge only the parent's *quota*. That left a hole exactly where
   * per-queue limits needed to be honest: three capped queues could sail past
   * the app-wide speed limit between them, because nothing was asking the
   * parent for permission to move the bytes.
   */
  private readonly parent: RateLimiter | null

  constructor(bytesPerSecond: number | null = null, parent: RateLimiter | null = null) {
    this.parent = parent
    this.setLimit(bytesPerSecond)
  }

  setLimit(bytesPerSecond: number | null): void {
    const next = bytesPerSecond && bytesPerSecond > 0 ? bytesPerSecond : Infinity
    if (next === this.bytesPerSecond) return

    this.bytesPerSecond = next
    this.tokens = next === Infinity ? Infinity : next
    this.lastRefill = Date.now()
  }

  get limit(): number | null {
    return this.bytesPerSecond === Infinity ? null : this.bytesPerSecond
  }

  setQuota(bytes: number | null, windowMs: number): void {
    const nextBytes = bytes && bytes > 0 ? bytes : Infinity
    const nextWindow = Math.max(1, windowMs)
    if (nextBytes === this.quotaBytes && nextWindow === this.quotaWindowMs) return
    this.quotaBytes = nextBytes
    this.quotaWindowMs = nextWindow
    this.quotaUsed = 0
    this.quotaStartedAt = Date.now()
  }

  get quotaRemaining(): number | null {
    this.refillQuota()
    return this.quotaBytes === Infinity ? null : Math.max(0, this.quotaBytes - this.quotaUsed)
  }

  get quotaState(): QuotaState {
    this.refillQuota()
    return { used: this.quotaUsed, startedAt: this.quotaStartedAt }
  }

  restoreQuota(state: QuotaState | null): void {
    if (!state) return
    if (!Number.isSafeInteger(state.used) || state.used < 0) return
    if (!Number.isFinite(state.startedAt) || state.startedAt < 0 || state.startedAt > Date.now()) return
    this.quotaUsed = state.used
    this.quotaStartedAt = state.startedAt
    this.refillQuota()
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.lastRefill = now

    if (this.bytesPerSecond === Infinity) {
      this.tokens = Infinity
      return
    }

    this.tokens = Math.min(this.bytesPerSecond, this.tokens + elapsed * this.bytesPerSecond)
  }

  /**
   * Blocks until `bytes` worth of budget has been paid for.
   * `signal` lets pause/stop abort a long wait immediately.
   */
  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (bytes <= 0) return
    if (signal?.aborted) throw new Error('aborted')

    // The parent goes first, and is asked for the whole thing: its rate and its
    // quota are the app-wide budget, and a child that stayed inside its own cap
    // must still not be able to spend past the app's. A quota it cannot pay
    // throws from here, before this limiter charges itself for bytes that were
    // never allowed to move.
    if (this.parent) await this.parent.consume(bytes, signal)

    if (this.bytesPerSecond !== Infinity) {
      this.refill()
      this.tokens -= bytes

      while (this.tokens < 0) {
        const waitMs = Math.ceil((-this.tokens / this.bytesPerSecond) * 1000)
        await delay(Math.min(Math.max(waitMs, 5), 250), signal)
        this.refill()
      }
    }

    this.chargeQuota(bytes)
  }

  /** Spends `bytes` of this limiter's budget, throwing once it is gone. */
  private chargeQuota(bytes: number): void {
    if (this.quotaBytes === Infinity) return
    this.refillQuota()
    this.quotaUsed += bytes
    if (this.quotaUsed > this.quotaBytes) {
      throw new QuotaExceededError(this.quotaStartedAt + this.quotaWindowMs)
    }
  }

  private refillQuota(): void {
    const now = Date.now()
    if (now - this.quotaStartedAt < this.quotaWindowMs) return
    const windows = Math.floor((now - this.quotaStartedAt) / this.quotaWindowMs)
    this.quotaStartedAt += windows * this.quotaWindowMs
    this.quotaUsed = 0
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
