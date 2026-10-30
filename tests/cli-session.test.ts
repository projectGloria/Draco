import { deepStrictEqual, equal, ok } from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseArgs } from '../src/cli/args.ts'
import { createSession, isFinishing, transferOf, type Engine, type QueueItem, type Reporter, type Resolved } from '../src/cli/session.ts'
import type { ManagerOptions } from '../src/main/engine/manager.ts'
import { MUX_DETAIL } from '../src/main/hls/mux.ts'
import type { DownloadTask, MediaVariant, YouTubeResolution } from '../src/shared/types.ts'

/**
 * The session decides when the next item starts; the engine only runs what it
 * is handed. A fake engine makes "what was handed over, and when" observable.
 */
function fakeEngine() {
  const tasks = new Map<string, DownloadTask>()
  let options!: ManagerOptions
  const emit = (): void => options.onTasks([...tasks.values()])
  const engine: Engine = {
    add(task) { task.status = 'queued'; tasks.set(task.id, task); emit(); return task },
    async pause(ids) { for (const id of ids) tasks.get(id)!.status = 'paused'; emit() },
    start(ids) { for (const id of ids) tasks.get(id)!.status = 'queued'; emit() },
    async shutdown() {}
  }
  return {
    factory: (o: ManagerOptions): Engine => { options = o; return engine },
    names: () => [...tasks.values()].map(t => t.filename),
    set(name: string, status: DownloadTask['status'], detail: string | null = null) {
      const task = [...tasks.values()].find(t => t.filename === name)!
      task.status = status
      task.detail = detail
      emit()
    }
  }
}

function silent() {
  const lines: string[] = []
  let queue: QueueItem[] = []
  const reporter: Reporter = {
    set() {}, info: line => { lines.push(line) }, error: line => { lines.push(`ERROR ${line}`) },
    saved: (_path, line) => { lines.push(line) }, progress() {}, clear() {}, queue: items => { queue = items }
  }
  return Object.assign(reporter, { lines, queued: () => queue })
}

const tick = (): Promise<void> => new Promise(done => setTimeout(done, 5))

const video = (title: string): YouTubeResolution => ({
  id: title, title, uploader: null, uploadDate: null,
  variants: [{ url: `https://cdn.example/${title}.mp4`, height: 720, label: '720p', bandwidth: 1, codecs: null, estimatedSize: null, container: 'mp4' } as MediaVariant]
}) as unknown as YouTubeResolution

describe('download session', () => {
  it('starts the next item the moment the current one starts merging, not when it finishes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-session-'))
    const engine = fakeEngine()
    const session = createSession({
      options: parseArgs(['--ignore-config', 'https://x.example/']), dir, reporter: silent(), lanes: 1, engine: engine.factory,
      lookups: { input: async (input): Promise<Resolved> => ({ type: 'direct', url: input }) }
    })
    try {
      await session.submit('https://files.example/a.bin')
      await session.submit('https://files.example/b.bin')
      deepStrictEqual(engine.names(), ['a.bin'])
      equal(session.counts().waiting, 1)
      engine.set('a.bin', 'downloading')
      deepStrictEqual(engine.names(), ['a.bin'])
      engine.set('a.bin', 'downloading', MUX_DETAIL)
      deepStrictEqual(engine.names(), ['a.bin', 'b.bin'])
      equal(session.counts().finishing, 1)
      engine.set('a.bin', 'done'); engine.set('b.bin', 'done')
      await session.idle()
    } finally { await session.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it('plays a playlist in order, looking entries up just in time and one ahead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-session-'))
    const engine = fakeEngine()
    const looked: string[] = []
    const reporter = silent()
    const session = createSession({
      // Two lanes, yet a playlist still runs one entry at a time.
      options: parseArgs(['--ignore-config', 'https://x.example/']), dir, reporter, lanes: 2, engine: engine.factory,
      lookups: {
        input: async (): Promise<Resolved> => ({ type: 'playlist', pageUrl: 'https://yt.example/list', title: 'Mix',
          entries: ['one', 'two', 'gone', 'four', 'five'].map(t => ({ url: `https://yt.example/${t}`, title: t })) }),
        video: async (url) => {
          const title = url.split('/').pop()!
          looked.push(title)
          if (title === 'gone') throw new Error('Video unavailable')
          return video(title) as never
        }
      }
    })
    try {
      await session.submit('https://yt.example/list')
      await tick()
      // The first entry is downloading and the second is already looked up - nothing more.
      deepStrictEqual(engine.names(), ['1 - one.mp4'])
      deepStrictEqual(looked, ['one', 'two'])
      engine.set('1 - one.mp4', 'downloading', MUX_DETAIL)
      await tick()
      deepStrictEqual(engine.names(), ['1 - one.mp4', '2 - two.mp4'])
      // "gone" failed its lookup, so the one-ahead slot moved on to "four".
      deepStrictEqual(looked, ['one', 'two', 'gone', 'four'])
      // A failed entry is skipped and the next one takes its turn.
      engine.set('2 - two.mp4', 'done')
      await tick()
      deepStrictEqual(engine.names(), ['1 - one.mp4', '2 - two.mp4', '4 - four.mp4'])
      ok(reporter.lines.some(line => line.includes('Skipped gone')), reporter.lines.join('\n'))
      equal(session.failures, 1)
      engine.set('1 - one.mp4', 'done'); engine.set('4 - four.mp4', 'done')
      await tick()
      engine.set('5 - five.mp4', 'done')
      await session.idle()
      deepStrictEqual(looked, ['one', 'two', 'gone', 'four', 'five'])
    } finally { await session.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it('holds the queue while paused and drops removed items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-session-'))
    const engine = fakeEngine()
    const reporter = silent()
    const session = createSession({
      options: parseArgs(['--ignore-config', 'https://x.example/']), dir, reporter, lanes: 1, engine: engine.factory,
      lookups: { input: async (input): Promise<Resolved> => ({ type: 'direct', url: input }) }
    })
    try {
      for (const name of ['a', 'b', 'c']) await session.submit(`https://files.example/${name}.bin`)
      engine.set('a.bin', 'downloading')
      equal(await session.pause(), 1)
      engine.set('a.bin', 'paused')
      deepStrictEqual(reporter.queued().map(item => item.title), ['b.bin', 'c.bin'])
      ok(session.remove(reporter.queued()[0].id))
      ok(!session.remove('nope'))
      deepStrictEqual(engine.names(), ['a.bin'])
      ok(session.resume())
      deepStrictEqual(engine.names(), ['a.bin'])
      engine.set('a.bin', 'done')
      deepStrictEqual(engine.names(), ['a.bin', 'c.bin'])
    } finally { await session.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it('treats muxing as finishing work and draws it that way', () => {
    const task = { id: 't', filename: 'x.mp4', status: 'downloading', detail: MUX_DETAIL, audioUrl: 'a' } as unknown as DownloadTask
    ok(isFinishing(task))
    equal(transferOf(task).phase, 'finishing')
    equal(transferOf(task).step, 'Merging video and audio')
    ok(!isFinishing({ ...task, detail: null }))
  })
})
