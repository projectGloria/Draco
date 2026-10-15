import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { batchHandoffId, commitBrowserTasks, committedBrowserTaskCount } from '../src/main/bridge/admission.ts'

it('starts accepted browser tasks only after their snapshot is durable', async () => {
  const events: string[] = []
  let finishWrite!: () => void
  const write = new Promise<void>((resolve) => { finishWrite = resolve })
  const manager = {
    start(ids: string[]) { events.push(`start:${ids.join(',')}`) },
    async remove() { events.push('remove') }
  }
  const admission = commitBrowserTasks(manager, ['one', 'two'], async () => {
    events.push('flush')
    await write
  })
  deepStrictEqual(events, ['flush'])
  finishWrite()
  await admission
  deepStrictEqual(events, ['flush', 'start:one,two'])
})

it('returns ownership to the browser when the snapshot cannot be saved', async () => {
  const events: string[] = []
  const manager = {
    start() { events.push('start') },
    async remove(ids: string[], deleteFiles: boolean) {
      events.push(`remove:${ids.join(',')}:${deleteFiles}`)
    }
  }
  await rejects(commitBrowserTasks(manager, ['one'], async () => {
    events.push('flush')
    throw new Error('disk full')
  }), /disk full/)
  deepStrictEqual(events, ['flush', 'remove:one:false'])
})

it('finds a committed single handoff after the reply is lost and the app restarts', async () => {
  const requestId = 'browser-request-1'
  const tasks = [{ id: 'task-1', handoffId: requestId }]
  let disk = ''
  const manager = {
    list: () => tasks,
    start() {},
    async remove() { tasks.length = 0 }
  }
  await commitBrowserTasks(manager, ['task-1'], async () => { disk = JSON.stringify(tasks) })
  // The browser never received `taken`, so it resends the same request to a
  // fresh process whose in-memory reply cache is empty.
  const restored = { list: () => JSON.parse(disk) as typeof tasks }
  strictEqual(committedBrowserTaskCount(restored, requestId), 1)
  strictEqual(committedBrowserTaskCount(restored, 'other-request'), 0)
})

it('finds a whole bulk handoff without confusing it with a single request', () => {
  const requestId = 'browser-batch-1'
  const first = batchHandoffId(requestId, 0)
  const second = batchHandoffId(requestId, 1)
  const third = batchHandoffId(requestId, 2)
  const restored = { list: () => [
    { handoffId: first }, { handoffId: second }, { handoffId: requestId }
  ] }
  strictEqual(committedBrowserTaskCount(restored, first), 1)
  strictEqual(committedBrowserTaskCount(restored, second), 1)
  strictEqual(committedBrowserTaskCount(restored, third), 0,
    'a replay after a partial batch write still has one item to create')
  strictEqual(committedBrowserTaskCount(restored, requestId), 1)
  strictEqual(batchHandoffId(requestId, 0), first)
  strictEqual((first ?? '').length < 128, true)
})
