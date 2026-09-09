import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DownloadTask, TaskStatus } from '../src/shared/types.ts'
import { buildDisplayRows } from '../src/shared/groups.ts'

let clock = 1_000

function task(id: string, patch: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id,
    url: `https://cdn.example.com/${id}.flac`,
    finalUrl: '',
    filename: `${id}.flac`,
    filenameLocked: false,
    dir: 'C:/downloads',
    categoryId: null,
    queueId: null,
    queueRetryCount: 0,
    nextQueueAttemptAt: null,
    manualPause: false,
    kind: 'http',
    size: 100,
    received: 0,
    status: 'queued',
    resumable: true,
    singleConnectionFallback: false,
    segments: [],
    connections: 1,
    speed: 0,
    eta: null,
    error: null,
    detail: null,
    createdAt: clock++,
    startedAt: null,
    completedAt: null,
    etag: null,
    lastModified: null,
    headers: {},
    mimeType: null,
    description: '',
    ...patch
  } as DownloadTask
}

const album = (id: string, patch: Partial<DownloadTask> = {}): DownloadTask =>
  task(id, { groupId: 'album', groupName: 'Example Score', ...patch })

describe('buildDisplayRows', () => {
  it('shows a group as a single row, whatever its size', () => {
    const rows = buildDisplayRows([album('a'), album('b'), album('c'), task('loose')])
    deepStrictEqual(rows.map((row) => row.kind), ['group', 'task'])
    strictEqual(rows[0].kind === 'group' && rows[0].group.tasks.length, 3)
  })

  it('never lists the members of a group in the table', () => {
    const rows = buildDisplayRows([album('a'), album('b'), task('loose')])
    deepStrictEqual(
      rows.map((row) => row.kind === 'task' ? row.task.id : 'group:' + row.group.id),
      ['group:album', 'loose']
    )
  })

  it('takes the position of its first member, wherever sorting put it', () => {
    const rows = buildDisplayRows([task('loose'), album('a'), album('b')])
    deepStrictEqual(
      rows.map((row) => row.kind === 'task' ? row.task.id : 'group:' + row.group.id),
      ['loose', 'group:album']
    )
  })

  it('keeps every member on the group row, however sorting scattered them', () => {
    const rows = buildDisplayRows([album('a'), task('loose'), album('b')])
    deepStrictEqual(rows.map((row) => row.kind), ['group', 'task'])
    strictEqual(rows[0].kind === 'group' && rows[0].group.tasks.length, 2)
  })

  it('leaves a group of one as an ordinary row', () => {
    const rows = buildDisplayRows([album('a'), task('loose')])
    deepStrictEqual(rows.map((row) => row.kind), ['task', 'task'])
  })
})

describe('the row standing in for a closed group', () => {
  const summaryOf = (tasks: DownloadTask[]): DownloadTask => {
    const rows = buildDisplayRows(tasks)
    if (rows[0].kind !== 'group') throw new Error('expected a group row')
    return rows[0].group.summary
  }

  it('adds up size, progress and speed', () => {
    const summary = summaryOf([
      album('a', { size: 300, received: 150, speed: 50 }),
      album('b', { size: 700, received: 50, speed: 30 })
    ])
    strictEqual(summary.size, 1000)
    strictEqual(summary.received, 200)
    strictEqual(summary.speed, 80)
    strictEqual(summary.eta, 10)
  })

  it('totals what is known while other members are still being probed', () => {
    strictEqual(summaryOf([album('a', { size: 300 }), album('b', { size: null })]).size, 300)
  })

  it('counts the size the page advertised until the probe confirms one', () => {
    const summary = summaryOf([
      album('a', { size: null, expectedSize: 300 }),
      album('b', { size: null, expectedSize: 700 })
    ])
    strictEqual(summary.size, 1000)
  })

  it('prefers the confirmed size over the advertised one', () => {
    const summary = summaryOf([
      album('a', { size: 512, expectedSize: 300 }),
      album('b', { size: null, expectedSize: 700 })
    ])
    strictEqual(summary.size, 512 + 700)
  })

  it('does not let the total climb as members are probed', () => {
    const before = summaryOf([
      album('a', { size: null, expectedSize: 300 }),
      album('b', { size: null, expectedSize: 700 })
    ])
    const during = summaryOf([
      album('a', { size: 300, received: 300, expectedSize: 300 }),
      album('b', { size: null, expectedSize: 700 })
    ])
    strictEqual(before.size, during.size)
  })

  const worst = (statuses: TaskStatus[]): TaskStatus =>
    summaryOf(statuses.map((status, index) => album(`t${index}`, { status }))).status

  it('reports whatever is still moving ahead of whatever has finished', () => {
    strictEqual(worst(['done', 'downloading', 'done']), 'downloading')
    strictEqual(worst(['done', 'queued']), 'queued')
    strictEqual(worst(['done', 'done']), 'done')
  })

  it('does not let forty-eight successes hide one failure', () => {
    strictEqual(worst(['done', 'error', 'paused']), 'error')
    strictEqual(summaryOf([album('a', { status: 'error' }), album('b', { status: 'done' })]).error, '1 of 2 failed')
  })

  it('says how many files are done, since one bar cannot', () => {
    strictEqual(summaryOf([album('a', { status: 'done' }), album('b')]).detail, '1 of 2 files')
  })

  it('is finished only when every member is', () => {
    strictEqual(summaryOf([album('a', { status: 'done', completedAt: 5 }), album('b')]).completedAt, null)
    strictEqual(
      summaryOf([album('a', { status: 'done', completedAt: 5 }), album('b', { status: 'done', completedAt: 9 })]).completedAt,
      9
    )
  })
})
