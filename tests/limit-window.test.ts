import { strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { effectiveSpeedLimit, parseClock, withinWindow } from '../src/main/engine/limit-window.ts'

/** 2024-01-03, a Wednesday. Only the clock matters here. */
function at(hours: number, minutes = 0): Date {
  return new Date(2024, 0, 3, hours, minutes, 0, 0)
}

const KB = 1024

describe('parseClock', () => {
  it('reads a time as minutes since midnight', () => {
    strictEqual(parseClock('00:00'), 0)
    strictEqual(parseClock('9:30'), 570)
    strictEqual(parseClock('23:59'), 1439)
  })

  it('has no answer for something that is not a time', () => {
    strictEqual(parseClock('24:00'), null)
    strictEqual(parseClock('10:60'), null)
    strictEqual(parseClock('noon'), null)
    strictEqual(parseClock(null), null)
  })
})

describe('withinWindow', () => {
  it('opens on the start minute and closes on the stop minute', () => {
    strictEqual(withinWindow('09:00', '17:00', at(8, 59)), false)
    strictEqual(withinWindow('09:00', '17:00', at(9, 0)), true)
    strictEqual(withinWindow('09:00', '17:00', at(16, 59)), true)
    strictEqual(withinWindow('09:00', '17:00', at(17, 0)), false)
  })

  it('carries a window across midnight', () => {
    strictEqual(withinWindow('23:00', '06:00', at(22, 59)), false)
    strictEqual(withinWindow('23:00', '06:00', at(23, 30)), true)
    strictEqual(withinWindow('23:00', '06:00', at(0, 0)), true)
    strictEqual(withinWindow('23:00', '06:00', at(5, 59)), true)
    strictEqual(withinWindow('23:00', '06:00', at(6, 0)), false)
  })

  it('reads an empty window as never, not always', () => {
    // An accidental 00:00-00:00 must not throttle the app around the clock.
    strictEqual(withinWindow('12:00', '12:00', at(12, 0)), false)
    strictEqual(withinWindow('12:00', '12:00', at(3, 0)), false)
  })

  it('is closed when the times are not times', () => {
    strictEqual(withinWindow('nine', '17:00', at(12)), false)
    strictEqual(withinWindow('09:00', undefined, at(12)), false)
  })
})

describe('effectiveSpeedLimit', () => {
  const scheduled = { startTime: '09:00', stopTime: '17:00', bytesPerSecond: 200 * KB }

  it('is the ordinary limit with nothing scheduled', () => {
    strictEqual(effectiveSpeedLimit({ speedLimit: 500 * KB }, at(12)), 500 * KB)
    strictEqual(effectiveSpeedLimit({ speedLimit: null }, at(12)), null)
  })

  it('replaces the ordinary limit while the window is open', () => {
    // Two numbers that both applied would need a rule for which wins; the plain
    // reading of "200 KB/s between 9 and 5" is that it *is* the limit then.
    strictEqual(effectiveSpeedLimit({ speedLimit: 500 * KB, scheduledLimit: scheduled }, at(12)), 200 * KB)
    strictEqual(effectiveSpeedLimit({ speedLimit: null, scheduledLimit: scheduled }, at(12)), 200 * KB)
  })

  it('hands back the ordinary limit once the window closes', () => {
    strictEqual(effectiveSpeedLimit({ speedLimit: 500 * KB, scheduledLimit: scheduled }, at(20)), 500 * KB)
    strictEqual(effectiveSpeedLimit({ speedLimit: null, scheduledLimit: scheduled }, at(20)), null)
  })

  it('ignores a scheduled limit of zero, which means no limit at all', () => {
    strictEqual(
      effectiveSpeedLimit({ speedLimit: 500 * KB, scheduledLimit: { ...scheduled, bytesPerSecond: 0 } }, at(12)),
      500 * KB
    )
  })
})
