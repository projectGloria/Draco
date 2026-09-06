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
   * A limiter whose quota is charged alongside this one's.
   *
   * Cat mode needs its own rate cap - a background trickle, not the user's full
   * speed - but the transfer budget belongs to the app, not to one limiter. A
   * private limiter with no quota of its own would spend the budget without
   * ever counting against it.
   */
  private readonly quotaParent: RateLimiter | null

  constructor(bytesPerSecond: number | null = null, quotaParent: RateLimiter | null = null) {
    this.quotaParent = quotaParent
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

    if (this.bytesPerSecond !== Infinity) {
      this.refill()
      this.tokens -= bytes

      while (this.tokens < 0) {
        const waitMs = Math.ceil((-this.tokens / this.bytesPerSecond) * 1000)
        await delay(Math.min(Math.max(waitMs, 5), 250), signal)
        this.refill()
      }
    }

    // The parent is charged first and unconditionally: its budget is the shared
    // one, and a child that stopped short of its own limit must still not be
    // able to spend past the app's.
    this.quotaParent?.chargeQuota(bytes)
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
