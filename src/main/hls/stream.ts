/**
 * Pulls an HLS response one chunk at a time so disk backpressure and the global
 * rate limit are applied before more data is requested from the network.
 */
export async function streamResponseBody(
  body: ReadableStream<Uint8Array>,
  sink: (chunk: Buffer) => void | Promise<void>,
  consume: (bytes: number) => void | Promise<void>,
  signal: AbortSignal,
  onProgress?: (received: number) => void
): Promise<number> {
  const reader = body.getReader()
  let received = 0
  let completed = false
  try {
    for (;;) {
      if (signal.aborted) throw new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      await sink(chunk)
      received += chunk.length
      onProgress?.(received)
      await consume(chunk.length)
    }
    completed = true
    return received
  } finally {
    // Any early exit (abort, disk full, quota exceeded) must cancel the
    // stream, not just release the lock: otherwise undici keeps the socket
    // and keeps buffering the body until the body timeout, pinning pool
    // connections precisely when many transfers are failing at once.
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
