import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Segmenter } from '../src/main/engine/segmenter.ts'
import type { Segment } from '../src/shared/types.ts'

/**
 * The dynamic segmenter is the reason this engine is hand-written, so these
 * tests pin the two properties everything else assumes: segments always tile
 * the file with no gaps and no overlap, and a split only ever moves an `end`
 * backwards into bytes nobody has written yet.
 */

/** Fails unless the segments cover 0..size-1 exactly once, in order. */
function assertTiles(segments: Segment[], size: number): void {
  let expected = 0
  for (const seg of segments) {
    strictEqual(seg.start, expected, 'segments must be contiguous')
    ok(seg.end >= seg.start, 'a segment must own at least one byte')
    expected = seg.end + 1
  }
  strictEqual(expected, size, 'segments must reach the end of the file')
}

describe('Segmenter', () => {
  it('starts as one range over the whole file', () => {
    const segmenter = new Segmenter(1000, 100)
    deepStrictEqual(segmenter.segments, [{ start: 0, end: 999, position: 0, active: false }])
    strictEqual(segmenter.received, 0)
    strictEqual(segmenter.complete, false)
  })

  it('halves the remaining bytes while nothing has been measured', () => {
    const segmenter = new Segmenter(1000, 100)
    const tail = segmenter.split()

    ok(tail)
    strictEqual(tail.start, 500)
    strictEqual(tail.position, 500, 'a fresh tail has written nothing')
    strictEqual(segmenter.segments[0].end, 499, 'the incumbent gives up the bytes it no longer owns')
    assertTiles(segmenter.segments, 1000)
  })

  it('splits from the current position, never from the start', () => {
    const segmenter = new Segmenter(1000, 100)
    segmenter.segments[0].position = 600

    const tail = segmenter.split()
    ok(tail)
    strictEqual(tail.start, 800, 'half of what is *left*, not half of the file')
    ok(tail.start > segmenter.segments[0].position, 'never hands out bytes already written')
    assertTiles(segmenter.segments, 1000)
  })

  it('refuses to cut a segment that cannot yield two viable halves', () => {
    // 150 bytes left against a 100-byte minimum: either half would be a sliver.
    strictEqual(new Segmenter(150, 100).split(), null)
    // Exactly twice the minimum is the smallest cut worth making.
    ok(new Segmenter(200, 100).split())
  })

  it('cannot split an unknown length', () => {
    const segmenter = new Segmenter(null, 100)
    strictEqual(segmenter.segments[0].end, -1)
    strictEqual(Segmenter.remaining(segmenter.segments[0]), Infinity, 'open-ended always owes work')
    strictEqual(segmenter.split(), null)
  })

  it('takes a length learned mid-download, but only once', () => {
    const segmenter = new Segmenter(null, 100)
    segmenter.setSize(500)
    strictEqual(segmenter.segments[0].end, 499)

    segmenter.setSize(900)
    strictEqual(segmenter.segments[0].end, 499, 'a second answer is ignored')
  })

  it('cuts the segment that would finish last, not the one holding the most', () => {
    const segmenter = new Segmenter(10_000, 100)
    const tail = segmenter.split()
    ok(tail)

    // The head is left holding more bytes, but it is moving; the tail is not.
    segmenter.observe(0)
    segmenter.segments[0].position = 4_900
    tail.position = 5_010
    segmenter.observe(1_000)

    const third = segmenter.split()
    ok(third)
    ok(third.start > tail.position, 'the slow tail is the one that got cut')
    ok(third.start < 9_000, 'and it gave away most of what it had left')
    assertTiles(segmenter.segments, 10_000)
  })

  it('counts only what each segment has written', () => {
    const segmenter = new Segmenter(1000, 100)
    const tail = segmenter.split()
    ok(tail)
    segmenter.segments[0].position = 300
    tail.position = 700

    strictEqual(segmenter.received, 500, '300 written by the head, 200 by the tail')
  })

  it('is complete only when every segment has passed its own end', () => {
    const segmenter = new Segmenter(1000, 100)
    const tail = segmenter.split()
    ok(tail)

    segmenter.segments[0].position = 500
    strictEqual(segmenter.complete, false, 'the head is done but the tail is not')
    tail.position = 1000
    strictEqual(segmenter.complete, true)
  })

  it('treats a zero-length file as already complete', () => {
    strictEqual(new Segmenter(0, 100).complete, true)
  })

  it('restores from a journal with nothing marked active', () => {
    const segmenter = Segmenter.restore(
      [
        { start: 0, end: 499, position: 200, active: true },
        { start: 500, end: 999, position: 500, active: true }
      ],
      1000,
      100
    )

    strictEqual(segmenter.segments.length, 2)
    strictEqual(segmenter.activeCount, 0, 'nothing is running after a restart')
    strictEqual(segmenter.received, 200)
    strictEqual(segmenter.nextIdle(), segmenter.segments[0], 'the unfinished head is picked up first')
  })

  it('restores an empty snapshot as a fresh whole-file range', () => {
    const segmenter = Segmenter.restore([], 1000, 100)
    deepStrictEqual(segmenter.segments, [{ start: 0, end: 999, position: 0, active: false }])
  })

  it('offers no idle segment once every range is finished', () => {
    const segmenter = new Segmenter(1000, 100)
    segmenter.segments[0].position = 1000
    strictEqual(segmenter.nextIdle(), null)
  })
})
