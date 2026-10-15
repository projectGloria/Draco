import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { withEncryptedSegmentSlot } from '../src/main/hls/encrypted-pool.ts'

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

test('encrypted HLS buffers share a four-segment process cap', async () => {
  const gates = Array.from({ length: 10 }, gate)
  let active = 0
  let maximum = 0
  const jobs = gates.map((item) => withEncryptedSegmentSlot(new AbortController().signal, async () => {
    active++
    maximum = Math.max(maximum, active)
    await item.promise
    active--
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(active, 4)
  for (const item of gates) item.release()
  await Promise.all(jobs)
  assert.equal(maximum, 4)
  assert.equal(active, 0)
})

test('cancelled encrypted segment waits leave the permit queue', async () => {
  const blockers = Array.from({ length: 4 }, gate)
  const running = blockers.map((item) => withEncryptedSegmentSlot(new AbortController().signal, () => item.promise))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const controller = new AbortController()
  let launched = false
  const waiting = withEncryptedSegmentSlot(controller.signal, async () => { launched = true })
  controller.abort()
  await assert.rejects(waiting, /cancelled/)
  for (const item of blockers) item.release()
  await Promise.all(running)
  assert.equal(launched, false)
})
