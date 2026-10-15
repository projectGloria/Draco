import { deepStrictEqual, notStrictEqual, strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { publicTask, publicTasks } from '../src/main/public-task.ts'
import type { DownloadTask } from '../src/shared/types.ts'

it('does not send request headers in task snapshots or mutate runner state', () => {
  const task = {
    id: 'one',
    url: 'https://example.test/file',
    finalUrl: 'https://example.test/file',
    filename: 'example.bin',
    filenameLocked: false,
    dir: 'C:\\Downloads',
    categoryId: null,
    queueId: null,
    queueRetryCount: 0,
    nextQueueAttemptAt: null,
    manualPause: false,
    kind: 'file',
    size: null,
    received: 0,
    status: 'queued',
    resumable: false,
    singleConnectionFallback: false,
    segments: [],
    connections: 1,
    speed: 0,
    eta: null,
    error: null,
    detail: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    etag: null,
    lastModified: null,
    headers: {
      cookie: 'private-cookie',
      authorization: 'private-authorization',
      referer: 'https://private.example/page',
      userAgent: 'private-agent',
      extra: { 'X-Api-Key': 'private-api-key' }
    },
    mimeType: null,
    description: ''
  } satisfies DownloadTask

  const view = publicTask(task)
  deepStrictEqual(view.headers, {})
  strictEqual(view.id, task.id)
  strictEqual(view.filename, task.filename)
  notStrictEqual(view, task)
  strictEqual(task.headers.cookie, 'private-cookie')

  const list = publicTasks([task])
  deepStrictEqual(list, [view])
  for (const secret of ['private-cookie', 'private-authorization', 'private-api-key', 'private-agent']) {
    strictEqual(JSON.stringify(list).includes(secret), false)
  }
})
