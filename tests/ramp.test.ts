import { strictEqual } from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  ConnectionRamp,
  clearLearnedHostCaps,
  getLearnedHostCap,
  recordLearnedHostCap
} from '../src/main/engine/ramp.ts'
import { getDispatcher, setPoolConnections } from '../src/main/engine/http.ts'

describe('ConnectionRamp', () => {
  it('starts clamped to target and reports cap', () => {
    const ramp = new ConnectionRamp(4, 16, { settleMs: 50, rungMs: 100, minGain: 1.1 })
    strictEqual(ramp.cap, 4)
    strictEqual(ramp.settled, false)
  })

  it('marks ramp settled immediately if start is already at target', () => {
    const ramp = new ConnectionRamp(16, 16)
    strictEqual(ramp.cap, 16)
    strictEqual(ramp.settled, true)
  })

  it('climbs by doubling when speed increases beyond minGain', () => {
    const ramp = new ConnectionRamp(2, 8, { settleMs: 50, rungMs: 100, minGain: 1.1 })
    const t0 = 1000
    ramp.begin(t0, 0)

    // Still settling (< 50ms)
    strictEqual(ramp.sample(t0 + 20, 10_000), false)
    strictEqual(ramp.cap, 2)

    // Settle finishes at 50ms
    strictEqual(ramp.sample(t0 + 50, 20_000), false)

    // First rung baseline after rungMs (100ms): at t0 + 160ms, speed baseline established
    strictEqual(ramp.sample(t0 + 160, 120_000), true)
    strictEqual(ramp.cap, 4)

    // A climb re-enters settling, so the connections it just opened are not
    // measured through their own slow start. The cap holds while that runs.
    strictEqual(ramp.sample(t0 + 270, 400_000), false)
    strictEqual(ramp.cap, 4)

    // Second rung after another 100ms with speed gain: 2 -> 4 paid off
    strictEqual(ramp.sample(t0 + 380, 800_000), true)
    strictEqual(ramp.cap, 8)

    // Settling again, then the reading at target marks it settled
    strictEqual(ramp.sample(t0 + 490, 1_200_000), false)
    strictEqual(ramp.sample(t0 + 600, 1_800_000), false)
    strictEqual(ramp.settled, true)
  })

  it('steps back down when a rung does not pay for itself', () => {
    const ramp = new ConnectionRamp(2, 8, { settleMs: 50, rungMs: 100, minGain: 1.2 })
    const t0 = 1000
    ramp.begin(t0, 0)
    ramp.sample(t0 + 50, 10_000)

    // Baseline establishes speed of 1,000,000 B/s on 2 connections
    strictEqual(ramp.sample(t0 + 160, 120_000), true)
    strictEqual(ramp.cap, 4)

    // The new rung settles before it is judged
    strictEqual(ramp.sample(t0 + 270, 235_000), false)
    strictEqual(ramp.cap, 4)

    // Next reading speed is only ~1,045,000 B/s (< 1.2x gain)
    strictEqual(ramp.sample(t0 + 380, 350_000), true)
    // Drops back down to 2 and finishes
    strictEqual(ramp.cap, 2)
    strictEqual(ramp.settled, true)
  })

  it('stops immediately when told the server refused', () => {
    const ramp = new ConnectionRamp(4, 16)
    ramp.stop()
    strictEqual(ramp.settled, true)
    strictEqual(ramp.sample(Date.now(), 1000), false)
  })
})

describe('Learned Host Connection Caps', () => {
  beforeEach(() => {
    clearLearnedHostCaps()
  })

  it('returns null for an unmeasured host', () => {
    strictEqual(getLearnedHostCap('example.com'), null)
  })

  it('records and retrieves learned cap case-insensitively', () => {
    recordLearnedHostCap('CDN.Example.COM', 8)
    strictEqual(getLearnedHostCap('cdn.example.com'), 8)
    strictEqual(getLearnedHostCap('CDN.EXAMPLE.COM'), 8)
  })

  it('expires learned caps after TTL', () => {
    const t0 = 100_000
    recordLearnedHostCap('files.example.com', 6, t0)
    strictEqual(getLearnedHostCap('files.example.com', t0 + 1000), 6)
    // 1 hour TTL = 3,600,000 ms
    strictEqual(getLearnedHostCap('files.example.com', t0 + 3_600_001), null)
  })

  it('clearLearnedHostCaps purges all entries', () => {
    recordLearnedHostCap('a.test', 4)
    recordLearnedHostCap('b.test', 8)
    clearLearnedHostCaps()
    strictEqual(getLearnedHostCap('a.test'), null)
    strictEqual(getLearnedHostCap('b.test'), null)
  })
})

describe('http connection pool scaling', () => {
  it('creates dispatchers and allows resizing pool connections', () => {
    const d1 = getDispatcher(15_000)
    strictEqual(typeof d1.dispatch, 'function')

    // Setting same pool size does nothing
    setPoolConnections(1280)
    strictEqual(getDispatcher(15_000), d1)

    // Resizing pool invalidates cached dispatcher and returns a new configured one
    setPoolConnections(512)
    const d2 = getDispatcher(15_000)
    strictEqual(d1 !== d2, true)
    strictEqual(typeof d2.dispatch, 'function')

    // Minimum is clamped to 256
    setPoolConnections(10)
    const d3 = getDispatcher(15_000)
    strictEqual(typeof d3.dispatch, 'function')
  })
})
