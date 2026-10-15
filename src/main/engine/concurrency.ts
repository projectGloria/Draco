/** Runs asynchronous work with a fixed upper bound and preserves input order. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return []
  if (!Number.isFinite(limit) || limit < 1) throw new RangeError('Concurrency limit must be positive')

  const results = new Array<R>(values.length)
  let cursor = 0
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(limit)))

  let failed = false
  let firstError: unknown
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = cursor++
      if (index >= values.length) return
      try {
        results[index] = await worker(values[index], index)
      } catch (error) {
        if (!failed) firstError = error
        failed = true
      }
    }
  }))
  // Cleanup is safe only after every worker has stopped touching its files.
  if (failed) throw firstError

  return results
}
