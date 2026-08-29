import type { Segment } from '../../shared/types.ts'

/**
 * IDM's actual trick, and the reason this engine is hand-written rather than a
 * wrapper around aria2.
 *
 * Naive downloaders cut the file into N equal pieces up front. That is only
 * optimal if all N connections run at the same speed, which they never do: one
 * mirror stalls, another finishes early, and the whole download waits on the
 * slowest piece while connections sit idle.
 *
 * Instead, start with a single range and split *on demand*. Every time a
 * connection frees up, find the segment with the most work left and hand half of
 * its remaining bytes to the idle connection. Fast connections therefore keep
 * stealing work from slow ones, and the tail converges.
 *
 * Splitting only ever moves a segment's `end` backwards into bytes that have not
 * been written yet, so a worker mid-flight simply stops early - see `worker.ts`.
 */
export class Segmenter {
  readonly segments: Segment[] = []

  /**
   * @param size Total bytes, or null when the server would not say - in which
   *   case there is exactly one segment and no splitting is possible.
   * @param minSplitSize A segment is only cut when both halves would be at least
   *   this large. Splitting into slivers costs more in request overhead than it
   *   wins back in parallelism.
   */
  private size: number | null
  private readonly minSplitSize: number

  constructor(size: number | null, minSplitSize: number) {
    this.size = size
    this.minSplitSize = minSplitSize
    this.segments.push({
      start: 0,
      end: size !== null && size > 0 ? size - 1 : -1,
      position: 0,
      active: false
    })
  }

  /** Rebuilds from a journal rather than starting fresh. */
  static restore(segments: Segment[], size: number | null, minSplitSize: number): Segmenter {
    const s = new Segmenter(size, minSplitSize)
    s.segments.length = 0
    for (const seg of segments) {
      s.segments.push({ ...seg, active: false })
    }
    if (s.segments.length === 0) {
      s.segments.push({ start: 0, end: size !== null && size > 0 ? size - 1 : -1, position: 0, active: false })
    }
    return s
  }

  /** Bytes this segment still owes. An open-ended segment always owes work. */
  static remaining(seg: Segment): number {
    if (seg.end < 0) return Infinity
    return seg.end - seg.position + 1
  }

  /** Total bytes written across every segment. */
  get received(): number {
    let total = 0
    for (const seg of this.segments) total += seg.position - seg.start
    return total
  }

  get activeCount(): number {
    let n = 0
    for (const seg of this.segments) if (seg.active) n++
    return n
  }

  get complete(): boolean {
    return this.segments.every((seg) => seg.end >= 0 && seg.position > seg.end)
  }

  /**
   * A segment nobody is working on that still has bytes owing - either the very
   * first one, or one whose connection died and left work behind.
   */
  nextIdle(): Segment | null {
    for (const seg of this.segments) {
      if (!seg.active && Segmenter.remaining(seg) > 0) return seg
    }
    return null
  }

  /**
   * Splits the busiest segment and returns the new tail, or null when nothing is
   * worth cutting. The caller hands the result to an idle connection.
   */
  split(): Segment | null {
    // Unknown length means one open-ended range; there is no midpoint to find.
    if (this.size === null) return null

    let target: Segment | null = null
    let best = 0

    for (const seg of this.segments) {
      const remaining = Segmenter.remaining(seg)
      if (remaining > best) {
        best = remaining
        target = seg
      }
    }

    // Require room for two viable halves, so the split never produces a sliver.
    if (!target || best < this.minSplitSize * 2) return null

    const mid = target.position + Math.floor(best / 2)
    const tail: Segment = {
      start: mid,
      end: target.end,
      position: mid,
      active: false
    }

    // Shrinking `end` is what tells the in-flight worker to stop early.
    target.end = mid - 1

    this.segments.splice(this.segments.indexOf(target) + 1, 0, tail)
    return tail
  }

  /**
   * Called when the total length only becomes known mid-download (a server that
   * refused HEAD but sent Content-Length on the real GET).
   */
  setSize(size: number): void {
    if (this.size !== null || this.segments.length !== 1) return
    this.size = size
    this.segments[0].end = size - 1
  }

  /** Plain snapshot for the journal and the renderer. */
  snapshot(): Segment[] {
    return this.segments.map((seg) => ({ ...seg }))
  }
}
