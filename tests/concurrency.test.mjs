import test from 'node:test'
import assert from 'node:assert/strict'
import { mapConcurrent } from '../src/main/engine/concurrency.ts'

test('bounded async mapping preserves order and never exceeds its limit', async () => {
  let active = 0
  let peak = 0
  const values = Array.from({ length: 20 }, (_, index) => index)

  const results = await mapConcurrent(values, 3, async (value) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, value % 3))
    active--
    return value * 2
  })

  assert.equal(peak, 3)
  assert.deepEqual(results, values.map((value) => value * 2))
})
