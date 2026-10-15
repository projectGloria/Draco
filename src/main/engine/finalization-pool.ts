interface Waiter {
  signal: AbortSignal
  resolve: (release: (() => void) | null) => void
  onAbort: () => void
}

/** Caps post-transfer work without occupying a download connection slot. */
export class FinalizationPool {
  private active = 0
  private waiters: Waiter[] = []
  private readonly limit: number

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Finalization limit must be positive')
    this.limit = limit
  }

  get saturated(): boolean {
    return this.active >= this.limit
  }

  acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null)
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve(this.releaseOnce())
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        signal,
        resolve,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) this.waiters.splice(index, 1)
          signal.removeEventListener('abort', waiter.onAbort)
          resolve(null)
        }
      }
      this.waiters.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      if (signal.aborted) waiter.onAbort()
    })
  }

  /** A quit lets active checks finish but leaves queued ones recoverable. */
  cancelPending(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve(null)
    }
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      while (this.active < this.limit && this.waiters.length > 0) {
        const waiter = this.waiters.shift()!
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        if (waiter.signal.aborted) {
          waiter.resolve(null)
          continue
        }
        this.active++
        waiter.resolve(this.releaseOnce())
      }
    }
  }
}
