import type { Segment } from '../../shared/types.ts'

/**
 * How much of a new reading is folded into a segment's smoothed rate. Low
 * enough that one unlucky tick cannot condemn a connection, high enough that
 * one which has genuinely gone slow is recognised in a second or two.
 */
const RATE_SMOOTHING = 0.3
/** Anything shorter than this reads mostly as scheduling noise. */
const MIN_SAMPLE_MS = 200

interface RateSample {
  at: number
  position: number
  rate: number
}

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

  /**
   * Per-segment throughput, deliberately kept outside `Segment`: that shape is
   * written to the journal and handed to the renderer, and a measurement that
   * only means anything within one run belongs in neither.
   */
  private readonly rates = new WeakMap<Segment, RateSample>()

  /**
   * Optional byte offset requested by an in-progress reader (Watch while downloading).
   * When set, `nextIdle()` and `split()` prioritize the gap at or immediately after
   * this offset so playback or container probing (e.g. MP4 moov atom at EOF) never
   * waits on distant segments.
   */
  private priorityOffset: number | null = null

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

  /**
   * Folds each segment's progress since the last call into its smoothed rate.
   * Driven by the task's existing ticker, so nothing on the transfer path pays
   * for the measurement.
   */
  observe(now: number): void {
    for (const seg of this.segments) {
      const previous = this.rates.get(seg)
      if (!previous) {
        this.rates.set(seg, { at: now, position: seg.position, rate: 0 })
        continue
      }

      const elapsed = now - previous.at
      if (elapsed < MIN_SAMPLE_MS) continue

      const observed = ((seg.position - previous.position) / elapsed) * 1000
      this.rates.set(seg, {
        at: now,
        position: seg.position,
        rate:
          previous.rate === 0
            ? observed
            : previous.rate + (observed - previous.rate) * RATE_SMOOTHING
      })
    }
  }

  /** A segment's measured throughput, or 0 while it is still unmeasured. */
  private rateOf(seg: Segment): number {
    const sample = this.rates.get(seg)
    return sample && sample.rate > 0 ? sample.rate : 0
  }

  /**
   * What one connection on this transfer has been worth on average - the only
   * estimate available for a connection that has not started yet.
   */
  private typicalRate(): number {
    let total = 0
    let measured = 0
    for (const seg of this.segments) {
      const rate = this.rateOf(seg)
      if (rate > 0) {
        total += rate
        measured++
      }
    }
    return measured > 0 ? total / measured : 0
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
    if (this.size === 0) return true
    return this.segments.every((seg) => seg.end >= 0 && seg.position > seg.end)
  }

  /**
   * Returns how many contiguous bytes starting at `offset` are already written
   * on disk across adjacent segments. Returns > 0 when `offset` sits inside a
   * written region, or 0 when `offset` is still an unwritten hole.
   */
  contiguousBytesAt(offset: number): number {
    if (this.size !== null && offset >= this.size) return 0
    if (offset < 0) return 0

    let cursor = offset
    for (const seg of this.segments) {
      if (seg.end >= 0 && seg.end < cursor) continue
      if (seg.start > cursor) break
      if (cursor >= seg.position) return cursor - offset
      cursor = seg.position
      if (seg.end >= 0 && seg.position <= seg.end) {
        return cursor - offset
      }
    }
    return cursor - offset
  }

  /**
   * Directs the next available connection to prioritize downloading at `offset`.
   */
  prioritizeOffset(offset: number | null): void {
    this.priorityOffset = offset !== null && offset >= 0 ? Math.floor(offset) : null
  }

  /**
   * A segment nobody is working on that still has bytes owing - either the very
   * first one, or one whose connection died and left work behind.
   * When `priorityOffset` is set, prefers the idle segment covering or closest
   * after that offset.
   */
  nextIdle(): Segment | null {
    if (this.priorityOffset !== null) {
      const targetOffset = this.priorityOffset
      for (const seg of this.segments) {
        if (seg.active || Segmenter.remaining(seg) <= 0) continue
        if (seg.position <= targetOffset && (seg.end < 0 || targetOffset <= seg.end)) {
          this.priorityOffset = null
          return seg
        }
      }
      for (const seg of this.segments) {
        if (seg.active || Segmenter.remaining(seg) <= 0) continue
        if (seg.position >= targetOffset) {
          this.priorityOffset = null
          return seg
        }
      }
    }

    for (const seg of this.segments) {
      if (!seg.active && Segmenter.remaining(seg) > 0) return seg
    }
    return null
  }

  /**
   * Splits whichever segment would otherwise finish last and returns the new
   * tail, or null when nothing is worth cutting. The caller hands the result to
   * an idle connection.
   *
   * When `priorityOffset` falls inside an active segment's unwritten region,
   * splits directly at `priorityOffset` (leaving a safe write-buffer margin for
   * the active worker) so a reader waiting on that byte offset gets immediate
   * service.
   */
  split(): Segment | null {
    // Unknown length means one open-ended range; there is no midpoint to find.
    if (this.size === null) return null

    if (this.priorityOffset !== null) {
      const wanted = this.priorityOffset
      const margin = Math.min(this.minSplitSize, 256 * 1024)
      for (const seg of this.segments) {
        if (seg.end < 0 || wanted > seg.end) continue
        if (wanted >= seg.position + margin) {
          this.priorityOffset = null
          const tail: Segment = {
            start: wanted,
            end: seg.end,
            position: wanted,
            active: false
          }
          seg.end = wanted - 1
          this.segments.splice(this.segments.indexOf(seg) + 1, 0, tail)
          return tail
        }
      }
    }

    const typical = this.typicalRate()

    let target: Segment | null = null
    let targetRemaining = 0
    let worstEta = 0

    for (const seg of this.segments) {
      const remaining = Segmenter.remaining(seg)
      // Require room for two viable halves, so the split never produces a
      // sliver: the extra request would cost more than the parallelism wins.
      if (remaining < this.minSplitSize * 2) continue

      const rate = this.rateOf(seg)
      // An unmeasured segment is ranked as an ordinary one. Treating its zero
      // as a speed would rank it infinitely slow and always pick it.
      const eta = remaining / (rate > 0 ? rate : typical > 0 ? typical : 1)
      if (eta > worstEta) {
        worstEta = eta
        target = seg
        targetRemaining = remaining
      }
    }

    if (!target) return null

    const rate = this.rateOf(target)
    const share = rate > 0 && typical > 0 ? rate / (rate + typical) : 0.5
    // Both halves must clear the minimum. That also keeps the split point at
    // least `minSplitSize` ahead of `position`, which is the margin the worker
    // relies on to gather chunks before it writes them.
    const keep = Math.min(
      targetRemaining - this.minSplitSize,
      Math.max(this.minSplitSize, Math.round(targetRemaining * share))
    )

    const mid = target.position + keep
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
