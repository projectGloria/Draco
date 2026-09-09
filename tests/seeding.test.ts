import { match, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeSeeding, isSeedingDetail, seedTargetReached, type SeedTargets } from '../src/main/engine/seeding.ts'

/**
 * When a finished torrent may stop giving back. Pure by design: the rule is
 * worth testing without a swarm, and the swarm is not worth testing here.
 */

const NOW = 1_700_000_000_000

function progress(ratio: number, minutesAgo = 0): { uploaded: number; ratio: number; startedAt: number } {
  return { uploaded: Math.round(ratio * 1000), ratio, startedAt: NOW - minutesAgo * 60_000 }
}

const noTargets: SeedTargets = { ratioLimit: null, minutes: null }

describe('seedTargetReached', () => {
  it('seeds indefinitely when neither target is set', () => {
    strictEqual(seedTargetReached(progress(50, 60 * 24), noTargets, NOW), false)
  })

  it('stops at the ratio target, and not before', () => {
    const targets: SeedTargets = { ratioLimit: 2, minutes: null }
    strictEqual(seedTargetReached(progress(1.99), targets, NOW), false)
    strictEqual(seedTargetReached(progress(2), targets, NOW), true, 'reaching the target is meeting it')
    strictEqual(seedTargetReached(progress(7.5), targets, NOW), true)
  })

  it('stops at the time target, and not before', () => {
    const targets: SeedTargets = { ratioLimit: null, minutes: 30 }
    strictEqual(seedTargetReached(progress(0.1, 29), targets, NOW), false)
    strictEqual(seedTargetReached(progress(0.1, 30), targets, NOW), true)
  })

  it('stops at whichever target comes first', () => {
    const targets: SeedTargets = { ratioLimit: 2, minutes: 60 }
    strictEqual(seedTargetReached(progress(2.5, 1), targets, NOW), true, 'ratio met, clock not')
    strictEqual(seedTargetReached(progress(0.1, 61), targets, NOW), true, 'clock met, ratio not')
    strictEqual(seedTargetReached(progress(0.1, 1), targets, NOW), false, 'neither')
  })

  it('ignores a target of zero or less rather than stopping immediately', () => {
    // A zero in the settings file means "no target"; treating it as one would
    // silently disable seeding for someone who never asked for that.
    strictEqual(seedTargetReached(progress(0), { ratioLimit: 0, minutes: null }, NOW), false)
    strictEqual(seedTargetReached(progress(0), { ratioLimit: -1, minutes: -5 }, NOW), false)
  })

  it('treats a start time in the future as just begun', () => {
    // A clock correction or a restored session must not read as hours of
    // seeding already served.
    const future = { uploaded: 0, ratio: 0, startedAt: NOW + 60 * 60_000 }
    strictEqual(seedTargetReached(future, { ratioLimit: null, minutes: 30 }, NOW), false)
  })
})

describe('describeSeeding', () => {
  it('always reports the ratio, because that is what a tracker judges', () => {
    match(describeSeeding(progress(0.5), noTargets), /ratio 0\.50/)
  })

  it('names the ratio target when there is one', () => {
    strictEqual(describeSeeding(progress(0.5), { ratioLimit: 2, minutes: null }), 'Seeding · ratio 0.50 of 2.00')
  })

  it('counts down when the target is a clock', () => {
    match(describeSeeding(progress(0.5), { ratioLimit: null, minutes: 30 }), /min left/)
  })
})

describe('isSeedingDetail', () => {
  it('recognises its own lines, so a restored row stops claiming to seed', () => {
    strictEqual(isSeedingDetail(describeSeeding(progress(1.5), noTargets)), true)
    strictEqual(isSeedingDetail(describeSeeding(progress(1.5), { ratioLimit: 2, minutes: null })), true)
    strictEqual(isSeedingDetail(describeSeeding(progress(1.5), { ratioLimit: null, minutes: 30 })), true)
  })

  it('leaves any other detail line alone', () => {
    // A finished download can carry a real message worth keeping across a
    // restart; only the seeding line is stale by definition.
    strictEqual(isSeedingDetail('Video complete; 2 subtitle track(s) failed'), false)
    strictEqual(isSeedingDetail(null), false)
    strictEqual(isSeedingDetail(undefined), false)
  })
})
