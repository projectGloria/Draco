import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'node:test'
import { readJson, readJsonOrThrowIfPresent, writeJsonAtomic } from '../src/main/json-file.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('commits concurrent saves to one file in call order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'draco-json-'))
  roots.push(root)
  const path = join(root, 'settings.json')
  const writes = Array.from({ length: 30 }, (_, revision) => writeJsonAtomic(path, { revision }))
  await Promise.all(writes)
  deepStrictEqual(await readJson(path), { revision: 29 })
  deepStrictEqual((await readdir(root)).sort(), ['settings.json', 'settings.json.bak'])
})

it('captures a snapshot before awaiting earlier writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'draco-json-'))
  roots.push(root)
  const path = join(root, 'tasks.json')
  const value = { task: { received: 100 } }
  const write = writeJsonAtomic(path, value)
  value.task.received = 200
  await write
  deepStrictEqual(await readJson(path), { task: { received: 100 } })
})

it('reports a failed write and allows a later save to recover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'draco-json-'))
  roots.push(root)
  const path = join(root, 'state.json')
  await rejects(writeJsonAtomic(path, undefined))
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  await rejects(writeJsonAtomic(path, cyclic))
  await mkdir(path)
  await rejects(writeJsonAtomic(path, { blocked: true }))
  await rm(path, { recursive: true })
  await writeJsonAtomic(path, { healthy: true })
  strictEqual((await readJson<{ healthy: boolean }>(path))?.healthy, true)
})

it('recovers the last backed-up state when the primary JSON is corrupt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'draco-json-'))
  roots.push(root)
  const path = join(root, 'tasks.json')
  await writeJsonAtomic(path, { revision: 1 })
  await writeJsonAtomic(path, { revision: 2 })
  await writeFile(path, '{not valid json')
  deepStrictEqual(await readJson(path), { revision: 1 })
  await writeJsonAtomic(path, { revision: 3 })
  deepStrictEqual(await readJson(path), { revision: 3 })
})

it('reports corruption when neither primary nor backup can be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'draco-json-'))
  roots.push(root)
  const path = join(root, 'tasks.json')
  await writeFile(path, '{broken')
  await rejects(readJsonOrThrowIfPresent(path), /Could not read saved state/)
  strictEqual(await readJsonOrThrowIfPresent(join(root, 'new.json')), null)
})
