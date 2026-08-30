import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTask } from '../src/main/engine/create.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'
import { DownloadManager } from '../src/main/engine/manager.ts'

const PAYLOAD = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 251))

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

function settings() {
  return {
    maxConcurrentTasks: 1,
    maxConnectionsPerTask: 4,
    minSplitSize: 16 * 1024,
    retryLimit: 2,
    timeoutMs: 5_000,
    speedLimit: null,
    proxyUrl: null,
    hostConnectionLimits: [],
    quotaBytes: null,
    quotaWindowMinutes: 60
  }
}

function waitForTerminal(manager, taskId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('download integration test timed out')), 10_000)
    const inspect = (tasks) => {
      const task = tasks.find((candidate) => candidate.id === taskId)
      if (!task || (task.status !== 'done' && task.status !== 'error')) return
      clearTimeout(timer)
      resolve(task)
    }
    manager.__inspect = inspect
  })
}

function rangeResponse(request, response) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (!match) {
    response.writeHead(200, { 'content-length': PAYLOAD.length })
    response.end(PAYLOAD)
    return
  }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : PAYLOAD.length - 1
  const body = PAYLOAD.subarray(start, end + 1)
  response.writeHead(206, {
    'accept-ranges': 'bytes',
    'content-length': body.length,
    'content-range': `bytes ${start}-${end}/${PAYLOAD.length}`,
    etag: '"fixture-v1"'
  })
  response.end(body)
}

function managerFor(taskRef) {
  const manager = new DownloadManager({
    getSettings: settings,
    onTasks: (tasks) => manager.__inspect?.(tasks),
    onProgress: () => {}
  })
  taskRef.manager = manager
  return manager
}

test('redirected downloads preserve captured cookies and assemble exact ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-engine-'))
  let sawCookie = false
  const server = http.createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: '/payload' })
      response.end()
      return
    }
    if (request.url !== '/payload' || request.headers.cookie !== 'session=accepted') {
      response.writeHead(403)
      response.end()
      return
    }
    sawCookie = true
    if (request.method === 'HEAD') {
      response.writeHead(200, {
        'accept-ranges': 'bytes',
        'content-length': PAYLOAD.length,
        etag: '"fixture-v1"'
      })
      response.end()
      return
    }
    rangeResponse(request, response)
  })
  const port = await listen(server)

  const ref = {}
  const manager = managerFor(ref)
  const task = createTask({
    url: `http://127.0.0.1:${port}/start`,
    dir,
    filename: 'cookie.bin',
    headers: { cookie: 'session=accepted' }
  })
  const terminal = waitForTerminal(manager, task.id)
  manager.add(task)

  try {
    const finished = await terminal
    assert.equal(finished.status, 'done')
    assert.equal(sawCookie, true)
    assert.deepEqual(await readFile(join(dir, finished.filename)), PAYLOAD)
  } finally {
    manager.dispose()
    await closeDispatchers()
    await close(server)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a lying range server retries once in sticky single-connection mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-engine-'))
  let ignoredRanges = 0
  const server = http.createServer((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, {
        'accept-ranges': 'bytes',
        'content-length': PAYLOAD.length,
        etag: '"liar-v1"'
      })
      response.end()
      return
    }
    if (request.headers.range === 'bytes=0-0') {
      rangeResponse(request, response)
      return
    }
    ignoredRanges++
    response.writeHead(200, { 'content-length': PAYLOAD.length, etag: '"liar-v1"' })
    response.end(PAYLOAD)
  })
  const port = await listen(server)

  const ref = {}
  const manager = managerFor(ref)
  const task = createTask({
    url: `http://127.0.0.1:${port}/payload`,
    dir,
    filename: 'fallback.bin'
  })
  const terminal = waitForTerminal(manager, task.id)
  manager.add(task)

  try {
    const finished = await terminal
    assert.equal(finished.status, 'done')
    assert.equal(finished.singleConnectionFallback, true)
    assert.ok(ignoredRanges >= 2)
    assert.deepEqual(await readFile(join(dir, finished.filename)), PAYLOAD)
  } finally {
    manager.dispose()
    await closeDispatchers()
    await close(server)
    await rm(dir, { recursive: true, force: true })
  }
})

test('a single-connection download honors Retry-After and recovers from throttling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-engine-'))
  let throttles = 0
  const server = http.createServer((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, {
        'accept-ranges': 'bytes',
        'content-length': PAYLOAD.length,
        etag: '"throttle-v1"'
      })
      response.end()
      return
    }
    if (request.headers.range === 'bytes=0-0') {
      rangeResponse(request, response)
      return
    }
    if (throttles++ === 0) {
      response.writeHead(429, { 'retry-after': '0' })
      response.end()
      return
    }
    rangeResponse(request, response)
  })
  const port = await listen(server)

  const manager = new DownloadManager({
    getSettings: () => ({ ...settings(), maxConnectionsPerTask: 1 }),
    onTasks: (tasks) => manager.__inspect?.(tasks),
    onProgress: () => {}
  })
  const task = createTask({
    url: `http://127.0.0.1:${port}/payload`,
    dir,
    filename: 'throttled.bin'
  })
  const terminal = waitForTerminal(manager, task.id)
  manager.add(task)

  try {
    const finished = await terminal
    assert.equal(finished.status, 'done')
    assert.equal(throttles, 2)
    assert.deepEqual(await readFile(join(dir, finished.filename)), PAYLOAD)
  } finally {
    manager.dispose()
    await closeDispatchers()
    await close(server)
    await rm(dir, { recursive: true, force: true })
  }
})

test('pausing during an in-flight probe does not turn the fetch abort into a task error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-engine-'))
  let requestSeen
  const sawRequest = new Promise((resolve) => { requestSeen = resolve })
  const server = http.createServer((_request, _response) => {
    requestSeen()
    // Deliberately leave the response open until Draco aborts its probe.
  })
  const port = await listen(server)
  const ref = {}
  const manager = managerFor(ref)
  const task = createTask({
    url: `http://127.0.0.1:${port}/slow`,
    dir,
    filename: 'paused.bin'
  })
  manager.add(task)

  try {
    await sawRequest
    await manager.pause([task.id])
    const paused = manager.list().find((candidate) => candidate.id === task.id)
    assert.equal(paused.status, 'paused')
    assert.equal(paused.error, null)
  } finally {
    manager.dispose()
    server.closeAllConnections?.()
    await closeDispatchers()
    await close(server)
    await rm(dir, { recursive: true, force: true })
  }
})
