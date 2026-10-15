import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, it } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { sanitizeTasks } from '../src/main/store-sanitize.ts'
import { intermediatePathsFor, migrateLegacyIntermediates, partPathFor } from '../src/main/engine/workspace.ts'

const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('adopts a uniquely owned legacy part and journal and remains idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-workspace-'))
  cleanups.push(dir)
  const task = createTask({ url: 'https://example.test/clip.mp4', dir, filename: 'clip.mp4' })
  const legacy = join(dir, 'clip.mp4.dracodl')
  const bytes = Buffer.from('old partial bytes')
  await writeFile(legacy, bytes)
  await writeFile(legacy + '.json', JSON.stringify({ url: task.url }))

  deepStrictEqual([...await migrateLegacyIntermediates([task])], [])
  const current = partPathFor(dir, task.filename, task.id)
  deepStrictEqual(await readFile(current), bytes)
  strictEqual(JSON.parse(await readFile(current + '.json', 'utf8')).url, task.url)
  strictEqual(await stat(legacy).catch(() => null), null)
  deepStrictEqual([...await migrateLegacyIntermediates([task])], [])
})

it('preserves a legacy partial claimed by two tasks and isolates their new workspaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-workspace-'))
  cleanups.push(dir)
  const first = createTask({ url: 'https://example.test/a', dir, filename: 'same.mp4' })
  const second = createTask({ url: 'https://example.test/b', dir, filename: 'same.mp4' })
  const legacy = join(dir, 'same.mp4.dracodl')
  await writeFile(legacy, 'unknown owner')

  const ambiguous = await migrateLegacyIntermediates([first, second])
  ok(ambiguous.has(first.id))
  ok(ambiguous.has(second.id))
  strictEqual(await readFile(legacy, 'utf8'), 'unknown owner')

  const firstPath = partPathFor(dir, first.filename, first.id)
  const secondPath = partPathFor(dir, second.filename, second.id)
  await mkdir(dirname(firstPath), { recursive: true })
  await mkdir(dirname(secondPath), { recursive: true })
  await writeFile(firstPath, 'first')
  await writeFile(secondPath, 'second')
  for (const owned of intermediatePathsFor(first).dirs) await rm(owned, { recursive: true, force: true })
  strictEqual(await readFile(secondPath, 'utf8'), 'second')
  strictEqual(await readFile(legacy, 'utf8'), 'unknown owner')
})

it('rejects a legacy journal for a different source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-workspace-'))
  cleanups.push(dir)
  const task = createTask({ url: 'https://example.test/current', dir, filename: 'clip.mp4' })
  const legacy = join(dir, 'clip.mp4.dracodl')
  await writeFile(legacy, 'previous source')
  await writeFile(legacy + '.json', JSON.stringify({ url: 'https://example.test/other' }))
  ok((await migrateLegacyIntermediates([task])).has(task.id))
  strictEqual(await readFile(legacy, 'utf8'), 'previous source')
  strictEqual(await stat(partPathFor(dir, task.filename, task.id)).catch(() => null), null)
})

it('migrates separate video and audio journals into their child workspaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-workspace-'))
  cleanups.push(dir)
  const task = createTask({
    url: 'https://example.test/video', audioUrl: 'https://example.test/audio', dir, filename: 'movie.mp4'
  })
  const video = join(dir, 'movie.mp4.v.mp4.dracodl')
  const audio = join(dir, 'movie.mp4.a.m4a.dracodl')
  await writeFile(video, 'video bytes')
  await writeFile(audio, 'audio bytes')
  await writeFile(video + '.json', JSON.stringify({ url: task.url }))
  await writeFile(audio + '.json', JSON.stringify({ url: task.audioUrl }))

  deepStrictEqual([...await migrateLegacyIntermediates([task])], [])
  strictEqual(await readFile(partPathFor(dir, 'movie.mp4.v.mp4', task.id + '-v'), 'utf8'), 'video bytes')
  strictEqual(await readFile(partPathFor(dir, 'movie.mp4.a.m4a', task.id + '-a'), 'utf8'), 'audio bytes')
})

it('keeps an existing destination fixed when restoring a task from an older version', () => {
  const task = createTask({ url: 'https://example.test/file', dir: 'C:\\Chosen', filename: 'file.bin' })
  strictEqual(task.dirLocked, false)
  const stored = { ...task, dirLocked: undefined }
  const [restored] = sanitizeTasks([stored], 'C:\\Default')
  strictEqual(restored.dirLocked, true)
  strictEqual(restored.dir, 'C:\\Chosen')
})
