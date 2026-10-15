import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { it } from 'node:test'
import { createTask, filenameForKind, kindForUrl, validateUrl } from '../src/main/engine/create.ts'
import { sanitizeFilename } from '../src/main/engine/naming.ts'
import { normalizeDownloadDirectory } from '../src/main/destination-path.ts'
import { directoryFor } from '../src/main/categories.ts'
import { mapConcurrent } from '../src/main/engine/concurrency.ts'
import { isSupportedYouTubeUrl } from '../src/main/youtube-url.ts'
import { isPlaylistUrl } from '../src/main/youtube-playlist.ts'
import { publicTask, publicTasks } from '../src/main/public-task.ts'
import type { DownloadTask, NewDownload } from '../src/shared/types.ts'

function fixture(overrides: Record<string, unknown> = {}) {
  const source = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source).replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace(/^export /gm, '')
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  const tasks: DownloadTask[] = []
  const ctx = {
    manager: {
      add(task: DownloadTask) { tasks.push(task) },
      get(id: string) { return tasks.find((task) => task.id === id) }, list: () => tasks,
      emitTasks() {},
      async remove(ids: string[]) { for (let i = tasks.length - 1; i >= 0; i--) if (ids.includes(tasks[i].id)) tasks.splice(i, 1) }
    }, scheduler: { list: () => [] }, pendingHandoffs: [] as any[], handoffCommits: new Map(), media: [] as any[]
  }
  const sandbox = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    ipcMain: { handle(channel: string, fn: (...args: any[]) => Promise<any>) { handlers.set(channel, fn) }, on() {} },
    setHandoffEvictListener() {},
    getSettings: () => ({ downloadDir: 'C:\\Downloads', defaultCategoryId: null, showProgressWindow: false }), getCategories: () => [],
    randomUUID, dirname, join, AbortController, createTask, filenameForKind, kindForUrl, validateUrl, sanitizeFilename,
    normalizeDownloadDirectory, directoryFor, publicTask, publicTasks,
    mapConcurrent, isSupportedYouTubeUrl, isPlaylistUrl,
    persistTasks() {}, send() {}, closeHandoffWindow() {},
    ...overrides
  }
  const api = runInNewContext(code + '\n({ registerIpc, expandPlaylist, cancelPlaylistExpansion })', sandbox)
  api.registerIpc(ctx)
  const call = (channel: string, ...args: any[]) => handlers.get(channel)!({}, ...args)
  return { api, ctx, tasks, call }
}

it('rejects an invalid later batch item without adding its valid prefix', async () => {
  const f = fixture()
  await rejects(f.call('tasks:addMany', [{ url: 'https://example.com/file.mp4' }, { url: 'not a URL' }] satisfies NewDownload[]))
  strictEqual(f.tasks.length, 0)
})

it('keeps a media confirmation available when its destination is invalid', async () => {
  const f = fixture()
  f.ctx.pendingHandoffs.push({ id: 'request', kind: 'media', mediaId: 'candidate' })
  f.ctx.media.push({ id: 'candidate', pageUrl: 'https://example.com/page', type: 'file', variants: [], headers: {} })
  await rejects(f.call('handoff:acceptMedia', 'request', { variantUrl: 'https://example.com/file.mp4', filename: 'file.mp4', dir: 'relative' }))
  strictEqual(f.ctx.pendingHandoffs.length, 1)
  strictEqual(f.tasks.length, 0)
})

it('redownloads a grouped file into its original custom destination', async () => {
  const f = fixture()
  const task = createTask({ url: 'https://example.com/file.mp4', dir: 'D:\\Custom\\Album', groupFolder: 'Album', groupId: 'g', filename: 'file.mp4' })
  f.tasks.push(task)
  await f.call('tasks:redownload', task.id)
  strictEqual(f.tasks.length, 1)
  strictEqual(f.tasks[0].dir, 'D:\\Custom\\Album')
})

it('retains the original redownload row if constructing its replacement fails', async () => {
  const f = fixture()
  const task = createTask({ url: 'https://example.com/file.mp4', dir: 'C:\\Downloads' })
  task.url = 'invalid legacy URL'
  f.tasks.push(task)
  await rejects(f.call('tasks:redownload', task.id))
  strictEqual(f.tasks[0], task)
})

it('does not admit playlist resolutions that finish after cancellation', async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const f = fixture({ resolveYouTube: async () => {
    await waiting
    return { title: 'Video', variants: [{ url: 'https://example.com/file.mp4', height: 720, container: 'mp4' }] }
  } })
  const work = f.api.expandPlaylist(f.ctx, [{ url: 'https://www.youtube.com/watch?v=abcdef12345', title: 'Video' }],
    { groupId: 'cancel-test', groupName: 'Videos', height: null, audioOnly: false, queueId: null })
  strictEqual(f.api.cancelPlaylistExpansion('cancel-test'), true)
  release()
  await work
  deepStrictEqual(f.tasks, [])
})

it('prepares raw YouTube input before adding a file task', async () => {
  const f = fixture({ resolveYouTube: async () => ({ title: 'Video', variants: [{
    url: 'https://cdn.example.com/video.mp4', audioUrl: 'https://cdn.example.com/audio.m4a',
    height: 1080, container: 'mp4', youtube: { videoFormatId: '137', audioFormatId: '140' }
  }] }) })
  await f.call('tasks:add', { url: 'https://www.youtube.com/watch?v=abcdef12345' })
  strictEqual(f.tasks[0].url, 'https://cdn.example.com/video.mp4')
  strictEqual(f.tasks[0].youtube?.videoFormatId, '137')
  strictEqual(f.tasks[0].audioUrl, 'https://cdn.example.com/audio.m4a')
})

it('requires the playlist dialog instead of adding playlist HTML', async () => {
  const f = fixture()
  await rejects(f.call('tasks:add', { url: 'https://www.youtube.com/playlist?list=PLabcdef' }), /playlist dialog/)
  strictEqual(f.tasks.length, 0)
})

it('rejects torrent rename before applying another metadata edit', async () => {
  const f = fixture()
  const task = createTask({ url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', kind: 'torrent', dir: 'C:\\Downloads', filename: 'original', description: 'Original' })
  f.tasks.push(task)
  await rejects(f.call('tasks:update', task.id, { filename: 'changed', description: 'Changed' }), /cannot be renamed/)
  strictEqual(task.filename, 'original')
  strictEqual(task.description, 'Original')
})

it('treats an unchanged filename as metadata-only for active and completed tasks', async () => {
  for (const status of ['downloading', 'paused', 'done'] as const) {
    const f = fixture()
    const task = createTask({ url: 'https://example.com/file.mp4', dir: 'C:\\Downloads', filename: 'file.mp4' })
    task.status = status
    f.tasks.push(task)
    await f.call('tasks:update', task.id, { filename: 'file.mp4', description: 'Changed' })
    strictEqual(task.filename, 'file.mp4')
    strictEqual(task.status, status)
    strictEqual(task.description, 'Changed')
  }
})

it('rejects active renames without applying their description patch', async () => {
  const f = fixture()
  const task = createTask({ url: 'https://example.com/file.mp4', dir: 'C:\\Downloads', filename: 'file.mp4', description: 'Original' })
  task.status = 'downloading'
  f.tasks.push(task)
  await rejects(f.call('tasks:update', task.id, { filename: 'changed.mp4', description: 'Changed' }), /Pause the download/)
  strictEqual(task.description, 'Original')
})
