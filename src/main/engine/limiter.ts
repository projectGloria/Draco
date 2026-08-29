/**
 * A token bucket shared by every connection in the app, so the speed cap is a
 * global budget rather than a per-socket one.
 *
 * Workers call `consume()` *after* reading a chunk. Because they await it before
 * pulling the next chunk from the stream, backpressure propagates down to the
 * socket on its own - there is no separate throttling machinery.
 */
export class RateLimiter {
  private bytesPerSecond = Infinity
  private tokens = Infinity
  private lastRefill = Date.now()

  constructor(bytesPerSecond: number | null = null) {
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
    if (this.bytesPerSecond === Infinity || bytes <= 0) return
    if (signal?.aborted) throw new Error('aborted')

    this.refill()
    this.tokens -= bytes

    while (this.tokens < 0) {
      const waitMs = Math.ceil((-this.tokens / this.bytesPerSecond) * 1000)
      await delay(Math.min(Math.max(waitMs, 5), 250), signal)
      this.refill()
    }
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
