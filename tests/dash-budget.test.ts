import { ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitConnectionBudget } from '../src/main/engine/connection-budget.ts'
import { ConnectionRamp } from '../src/main/engine/ramp.ts'

/**
 * The regression these guard is the one that made every YouTube video+audio
 * download run at a fixed four connections per stream: an even split with no
 * ceiling, handed to a ramp that marks itself finished when it starts where it
 * is meant to stop.
 */
describe('splitConnectionBudget', () => {
  it('gives the video half the larger share', () => {
    const budget = splitConnectionBudget(8)
    strictEqual(budget.audio, 2)
    strictEqual(budget.video, 6)
    // An audio track is a fraction of the bytes; spending half the allowance on
    // it starves the half that decides when the download ends.
    ok(budget.video > budget.audio)
  })

  it('leaves the ramp somewhere to climb to', () => {
    const budget = splitConnectionBudget(8, 16)
    ok(budget.videoCeiling > budget.video, 'video can climb')
    strictEqual(budget.videoCeiling + budget.audioCeiling, 16, 'the whole ceiling is spent')
  })

  it('never hands out fewer than one connection', () => {
    for (const connections of [1, 2, 3]) {
      const budget = splitConnectionBudget(connections)
      ok(budget.video >= 1, `video at ${connections}`)
      ok(budget.audio >= 1, `audio at ${connections}`)
    }
  })

  it('treats a ceiling below the configured maximum as no ceiling', () => {
    const budget = splitConnectionBudget(8, 2)
    strictEqual(budget.videoCeiling, 6)
    strictEqual(budget.audioCeiling, 2)
  })

  it('produces a ramp that is actually able to move', () => {
    // The bug in one assertion: `ConnectionRamp` is born `settled` when it
    // starts at its target, which is what an absent ceiling used to guarantee.
    const budget = splitConnectionBudget(8, 16)
    const target = Math.max(budget.video, budget.videoCeiling)
    const ramp = new ConnectionRamp(Math.min(4, target), target)
    strictEqual(ramp.settled, false, 'a fresh ramp has room above it')

    const broken = new ConnectionRamp(4, 4)
    strictEqual(broken.settled, true, 'and this is what it used to be handed')
  })
})
