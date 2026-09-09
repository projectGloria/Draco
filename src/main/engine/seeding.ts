/**
 * When a finished torrent may stop seeding.
 *
 * Draco used to tear the swarm connection down the instant the last selected
 * byte arrived, which is the one thing a BitTorrent client must not do: the
 * download only worked because other people were still seeding, and a client
 * that always leaves is a client every private tracker eventually bans.
 *
 * Kept free of webtorrent and of Electron so the rule itself can be tested
 * without a swarm - see `tests/seeding.test.ts`.
 */

export interface SeedTargets {
  /** Stop once uploaded/downloaded reaches this, or null to ignore ratio. */
  ratioLimit: number | null
  /** Stop after this many minutes of seeding, or null to ignore the clock. */
  minutes: number | null
}

export interface SeedProgress {
  /** Bytes sent to peers during and after the download. */
  uploaded: number
  ratio: number
  /** Epoch ms at which seeding began. */
  startedAt: number
}

/**
 * Whether either target has been met. Targets are a floor, not a schedule:
 * with both set, the *first* one reached stops the seed, because each is a
 * separate answer to "I have given enough back".
 *
 * With neither set, seeding runs until the user stops it or the app quits.
 * That is deliberate - "seed forever" is a legitimate choice, and the setting
 * that turns seeding off entirely is a different one.
 */
export function seedTargetReached(progress: SeedProgress, targets: SeedTargets, now: number): boolean {
  if (targets.ratioLimit !== null && targets.ratioLimit > 0 && progress.ratio >= targets.ratioLimit) {
    return true
  }
  if (targets.minutes !== null && targets.minutes > 0) {
    // A startedAt in the future (a clock correction, a restored session) must
    // not read as "already seeded for hours"; treat it as just begun.
    const elapsed = Math.max(0, now - progress.startedAt)
    if (elapsed >= targets.minutes * 60_000) return true
  }
  return false
}

/**
 * The line shown under a seeding row. It reports the ratio because that is the
 * number a tracker judges, and names the target so the row explains when it
 * will stop on its own.
 */
export function describeSeeding(progress: SeedProgress, targets: SeedTargets): string {
  const ratio = progress.ratio.toFixed(2)
  if (targets.ratioLimit !== null && targets.ratioLimit > 0) {
    return `${SEEDING_PREFIX}ratio ${ratio} of ${targets.ratioLimit.toFixed(2)}`
  }
  if (targets.minutes !== null && targets.minutes > 0) {
    const left = Math.max(0, targets.minutes * 60_000 - (Date.now() - progress.startedAt))
    return `${SEEDING_PREFIX}ratio ${ratio} · ${Math.ceil(left / 60_000)} min left`
  }
  return `${SEEDING_PREFIX}ratio ${ratio}`
}

/** How every seeding line starts, so one can be recognised again later. */
const SEEDING_PREFIX = 'Seeding · '

/**
 * Whether a stored detail line was written by a seed.
 *
 * `detail` is persisted with the task, and seeding does not survive a restart -
 * the swarm connection is gone with the process. Without this the restored row
 * would sit there claiming to seed at a ratio nothing is updating any more.
 */
export function isSeedingDetail(detail: string | null | undefined): boolean {
  return typeof detail === 'string' && detail.startsWith(SEEDING_PREFIX)
}
