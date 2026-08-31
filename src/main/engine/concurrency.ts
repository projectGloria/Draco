/** Runs asynchronous work with a fixed upper bound and preserves input order. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return []

  const results = new Array<R>(values.length)
  let cursor = 0
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(limit)))

  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= values.length) return
      results[index] = await worker(values[index], index)
    }
  }))

  return results
}
