import { match, strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { tmpdir } from 'node:os'
import { createTask } from '../src/main/engine/create.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { TorrentRunner } from '../src/main/engine/torrent.ts'
import type { RunnerContext } from '../src/main/engine/manager.ts'
import { EventEmitter } from 'node:events'
import type { Torrent } from 'webtorrent'

function fixture(limiter: RateLimiter) {
  const task = createTask({
    url: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789',
    dir: tmpdir(), filename: 'sample', kind: 'torrent'
  })
  let finished: Error | null | undefined
  const context: RunnerContext = {
    limiter, maxConnections: 1, minSplitSize: 1024, retryLimit: 0,
    timeoutMs: 1000, proxyUrl: null, onUpdate() {},
    onFinished(_task, error) { finished = error }
  }
  return { task, runner: new TorrentRunner(task, context), finished: () => finished }
}

for (const selection of [undefined, ['folder/a.bin']] as const) {
  it(`selects torrent files after metadata arrives (${selection ? 'chosen files' : 'all files'})`, () => {
    const { task, runner } = fixture(new RateLimiter())
    task.selectedFiles = selection ? [...selection] : undefined
    const chosen = new Set<string>()
    const files = ['folder/a.bin', 'folder/b.bin'].map((path) => ({
      path, length: 100, downloaded: 0,
      select() { chosen.add(path) }, deselect() { chosen.delete(path) }
    }))
    const torrent = Object.assign(new EventEmitter(), {
      files, length: 200, wires: [], announce: [], urlList: [], uploaded: 0, ratio: 0,
      infoHash: '0123456789012345678901234567890123456789', metadata: Buffer.from('metadata')
    })
    const internals = runner as unknown as { attachTorrent(torrent: Torrent): void }
    runner.running = true
    internals.attachTorrent(torrent as unknown as Torrent)
    torrent.emit('metadata')
    strictEqual(chosen.size, selection ? 1 : 2)
    strictEqual(chosen.has('folder/a.bin'), true)
    strictEqual(chosen.has('folder/b.bin'), !selection)
    strictEqual(task.size, selection ? 100 : 200)
  })
}

it('every torrent pause waits for pending piece-store teardown', async () => {
  const { runner, finished } = fixture(new RateLimiter())
  let destroyed!: () => void
  const live = runner as unknown as { client: { destroy(callback: () => void): void } }
  live.client = { destroy(callback) { destroyed = callback } }
  runner.running = true
  let stopped = 0
  const pauses = [runner.pause(), runner.pause()].map((pause) => pause.then(() => { stopped++ }))
  await new Promise((resolve) => setImmediate(resolve))
  strictEqual(stopped, 0)
  strictEqual(finished(), undefined, 'the slot is still owned until its files stop writing')
  destroyed()
  await Promise.all(pauses)
  strictEqual(stopped, 2)
  strictEqual(finished(), null)
})

it('rejects a torrent before starting WebTorrent under a transfer quota', async () => {
  const limiter = new RateLimiter()
  limiter.setQuota(1024, 60_000)
  const { task, runner, finished } = fixture(limiter)

  await runner.start()
  strictEqual(task.status, 'error')
  match(task.error ?? '', /cannot honor the active transfer quota/)
  match(finished()?.message ?? '', /cannot honor the active transfer quota/)
})

it('stops an active torrent when a quota is enabled later', async () => {
  const limiter = new RateLimiter()
  const { task, runner, finished } = fixture(limiter)
  let destroyed = false
  const live = runner as unknown as {
    running: boolean
    client: { destroy(callback: () => void): void } | null
    torrent: object | null
  }
  live.running = true
  live.client = { destroy(callback) { destroyed = true; callback() } }
  live.torrent = {}
  limiter.setQuota(1024, 60_000)

  runner.tick()
  await runner.pause()
  strictEqual(destroyed, true)
  strictEqual(task.status, 'error')
  match(finished()?.message ?? '', /cannot honor the active transfer quota/)
})
