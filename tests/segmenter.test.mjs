import test from 'node:test'
import assert from 'node:assert/strict'

test('segmenter treats zero-byte files as complete', async () => {
  const { Segmenter } = await import('../src/main/engine/segmenter.ts')
  const s = new Segmenter(0, 1024)
  assert.equal(s.complete, true)
  assert.equal(s.received, 0)
})

test('segmenter closes an unknown-size stream when its final size is learned', async () => {
  const { Segmenter } = await import('../src/main/engine/segmenter.ts')
  const s = new Segmenter(null, 1024)
  s.segments[0].position = 1234
  s.setSize(1234)
  assert.equal(s.complete, true)
  assert.equal(s.received, 1234)
})

const MB = 1024 * 1024

/** Moves every segment at its own rate over the manager's real tick cadence. */
function drive(segmenter, ratesBps, { ticks = 12, stepMs = 250 } = {}) {
  let now = 0
  segmenter.observe(now)
  for (let i = 0; i < ticks; i++) {
    now += stepMs
    segmenter.segments.forEach((seg, index) => {
      const step = Math.round((ratesBps[index] * stepMs) / 1000)
      seg.position = Math.min(seg.end + 1, seg.position + step)
    })
    segmenter.observe(now)
  }
}

test('with nothing measured yet a split still lands on the midpoint', async () => {
  const { Segmenter } = await import('../src/main/engine/segmenter.ts')
  const s = new Segmenter(100 * MB, MB)

  const tail = s.split()
  assert.equal(tail.start, 50 * MB, 'equal rates are the assumption halving encodes')
  assert.equal(s.segments[0].end, 50 * MB - 1)
})

test('the segment that would finish last is cut, not the one holding most bytes', async () => {
  const { Segmenter } = await import('../src/main/engine/segmenter.ts')
  const s = new Segmenter(100 * MB, MB)
  s.split()

  // The first half runs ten times faster, so it ends up holding far fewer
  // bytes than the second - and would finish in two seconds against forty-odd.
  drive(s, [10 * MB, 1 * MB])
  const [fast, slow] = s.segments
  assert.ok(Segmenter.remaining(fast) < Segmenter.remaining(slow))

  const before = Segmenter.remaining(slow)
  const at = slow.position
  const tail = s.split()

  assert.equal(slow.end, tail.start - 1, 'the slow segment is the one that got cut')
  const kept = tail.start - at
  assert.ok(
    kept / before < 0.25,
    `a connection five times slower than average should keep well under half; kept ${(kept / before).toFixed(3)}`
  )
})

test('a fast connection keeps most of its own work instead of losing half', async () => {
  const { Segmenter } = await import('../src/main/engine/segmenter.ts')
  const s = Segmenter.restore(
    [
      { start: 0, end: 500 * MB - 1, position: 100 * MB, active: true },
      { start: 500 * MB, end: 510 * MB - 1, position: 500 * MB, active: true },
      { start: 510 * MB, end: 520 * MB - 1, position: 510 * MB, active: true }
    ],
    520 * MB,
    MB
  )

  // The long segment is also the quickest, but it still has by far the most
  // time left, so it is the one to cut.
  drive(s, [8 * MB, 1 * MB, 1 * MB])
  const long = s.segments[0]
  const before = Segmenter.remaining(long)
  const at = long.position
  const tail = s.split()

  assert.equal(long.end, tail.start - 1)
  const kept = tail.start - at
  assert.ok(
    kept / before > 0.6,
    `a connection well above the average rate should keep more than half; kept ${(kept / before).toFixed(3)}`
  )
})

test('no rate ratio can cut a sliver off either half', async () => {
  const { Segmenter } = await import('../src/main/engine/segmenter.ts')
  const s = Segmenter.restore(
    [
      { start: 0, end: 3 * MB - 1, position: 0, active: true },
      { start: 3 * MB, end: 200 * MB - 1, position: 0 + 3 * MB, active: true }
    ],
    200 * MB,
    MB
  )

  // A stalled crawl against a connection a thousand times its speed: the share
  // this implies is far below the minimum, so the clamp has to hold it.
  drive(s, [1024, 40 * MB])
  const crawler = s.segments[0]
  const at = crawler.position
  const remaining = Segmenter.remaining(crawler)
  const tail = s.split()

  assert.equal(crawler.end, tail.start - 1)
  assert.ok(tail.start - at >= MB, 'the incumbent keeps at least one minimum split')
  assert.ok(remaining - (tail.start - at) >= MB, 'and so does the tail it hands over')
})
