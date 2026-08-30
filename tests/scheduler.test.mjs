import test from 'node:test'
import assert from 'node:assert/strict'
import { isInQueueWindow } from '../src/main/queue/scheduler-window.ts'
import { Scheduler } from '../src/main/queue/scheduler.ts'

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

function queue(overrides = {}) {
  return {
    id: 'q', name: 'Queue', taskIds: ['t'], mode: 'manual', startTime: null,
    stopTime: null, days: [], maxConcurrent: 1, retryLimit: 2,
    retryDelaySeconds: 0, onComplete: 'none', completionProgram: null,
    completionArgs: [], running: true, oneTimeCompleted: false, lastResult: 'idle',
    ...overrides
  }
}

test('queue retries are bounded and an exhausted queue drains with errors', () => {
  const task = { id: 't', queueId: 'q', status: 'error', queueRetryCount: 0, nextQueueAttemptAt: null }
  const starts = []
  const manager = {
    list: () => [task],
    start: (ids) => { starts.push(...ids); task.status = 'queued' },
    pause: async () => {},
    notifyTaskMetadataChanged: () => {}
  }
  const scheduler = new Scheduler({
    manager,
    onQueues: () => {},
    saveQueues: async () => {},
    onPending: () => {},
    onExitRequested: () => {}
  })
  const configured = queue()
  scheduler.load([configured])

  scheduler.tick()
  assert.deepEqual(starts, ['t'])
  assert.equal(task.queueRetryCount, 1)

  task.status = 'error'
  scheduler.tick()
  assert.deepEqual(starts, ['t', 't'])
  assert.equal(task.queueRetryCount, 2)

  task.status = 'error'
  scheduler.tick()
  assert.equal(configured.running, false)
  assert.equal(configured.lastResult, 'completed-with-errors')
})

test('moving a task synchronizes queue membership and preserves append order', async () => {
  const task = { id: 't', queueId: 'a' }
  const queues = [queue({ id: 'a', taskIds: ['t'] }), queue({ id: 'b', taskIds: ['other'] })]
  let saves = 0
  const scheduler = new Scheduler({
    manager: { list: () => [task], pause: async () => {}, notifyTaskMetadataChanged: () => {} },
    onQueues: () => {}, saveQueues: async () => { saves++ }, onPending: () => {}, onExitRequested: () => {}
  })
  scheduler.load(queues)
  await scheduler.syncTaskQueue('t', 'a', 'b')
  assert.deepEqual(queues[0].taskIds, [])
  assert.deepEqual(queues[1].taskIds, ['other', 't'])
  assert.equal(saves, 1)
})
