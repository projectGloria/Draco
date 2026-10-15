/** Bound complete encrypted HLS pieces across every task in this process. */
const MAX_BUFFERED_SEGMENTS = 4

interface Waiter {
  signal: AbortSignal
  resolve(release: () => void): void
  reject(error: Error): void
  onAbort(): void
}

let active = 0
const waiting: Waiter[] = []

function releasePermit(): void {
  for (;;) {
    const next = waiting.shift()
    if (!next) { active--; return }
    next.signal.removeEventListener('abort', next.onAbort)
    if (next.signal.aborted) {
      next.reject(new Error('Encrypted segment wait was cancelled'))
      continue
    }
    next.resolve(releaseOnce())
    return
  }
}

function releaseOnce(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    releasePermit()
  }
}

function acquire(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new Error('Encrypted segment wait was cancelled'))
  if (active < MAX_BUFFERED_SEGMENTS) {
    active++
    return Promise.resolve(releaseOnce())
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      signal, resolve, reject,
      onAbort() {
        const index = waiting.indexOf(waiter)
        if (index >= 0) waiting.splice(index, 1)
        signal.removeEventListener('abort', waiter.onAbort)
        reject(new Error('Encrypted segment wait was cancelled'))
      }
    }
    waiting.push(waiter)
    signal.addEventListener('abort', waiter.onAbort, { once: true })
    if (signal.aborted) waiter.onAbort()
  })
}

export async function withEncryptedSegmentSlot<T>(
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  const release = await acquire(signal)
  try {
    signal.throwIfAborted()
    return await operation()
  } finally {
    release()
  }
}
