import test from 'node:test'
import assert from 'node:assert/strict'
import { ConnectionRamp } from '../src/main/engine/ramp.ts'

/**
 * Drives a ramp against a server whose throughput is a function of how many
 * connections it is being given, sampling on the same 250 ms cadence the
 * manager's ticker uses. Returns every cap the ramp asked for, in order.
 */
function drive(ramp, throughputFor, { ms = 9000, stepMs = 250 } = {}) {
  let now = 0
  let received = 0
  ramp.begin(now, received)

  const changes = []
  while (now < ms) {
    received += (throughputFor(ramp.cap) * stepMs) / 1000
    now += stepMs
    if (ramp.sample(now, received)) changes.push({ at: now, cap: ramp.cap })
  }
  return changes
}

test('a ceiling at or below the opening rung is taken as given, unmeasured', () => {
  const ramp = new ConnectionRamp(4, 4)
  assert.equal(ramp.cap, 4)
  assert.equal(ramp.settled, true)

  // Nothing to try means nothing to sample, however long it runs.
  assert.deepEqual(drive(ramp, () => 50e6), [])
  assert.equal(ramp.cap, 4)
})

test('a server that saturates early keeps the connections it was already using', () => {
  const ramp = new ConnectionRamp(4, 8)
  // Throughput is the link's, not the server's per-connection allowance: the
  // eight connections move exactly what the four did.
  const changes = drive(ramp, () => 10e6)

  assert.deepEqual(changes.map((c) => c.cap), [8, 4])
  assert.equal(ramp.cap, 4, 'the rung that paid for nothing is given back')
  assert.equal(ramp.settled, true)
})

test('a server that throttles each connection is climbed to the ceiling', () => {
  const ramp = new ConnectionRamp(4, 16)
  const changes = drive(ramp, (cap) => cap * 5e6)

  assert.deepEqual(changes.map((c) => c.cap), [8, 16])
  assert.equal(ramp.cap, 16)
  assert.equal(ramp.settled, true)
})

test('the opening second is never the rung that gets judged', () => {
  const ramp = new ConnectionRamp(4, 8, { settleMs: 1000, rungMs: 2000 })
  ramp.begin(0, 0)

  // A stretch long enough to be a whole rung, but inside the settling window:
  // slow start makes it unrepresentative, so it must decide nothing.
  assert.equal(ramp.sample(900, 90e6), false)
  assert.equal(ramp.cap, 4)
  assert.equal(ramp.settled, false)
})

test('a refusal outranks throughput and ends the climb where it stands', () => {
  const ramp = new ConnectionRamp(4, 16)
  ramp.begin(0, 0)
  ramp.sample(1000, 0)

  // The server answered a connection with 429 while the rung was being read.
  ramp.stop()
  assert.equal(ramp.settled, true)

  assert.equal(ramp.sample(3000, 100e6), false)
  assert.equal(ramp.cap, 4, 'no rung is taken after the server has said no')
})

test('a stalled rung reports nothing rather than a verdict of nothing', () => {
  const ramp = new ConnectionRamp(4, 8)
  const changes = drive(ramp, () => 0)

  assert.deepEqual(changes, [])
  assert.equal(ramp.cap, 4)
  assert.equal(ramp.settled, false, 'a transfer that is not moving has not been measured')
})
