/**
 * A token bucket shared by every connection in the app, so the speed cap is a
 * global budget rather than a per-socket one.
 *
 * Workers call `consume()` *after* reading a chunk. Because they await it before
 * pulling the next chunk from the stream, backpressure propagates down to the
 * socket on its own - there is no separate throttling machinery.
 */
export class RateLimiter {
  /** Bytes per second. Infinity means uncapped, which short-circuits everything. */
  private bytesPerSecond = Infinity
  private tokens = Infinity
  private lastRefill = Date.now()

  constructor(bytesPerSecond: number | null = null) {
    this.setLimit(bytesPerSecond)
  }

  /** null or a non-positive value removes the cap. */
  setLimit(bytesPerSecond: number | null): void {
    const next = bytesPerSecond && bytesPerSecond > 0 ? bytesPerSecond : Infinity
    if (next === this.bytesPerSecond) return

    this.bytesPerSecond = next
    // Start a newly-applied cap with a full bucket rather than a debt carried
    // over from the uncapped period.
    this.tokens = next === Infinity ? Infinity : next
    this.lastRefill = Date.now()
  }

  get limit(): number | null {
    return this.bytesPerSecond === Infinity ? null : this.bytesPerSecond
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.lastRefill = now

    if (this.bytesPerSecond === Infinity) {
      this.tokens = Infinity
      return
    }

    // One second of budget is the burst ceiling. Allowing more would let an idle
    // app bank credit and then blow far past the cap the moment it resumes.
    this.tokens = Math.min(this.bytesPerSecond, this.tokens + elapsed * this.bytesPerSecond)
  }

  /**
   * Blocks until `bytes` worth of budget has been paid for. The balance is
   * allowed to go negative so a chunk larger than one second of budget still
   * settles instead of deadlocking - it just waits proportionally longer.
   */
  async consume(bytes: number): Promise<void> {
    if (this.bytesPerSecond === Infinity || bytes <= 0) return

    this.refill()
    this.tokens -= bytes

    while (this.tokens < 0) {
      const waitMs = Math.ceil((-this.tokens / this.bytesPerSecond) * 1000)
      // Cap each nap so a cap raised mid-wait takes effect promptly.
      await delay(Math.min(Math.max(waitMs, 5), 250))
      this.refill()
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
