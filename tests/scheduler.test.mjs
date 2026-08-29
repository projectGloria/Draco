import test from 'node:test'
import assert from 'node:assert/strict'
import { isInQueueWindow } from '../src/main/queue/scheduler-window.ts'

test('one-time schedule window crosses midnight correctly', () => {
  const queue = {
    startTime: '23:00',
    stopTime: '01:00',
    mode: 'onetime',
    days: [],
  }
  assert.equal(isInQueueWindow(queue, new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(isInQueueWindow(queue, new Date(2026, 0, 2, 0, 30)), true)
  assert.equal(isInQueueWindow(queue, new Date(2026, 0, 2, 1, 0)), false)
})
