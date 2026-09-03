/**
 * Decides how many connections a download actually wants.
 *
 * The configured maximum is a ceiling, not an instruction. Whether it helps is
 * a property of the server and the link, not of the setting: an origin that
 * already saturates the line on four connections gains nothing from eight, and
 * pays for them in requests, TLS handshakes, a part file scattered across more
 * NTFS extents, and a far better chance of being rate-limited. Meanwhile the
 * origin that throttles each connection individually wants every one it can
 * get. No fixed number is right for both, which is why this climbs.
 *
 * The rule is the obvious one and the measurement is the hard part: take a
 * rung, watch what throughput does, keep the rung only if it earned itself.
 * Two things make the reading trustworthy -
 *
 * - a settling delay before the first measurement, because TCP slow start and
 *   connection setup make the opening second unrepresentative of anything, and
 * - a gain threshold rather than a plain comparison, so ordinary jitter cannot
 *   be mistaken for a rung having paid off.
 *
 * Coming back down is not symmetrical with going up and does not need to be.
 * Nothing is torn down: the cap simply stops being refilled, so the extra
 * connections retire as their segments finish. That makes a wrong guess cheap,
 * which is what makes guessing at all reasonable.
 */

export interface ConnectionRampOptions {
  /** Ignored before the first measurement - see the settling note above. */
  settleMs?: number
  /** How long each rung is watched before it is judged. */
  rungMs?: number
  /** Throughput multiple a rung must reach to be kept. */
  minGain?: number
}

const DEFAULTS = {
  settleMs: 1000,
  rungMs: 2000,
  minGain: 1.1
} as const

export class ConnectionRamp {
  private current: number
  private readonly target: number
  private readonly settleMs: number
  private readonly rungMs: number
  private readonly minGain: number

  private state: 'settling' | 'measuring' | 'done'
  private windowAt = 0
  private windowReceived = 0
  /** Throughput of the rung being stood on, or 0 before the first reading. */
  private standing = 0
  /** The rung to fall back to when the one above fails to pay for itself. */
  private below: number

  constructor(start: number, target: number, options: ConnectionRampOptions = {}) {
    this.target = Math.max(1, Math.floor(target))
    this.current = Math.max(1, Math.min(Math.floor(start), this.target))
    this.below = this.current
    this.settleMs = options.settleMs ?? DEFAULTS.settleMs
    this.rungMs = options.rungMs ?? DEFAULTS.rungMs
    this.minGain = options.minGain ?? DEFAULTS.minGain
    // Nothing above to try means nothing to measure, and no reason to pay for
    // the sampling at all.
    this.state = this.current >= this.target ? 'done' : 'settling'
  }

  get cap(): number {
    return this.current
  }

  get settled(): boolean {
    return this.state === 'done'
  }

  /** Begins the settling delay. Called when the first byte can arrive. */
  begin(now: number, received: number): void {
    if (this.state === 'done') return
    this.state = 'settling'
    this.windowAt = now
    this.windowReceived = received
  }

  /**
   * The server refused another connection. Its verdict outranks anything
   * throughput has to say, and climbing again would only re-provoke it.
   */
  stop(): void {
    this.state = 'done'
  }

  /**
   * Feeds the ramp the task's running byte total. Returns true when the cap
   * changed, which is the caller's cue to open or stop replacing connections.
   */
  sample(now: number, received: number): boolean {
    if (this.state === 'done') return false

    if (this.state === 'settling') {
      if (now - this.windowAt < this.settleMs) return false
      this.state = 'measuring'
      this.windowAt = now
      this.windowReceived = received
      return false
    }

    const elapsed = now - this.windowAt
    if (elapsed < this.rungMs) return false

    const speed = ((received - this.windowReceived) / elapsed) * 1000
    const previous = this.standing
    this.standing = speed
    this.windowAt = now
    this.windowReceived = received

    // A stalled rung says nothing about how many connections are wanted, only
    // that the transfer is not moving. Leave the cap alone and read again.
    if (speed <= 0) {
      this.standing = previous
      return false
    }

    // The opening rung has nothing to be judged against; it is the baseline
    // every rung above it is measured by.
    if (previous > 0 && speed < previous * this.minGain) {
      this.state = 'done'
      if (this.below < this.current) {
        this.current = this.below
        return true
      }
      return false
    }

    if (this.current >= this.target) {
      this.state = 'done'
      return false
    }

    this.below = this.current
    this.current = Math.min(this.target, this.current * 2)
    return true
  }
}
