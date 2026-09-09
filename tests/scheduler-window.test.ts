import { strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isInQueueWindow } from '../src/main/queue/scheduler-window.ts'
import type { Queue, QueueMode } from '../src/shared/types.ts'

/**
 * Queue time windows. The scheduler asks this every 30 seconds and starts or
 * stops downloads on the answer, so an off-by-one at midnight is the difference
 * between a queue that runs overnight and one that stops at 00:00.
 */

function queue(overrides: Partial<Queue> = {}): Queue {
  return {
    id: 'q1',
    name: 'Nightly',
    taskIds: [],
    mode: 'onetime' as QueueMode,
    startTime: null,
    stopTime: null,
    days: [],
    maxConcurrent: 1,
    speedLimit: null,
    retryLimit: 3,
    retryDelaySeconds: 30,
    onComplete: 'none',
    completionProgram: null,
    completionArgs: [],
    running: false,
    oneTimeCompleted: false,
    lastResult: 'idle',
    ...overrides
  }
}

/** A local-time Date on a known weekday. 2024-01-03 was a Wednesday (day 3). */
function wednesdayAt(hours: number, minutes = 0): Date {
  return new Date(2024, 0, 3, hours, minutes, 0, 0)
}

describe('isInQueueWindow', () => {
  it('is closed when no start time was ever set', () => {
    strictEqual(isInQueueWindow(queue(), wednesdayAt(12)), false)
  })

  it('is closed when the times are not times', () => {
    strictEqual(isInQueueWindow(queue({ startTime: 'noon' }), wednesdayAt(12)), false)
    strictEqual(isInQueueWindow(queue({ startTime: '25:00' }), wednesdayAt(12)), false)
    strictEqual(isInQueueWindow(queue({ startTime: '10:70' }), wednesdayAt(12)), false)
    strictEqual(isInQueueWindow(queue({ startTime: '10:00', stopTime: 'never' }), wednesdayAt(12)), false)
  })

  it('opens at the start minute and closes at the stop minute', () => {
    const nine_to_five = queue({ startTime: '09:00', stopTime: '17:00' })

    strictEqual(isInQueueWindow(nine_to_five, wednesdayAt(8, 59)), false)
    strictEqual(isInQueueWindow(nine_to_five, wednesdayAt(9, 0)), true, 'the start minute is inside')
    strictEqual(isInQueueWindow(nine_to_five, wednesdayAt(16, 59)), true)
    strictEqual(isInQueueWindow(nine_to_five, wednesdayAt(17, 0)), false, 'the stop minute is outside')
  })

  it('stays open indefinitely when there is a start but no stop', () => {
    const open_ended = queue({ startTime: '22:00' })
    strictEqual(isInQueueWindow(open_ended, wednesdayAt(21, 59)), false)
    strictEqual(isInQueueWindow(open_ended, wednesdayAt(23, 59)), true)
  })

  it('carries a window across midnight', () => {
    const overnight = queue({ startTime: '23:00', stopTime: '06:00' })

    strictEqual(isInQueueWindow(overnight, wednesdayAt(22, 59)), false)
    strictEqual(isInQueueWindow(overnight, wednesdayAt(23, 30)), true, 'the evening half')
    strictEqual(isInQueueWindow(overnight, wednesdayAt(0, 0)), true, 'still inside at midnight')
    strictEqual(isInQueueWindow(overnight, wednesdayAt(5, 59)), true, 'the morning half')
    strictEqual(isInQueueWindow(overnight, wednesdayAt(6, 0)), false)
  })

  it('honours the weekday list of a periodic queue', () => {
    const weekdays = queue({ mode: 'periodic', startTime: '09:00', stopTime: '17:00', days: [1, 2, 3, 4, 5] })
    strictEqual(isInQueueWindow(weekdays, wednesdayAt(12)), true)

    const weekend = queue({ mode: 'periodic', startTime: '09:00', stopTime: '17:00', days: [0, 6] })
    strictEqual(isInQueueWindow(weekend, wednesdayAt(12)), false, 'Wednesday is not the weekend')

    const anyDay = queue({ mode: 'periodic', startTime: '09:00', stopTime: '17:00', days: [] })
    strictEqual(isInQueueWindow(anyDay, wednesdayAt(12)), true, 'no days chosen means every day')
  })

  it('judges the morning half of an overnight window by the day it started', () => {
    // 01:00 on Wednesday belongs to Tuesday's run. Checking today would open a
    // Tuesday-night queue again on Wednesday morning and never open the one
    // that was actually scheduled.
    const tuesdayNights = queue({ mode: 'periodic', startTime: '23:00', stopTime: '06:00', days: [2] })
    strictEqual(isInQueueWindow(tuesdayNights, wednesdayAt(1, 0)), true, 'still Tuesday night as far as the queue is concerned')
    strictEqual(isInQueueWindow(tuesdayNights, wednesdayAt(23, 30)), false, 'Wednesday night is not Tuesday night')

    const wednesdayNights = queue({ mode: 'periodic', startTime: '23:00', stopTime: '06:00', days: [3] })
    strictEqual(isInQueueWindow(wednesdayNights, wednesdayAt(23, 30)), true)
    strictEqual(isInQueueWindow(wednesdayNights, wednesdayAt(1, 0)), false)
  })

  it('ignores the weekday list unless the queue is periodic', () => {
    const once = queue({ mode: 'onetime', startTime: '09:00', stopTime: '17:00', days: [0] })
    strictEqual(isInQueueWindow(once, wednesdayAt(12)), true, 'a one-time queue runs on the day it is armed')
  })
})
