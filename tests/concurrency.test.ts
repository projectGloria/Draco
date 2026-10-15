import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { mapConcurrent } from '../src/main/engine/concurrency.ts'

test('failed concurrent work waits for active writes and stops taking new jobs', async () => {
  let fail!: () => void
  let release!: () => void
  const failure = new Promise<void>((resolve) => { fail = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const visited: number[] = []
  let stopped = false
  let settled = false
  const expected = new Error('disk full')
  const pending = mapConcurrent([0, 1, 2, 3], 2, async (index) => {
    visited.push(index)
    if (index === 0) {
      await failure
      throw expected
    }
    await gate
    stopped = true
  })
  const checked = rejects(pending, (error) => {
    strictEqual(error, expected)
    strictEqual(stopped, true)
    return true
  }).then(() => { settled = true })
  fail()
  await new Promise((resolve) => setImmediate(resolve))
  strictEqual(settled, false, 'cleanup must not run while a write is pending')
  deepStrictEqual(visited, [0, 1])
  release()
  await checked
})

test('concurrent work preserves order and rejects invalid worker counts', async () => {
  deepStrictEqual(await mapConcurrent([3, 2, 1], 2, async (value) => value * 2), [6, 4, 2])
  for (const limit of [NaN, Infinity, 0, -1]) {
    await rejects(mapConcurrent([1], limit, async (value) => value), RangeError)
  }
})
