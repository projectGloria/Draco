import { strictEqual } from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { DownloadManager, type EngineSettings } from '../src/main/engine/manager.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { TorrentRunner } from '../src/main/engine/torrent.ts'
import type { Torrent } from 'webtorrent'
import type { SeedSession } from '../src/main/engine/runner.ts'

const settings: EngineSettings = {
  maxConcurrentTasks: 1, maxConnectionsPerTask: 1, minSplitSize: 1024,
  retryLimit: 1, timeoutMs: 1000, speedLimit: null, proxyUrl: null,
  hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
  antivirusProgram: null, antivirusArgs: [], antivirusTimeoutSeconds: 1
}

it('torrent metadata owns the actual root name and completion waits for file-store teardown', async () => {
  const task = createTask({ url: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789', dir: tmpdir(), filename: 'custom name', kind: 'torrent' })
  let finished = false
  const runner = new TorrentRunner(task, {
    limiter: new RateLimiter(), ...settings,
    maxConnections: 1, onUpdate() {}, onFinished() { finished = true }
  })
  const file = { path: 'real-folder/video.mp4', length: 100, downloaded: 100, select() {}, deselect() {} }
  const torrent = Object.assign(new EventEmitter(), {
    name: 'real-folder', files: [file], length: 100, wires: [], announce: [], urlList: [], uploaded: 0, ratio: 0,
    infoHash: '0123456789012345678901234567890123456789', metadata: Buffer.from('metadata')
  })
  let released!: () => void
  const internals = runner as unknown as { client: { destroy(callback: () => void): void }; attachTorrent(torrent: Torrent): void }
  internals.client = { destroy(callback) { released = callback } }
  runner.running = true
  internals.attachTorrent(torrent as unknown as Torrent)
  torrent.emit('metadata')
  strictEqual(task.filename, 'real-folder')
  strictEqual(typeof task.completedAt, 'number')
  strictEqual(finished, false, 'the callback must wait for outstanding piece-store writes')
  released()
  await runner.pause()
  strictEqual(finished, true)
})

it('deleting a torrent removes metadata-listed payloads while preserving unrelated files in its folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-torrent-output-'))
  const manager = new DownloadManager({ getSettings: () => settings, onTasks() {}, onProgress() {} })
  try {
    await mkdir(join(dir, 'folder'))
    await writeFile(join(dir, 'folder', 'video.mp4'), 'downloaded')
    await writeFile(join(dir, 'folder', 'notes.txt'), 'my notes')
    const task = manager.add(createTask({ url: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789', dir, filename: 'folder', kind: 'torrent',
      torrentFiles: [{ path: 'folder/video.mp4', size: 10 }] }), false)
    task.status = 'done'
    await manager.remove([task.id], true)
    strictEqual(await readFile(join(dir, 'folder', 'video.mp4')).then(() => true, () => false), false)
    strictEqual((await readFile(join(dir, 'folder', 'notes.txt'))).toString(), 'my notes')
  } finally {
    await manager.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

it('waits for a stopped seed to release its store before deleting its files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-seed-removal-'))
  const manager = new DownloadManager({ getSettings: () => settings, onTasks() {}, onProgress() {} })
  let release!: () => void
  const closed = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const stopping = new Promise<void>((resolve) => { entered = resolve })
  try {
    await writeFile(join(dir, 'video.mp4'), 'downloaded')
    const task = manager.add(createTask({ url: 'magnet:?xt=urn:btih:0123456789012345678901234567890123456789', dir, filename: 'video.mp4', kind: 'torrent',
      torrentFiles: [{ path: 'video.mp4', size: 10 }] }), false)
    task.status = 'done'
    const session = { taskId: task.id, progress: () => ({ uploaded: 0, ratio: 0, uploadSpeed: 0, peers: 0 }),
      refreshInfo() {}, applyUploadLimit() {}, stop() { entered(); return closed } }
    ;(manager as unknown as { adoptSeed(seeded: typeof task, session: SeedSession): void }).adoptSeed(task, session)
    const removing = manager.remove([task.id], true)
    await stopping
    // Let the removal reach its first filesystem operation if it failed to wait.
    await new Promise((resolve) => setTimeout(resolve, 50))
    try {
      strictEqual((await readFile(join(dir, 'video.mp4'))).toString(), 'downloaded')
      strictEqual(manager.get(task.id), task)
    } finally { release(); await removing }
    strictEqual(await readFile(join(dir, 'video.mp4')).then(() => true, () => false), false)
  } finally {
    release()
    await manager.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})
